/**
 * Temporal Workflows for DLN Order Collection
 * 
 * Workflows are the durable, orchestrating functions.
 * They coordinate activities and maintain state that survives crashes.
 * 
 * Key principles:
 * - Workflows must be deterministic (no I/O, random, or time)
 * - All external interactions go through activities
 * - State is automatically persisted by Temporal
 */

import { 
  proxyActivities, 
  sleep, 
  continueAsNew,
  defineQuery,
  defineSignal,
  setHandler,
  condition,
} from '@temporalio/workflow';
import type * as activities from './activities.js';

// Activity proxies with retry policies
const { initializeDatabase, getProgress, getOrderCounts } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
  },
});

const { fetchSignaturesBatch } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '2 seconds',
    maximumInterval: '30 seconds',
    backoffCoefficient: 2,
    maximumAttempts: 10,
    nonRetryableErrorTypes: ['InvalidProgramId'],
  },
});

const { fetchAndParseTransactions } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '1 minute',
  retry: {
    initialInterval: '3 seconds',
    maximumInterval: '60 seconds',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

const { storeEvents } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

/**
 * Workflow input parameters
 */
export interface CollectOrdersInput {
  programId: string;
  eventType: 'created' | 'fulfilled';
  targetCount: number;
  signaturesBatchSize?: number;
  txBatchSize?: number;
  batchDelayMs?: number;
}

/**
 * Workflow state (queryable)
 */
export interface CollectionState {
  status: 'initializing' | 'collecting' | 'completed' | 'paused' | 'error';
  totalCollected: number;
  targetCount: number;
  signaturesProcessed: number;
  eventsInserted: number;
  duplicatesSkipped: number;
  lastSignature: string | null;
  startedAt: string;
  lastUpdateAt: string;
  errorMessage?: string;
}

// Define queries and signals
export const getCollectionState = defineQuery<CollectionState>('getCollectionState');
export const pauseCollection = defineSignal('pauseCollection');
export const resumeCollection = defineSignal('resumeCollection');

/**
 * Main workflow: Collect orders for a specific program/event type
 * 
 * Features:
 * - Automatic retry of failed activities
 * - Progress checkpointing (survives crashes)
 * - Queryable state
 * - Pause/resume via signals
 * - ContinueAsNew for long-running collections
 */
export async function collectOrdersWorkflow(
  input: CollectOrdersInput
): Promise<CollectionState> {
  const {
    programId,
    eventType,
    targetCount,
    signaturesBatchSize = 1000,
    txBatchSize = 20,
    batchDelayMs = 500,
  } = input;

  // Initialize state
  let state: CollectionState = {
    status: 'initializing',
    totalCollected: 0,
    targetCount,
    signaturesProcessed: 0,
    eventsInserted: 0,
    duplicatesSkipped: 0,
    lastSignature: null,
    startedAt: new Date().toISOString(),
    lastUpdateAt: new Date().toISOString(),
  };

  let isPaused = false;

  // Set up query handler
  setHandler(getCollectionState, () => state);

  // Set up signal handlers
  setHandler(pauseCollection, () => {
    isPaused = true;
    state.status = 'paused';
    state.lastUpdateAt = new Date().toISOString();
  });

  setHandler(resumeCollection, () => {
    isPaused = false;
    state.status = 'collecting';
    state.lastUpdateAt = new Date().toISOString();
  });

  try {
    // Get current progress from database
    const progress = await getProgress(programId, eventType);
    state.totalCollected = progress.totalCollected;
    state.lastSignature = progress.lastSignature;

    // Check if already complete
    if (state.totalCollected >= targetCount) {
      state.status = 'completed';
      return state;
    }

    state.status = 'collecting';
    state.lastUpdateAt = new Date().toISOString();

    let iterationCount = 0;
    const MAX_ITERATIONS_BEFORE_CONTINUE_AS_NEW = 100;

    // Main collection loop
    while (state.totalCollected < targetCount) {
      // Check for pause signal
      if (isPaused) {
        await condition(() => !isPaused, '1 hour');
        continue;
      }

      // ContinueAsNew to avoid history limit
      if (iterationCount >= MAX_ITERATIONS_BEFORE_CONTINUE_AS_NEW) {
        // Continue as new workflow with current state
        await continueAsNew<typeof collectOrdersWorkflow>({
          ...input,
          // Progress is in the database, will be loaded on restart
        });
      }

      // 1. Fetch signatures batch
      const sigResult = await fetchSignaturesBatch({
        programId,
        before: state.lastSignature || undefined,
        limit: signaturesBatchSize,
      });

      if (sigResult.signatures.length === 0) {
        // No more signatures
        state.status = 'completed';
        break;
      }

      // Filter valid signatures (no errors)
      const validSigs = sigResult.signatures.filter(s => !s.err);
      state.signaturesProcessed += validSigs.length;

      // 2. Process in transaction batches
      for (let i = 0; i < validSigs.length; i += txBatchSize) {
        // Check for pause
        if (isPaused) break;

        const batch = validSigs.slice(i, i + txBatchSize);
        const signatures = batch.map(s => s.signature);

        // Fetch and parse transactions
        const parseResult = await fetchAndParseTransactions({
          signatures,
          eventType,
        });

        // Store events
        const storeResult = await storeEvents({
          events: parseResult.events,
          programId,
          eventType,
          lastSignature: batch[batch.length - 1].signature,
        });

        // Update state
        state.eventsInserted += storeResult.insertedCount;
        state.duplicatesSkipped += storeResult.duplicateCount;
        state.totalCollected = storeResult.totalCollected;
        state.lastSignature = batch[batch.length - 1].signature;
        state.lastUpdateAt = new Date().toISOString();

        // Check if target reached
        if (state.totalCollected >= targetCount) {
          state.status = 'completed';
          break;
        }

        // Rate limiting delay
        await sleep(batchDelayMs);
      }

      if (state.status === 'completed') break;

      // Delay between signature batches
      await sleep(batchDelayMs);
      iterationCount++;
    }

    state.status = 'completed';
    return state;

  } catch (error) {
    state.status = 'error';
    state.errorMessage = error instanceof Error ? error.message : String(error);
    state.lastUpdateAt = new Date().toISOString();
    throw error;
  }
}

/**
 * Parent workflow: Orchestrate collection of both order types
 * 
 * This workflow coordinates the collection of both OrderCreated
 * and OrderFulfilled events, either in parallel or sequence.
 */
export interface CollectAllOrdersInput {
  targetCreated: number;
  targetFulfilled: number;
  parallel?: boolean;
  signaturesBatchSize?: number;
  txBatchSize?: number;
  batchDelayMs?: number;
}

export interface CollectAllOrdersState {
  status: 'running' | 'completed' | 'error';
  created: CollectionState | null;
  fulfilled: CollectionState | null;
  startedAt: string;
  completedAt?: string;
}

export const getAllOrdersState = defineQuery<CollectAllOrdersState>('getAllOrdersState');

export async function collectAllOrdersWorkflow(
  input: CollectAllOrdersInput
): Promise<CollectAllOrdersState> {
  const {
    targetCreated,
    targetFulfilled,
    parallel = false,
    signaturesBatchSize = 1000,
    txBatchSize = 20,
    batchDelayMs = 500,
  } = input;

  // DLN program addresses
  const DLN_SOURCE = 'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4';
  const DLN_DESTINATION = 'dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo';

  let state: CollectAllOrdersState = {
    status: 'running',
    created: null,
    fulfilled: null,
    startedAt: new Date().toISOString(),
  };

  setHandler(getAllOrdersState, () => state);

  try {
    // Initialize database first
    await initializeDatabase();

    const commonOptions = {
      signaturesBatchSize,
      txBatchSize,
      batchDelayMs,
    };

    if (parallel) {
      // Collect both in parallel (faster but uses more RPC quota)
      // Note: This would typically use child workflows, but for simplicity
      // we'll run sequentially. For true parallelism, use child workflows
      // or separate worker processes.
      
      // For now, run sequentially even if parallel requested
      // True parallel would need child workflow implementation
    }

    // Collect OrderCreated
    state.created = await collectOrdersWorkflow({
      programId: DLN_SOURCE,
      eventType: 'created',
      targetCount: targetCreated,
      ...commonOptions,
    });

    // Collect OrderFulfilled  
    state.fulfilled = await collectOrdersWorkflow({
      programId: DLN_DESTINATION,
      eventType: 'fulfilled',
      targetCount: targetFulfilled,
      ...commonOptions,
    });

    state.status = 'completed';
    state.completedAt = new Date().toISOString();

    return state;

  } catch (error) {
    state.status = 'error';
    throw error;
  }
}
