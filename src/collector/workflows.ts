/**
 * Temporal Workflow for DLN Order Collection
 * 
 * Workflows are deterministic - they orchestrate activities and
 * maintain durable state. If the workflow crashes, Temporal replays
 * it from the last checkpoint.
 * 
 * Key benefits:
 * - Survives crashes (Temporal persists state)
 * - Automatic retries with configurable policies
 * - Built-in rate limiting via activity queues
 * - Visibility UI to monitor progress
 * - Exactly-once semantics for activities
 */

import { 
  proxyActivities, 
  sleep, 
  continueAsNew,
  defineQuery,
  defineSignal,
  setHandler,
} from '@temporalio/workflow';

// Import activity types (NOT implementations - workflows can't import non-deterministic code)
import type * as activities from './activities.js';

// Configure activity proxies with retry policies
const { fetchSignatures, fetchAndParseTransactions, storeEvents, getProgress, updateProgress, getCount } = 
  proxyActivities<typeof activities>({
    // Retry policy for RPC activities (high retry count for rate limits)
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '2s',
      backoffCoefficient: 2,
      maximumInterval: '30s',
      maximumAttempts: 10,
      nonRetryableErrorTypes: ['InvalidProgramId', 'DatabaseConnectionError'],
    },
  });

// Separate proxy for DB activities (lower retry, faster timeout)
const dbActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '10s',
    maximumAttempts: 5,
  },
});

// ============================================================
// Workflow Input/Output Types
// ============================================================

export interface CollectOrdersInput {
  programId: string;
  eventType: 'created' | 'fulfilled';
  targetCount: number;
  signaturesBatchSize?: number;
  txBatchSize?: number;
  batchDelayMs?: number;
}

export interface CollectOrdersOutput {
  totalCollected: number;
  eventsInserted: number;
  duplicatesSkipped: number;
  signaturesProcessed: number;
  completed: boolean;
}

// Internal state for continue-as-new
interface WorkflowState {
  lastSignature?: string;
  totalCollected: number;
  eventsInserted: number;
  duplicatesSkipped: number;
  signaturesProcessed: number;
  iterationsInCurrentRun: number;
}

// ============================================================
// Queries and Signals
// ============================================================

// Query to get current progress (can be called while workflow is running)
export const getProgressQuery = defineQuery<CollectOrdersOutput>('getProgress');

// Signal to pause/resume the workflow
export const pauseSignal = defineSignal<[boolean]>('pause');

// ============================================================
// Main Workflow
// ============================================================

/**
 * Collect DLN order events from a specific program
 * 
 * This workflow:
 * 1. Resumes from last checkpoint (if any)
 * 2. Fetches signatures in batches
 * 3. Parses transactions and extracts events
 * 4. Stores events with deduplication
 * 5. Updates progress checkpoints
 * 6. Uses continueAsNew to avoid unbounded history
 * 
 * @example
 * ```ts
 * const handle = await client.workflow.start(collectOrdersWorkflow, {
 *   taskQueue: 'dln-collector',
 *   workflowId: 'collect-created-orders',
 *   args: [{
 *     programId: 'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4',
 *     eventType: 'created',
 *     targetCount: 25000,
 *   }],
 * });
 * ```
 */
export async function collectOrdersWorkflow(
  input: CollectOrdersInput,
  initialState?: WorkflowState
): Promise<CollectOrdersOutput> {
  // Configuration
  const SIGNATURES_BATCH_SIZE = input.signaturesBatchSize ?? 1000;
  const TX_BATCH_SIZE = input.txBatchSize ?? 20;
  const BATCH_DELAY_MS = input.batchDelayMs ?? 500;
  const MAX_ITERATIONS_PER_RUN = 100; // Continue-as-new after this many iterations
  
  // Initialize state (from previous run or fresh)
  let state: WorkflowState = initialState ?? {
    totalCollected: 0,
    eventsInserted: 0,
    duplicatesSkipped: 0,
    signaturesProcessed: 0,
    iterationsInCurrentRun: 0,
  };
  
  // Track if paused
  let isPaused = false;
  
  // Set up query handler
  setHandler(getProgressQuery, () => ({
    totalCollected: state.totalCollected,
    eventsInserted: state.eventsInserted,
    duplicatesSkipped: state.duplicatesSkipped,
    signaturesProcessed: state.signaturesProcessed,
    completed: state.totalCollected >= input.targetCount,
  }));
  
  // Set up pause signal handler
  setHandler(pauseSignal, (pause: boolean) => {
    isPaused = pause;
  });
  
  // Get progress from database if starting fresh
  if (!initialState) {
    const progress = await getProgress({
      programId: input.programId,
      eventType: input.eventType,
    });
    state.lastSignature = progress.lastSignature ?? undefined;
    state.totalCollected = progress.totalCollected;
  }
  
  // Check if already at target
  if (state.totalCollected >= input.targetCount) {
    return {
      totalCollected: state.totalCollected,
      eventsInserted: state.eventsInserted,
      duplicatesSkipped: state.duplicatesSkipped,
      signaturesProcessed: state.signaturesProcessed,
      completed: true,
    };
  }
  
  // Main collection loop
  let hasMore = true;
  
  while (hasMore && state.totalCollected < input.targetCount) {
    // Check if paused
    while (isPaused) {
      await sleep('5 seconds');
    }
    
    // Continue-as-new to prevent unbounded history
    state.iterationsInCurrentRun++;
    if (state.iterationsInCurrentRun >= MAX_ITERATIONS_PER_RUN) {
      await continueAsNew<typeof collectOrdersWorkflow>(input, state);
    }
    
    // Fetch signatures
    const sigResult = await fetchSignatures({
      programId: input.programId,
      before: state.lastSignature,
      limit: SIGNATURES_BATCH_SIZE,
    });
    
    if (sigResult.signatures.length === 0) {
      hasMore = false;
      break;
    }
    
    // Filter out failed transactions
    const validSigs = sigResult.signatures.filter(s => !s.err);
    
    if (validSigs.length === 0) {
      state.lastSignature = sigResult.lastSignature;
      continue;
    }
    
    // Process in transaction batches
    for (let i = 0; i < validSigs.length; i += TX_BATCH_SIZE) {
      // Check if paused
      while (isPaused) {
        await sleep('5 seconds');
      }
      
      const batch = validSigs.slice(i, i + TX_BATCH_SIZE);
      const signatures = batch.map(s => s.signature);
      
      // Fetch and parse transactions
      const txResult = await fetchAndParseTransactions({ signatures });
      
      // Filter by event type
      const relevantEvents = txResult.events.filter(e => e.event_type === input.eventType);
      
      if (relevantEvents.length > 0) {
        // Store events
        const storeResult = await storeEvents({ events: relevantEvents });
        
        state.eventsInserted += storeResult.inserted;
        state.duplicatesSkipped += storeResult.duplicates;
        state.totalCollected += storeResult.inserted;
      }
      
      state.signaturesProcessed += batch.length;
      
      // Update progress checkpoint
      const lastSig = batch[batch.length - 1].signature;
      await updateProgress({
        programId: input.programId,
        eventType: input.eventType,
        lastSignature: lastSig,
        totalCollected: state.totalCollected,
      });
      state.lastSignature = lastSig;
      
      // Check target
      if (state.totalCollected >= input.targetCount) {
        break;
      }
      
      // Rate limiting delay
      await sleep(`${BATCH_DELAY_MS} milliseconds`);
    }
    
    hasMore = sigResult.hasMore;
  }
  
  return {
    totalCollected: state.totalCollected,
    eventsInserted: state.eventsInserted,
    duplicatesSkipped: state.duplicatesSkipped,
    signaturesProcessed: state.signaturesProcessed,
    completed: state.totalCollected >= input.targetCount,
  };
}

// ============================================================
// Parent Workflow: Collect All Orders
// ============================================================

export interface CollectAllOrdersInput {
  targetCreated?: number;
  targetFulfilled?: number;
  signaturesBatchSize?: number;
  txBatchSize?: number;
  batchDelayMs?: number;
}

export interface CollectAllOrdersOutput {
  created: CollectOrdersOutput;
  fulfilled: CollectOrdersOutput;
}

/**
 * Parent workflow that orchestrates collection for both programs
 * 
 * Can run them sequentially or in parallel (parallel = faster but more RPC load)
 */
export async function collectAllOrdersWorkflow(
  input: CollectAllOrdersInput
): Promise<CollectAllOrdersOutput> {
  const DLN_SOURCE = 'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4';
  const DLN_DESTINATION = 'dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo';
  
  // Collect created orders first
  const createdResult = await collectOrdersWorkflow({
    programId: DLN_SOURCE,
    eventType: 'created',
    targetCount: input.targetCreated ?? 25000,
    signaturesBatchSize: input.signaturesBatchSize,
    txBatchSize: input.txBatchSize,
    batchDelayMs: input.batchDelayMs,
  });
  
  // Then collect fulfilled orders
  const fulfilledResult = await collectOrdersWorkflow({
    programId: DLN_DESTINATION,
    eventType: 'fulfilled',
    targetCount: input.targetFulfilled ?? 25000,
    signaturesBatchSize: input.signaturesBatchSize,
    txBatchSize: input.txBatchSize,
    batchDelayMs: input.batchDelayMs,
  });
  
  return {
    created: createdResult,
    fulfilled: fulfilledResult,
  };
}
