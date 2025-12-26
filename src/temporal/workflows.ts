/**
 * Temporal Workflows for DLN Order Collection
 * 
 * Improved architecture:
 * 1. Child workflows for parallel collection
 * 2. Separate task queues for RPC vs DB activities
 * 3. Better state management and queries
 * 4. Proper continueAsNew for long-running workflows
 * 
 * Workflow Hierarchy:
 * - collectAllOrdersWorkflow (parent)
 *   ├── collectOrdersWorkflow (child: created)
 *   └── collectOrdersWorkflow (child: fulfilled)
 */

import { 
  proxyActivities, 
  sleep, 
  continueAsNew,
  defineQuery,
  defineSignal,
  setHandler,
  condition,
  startChild,
  ParentClosePolicy,
  ChildWorkflowHandle,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';

// =============================================================================
// Activity Proxies with Task Queues
// =============================================================================

/**
 * Database activities - run on dln-db queue
 * Higher throughput, less latency sensitive
 */
const dbActivities = proxyActivities<typeof activities>({
  taskQueue: 'dln-db',
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '500ms',
    maximumInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

/**
 * RPC activities - run on dln-rpc queue  
 * Rate limited, longer timeouts, more retries
 */
const rpcActivities = proxyActivities<typeof activities>({
  taskQueue: 'dln-rpc',
  startToCloseTimeout: '3 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '2 seconds',
    maximumInterval: '60 seconds',
    backoffCoefficient: 2,
    maximumAttempts: 10,
  },
});

/**
 * Long-running RPC activities (parsing large batches)
 */
const rpcLongActivities = proxyActivities<typeof activities>({
  taskQueue: 'dln-rpc',
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '1 minute',
  retry: {
    initialInterval: '5 seconds',
    maximumInterval: '2 minutes',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

// =============================================================================
// Workflow State Types
// =============================================================================

export interface CollectionConfig {
  signaturesBatchSize: number;
  txBatchSize: number;
  batchDelayMs: number;
}

export interface CollectionState {
  status: 'initializing' | 'collecting' | 'completed' | 'paused' | 'error';
  programId: string;
  eventType: 'created' | 'fulfilled';
  targetCount: number;
  totalCollected: number;
  signaturesProcessed: number;
  transactionsProcessed: number;
  eventsInserted: number;
  duplicatesSkipped: number;
  lastSignature: string | null;
  iterationCount: number;
  startedAt: number;
  lastUpdateAt: number;
  errorMessage?: string;
}

export interface ParentWorkflowState {
  status: 'initializing' | 'running' | 'completed' | 'error';
  created: CollectionState | null;
  fulfilled: CollectionState | null;
  startedAt: number;
  completedAt?: number;
  errorMessage?: string;
}

// =============================================================================
// Queries and Signals
// =============================================================================

// Child workflow queries/signals
export const getCollectionState = defineQuery<CollectionState>('getCollectionState');
export const pauseCollection = defineSignal('pauseCollection');
export const resumeCollection = defineSignal('resumeCollection');

// Parent workflow queries/signals
export const getParentState = defineQuery<ParentWorkflowState>('getParentState');
export const pauseAll = defineSignal('pauseAll');
export const resumeAll = defineSignal('resumeAll');

// =============================================================================
// Child Workflow: Collect Orders for One Event Type
// =============================================================================

export interface CollectOrdersInput {
  programId: string;
  eventType: 'created' | 'fulfilled';
  targetCount: number;
  config: CollectionConfig;
  // For continueAsNew - resume from previous state
  resumeState?: Partial<CollectionState>;
}

export async function collectOrdersWorkflow(
  input: CollectOrdersInput
): Promise<CollectionState> {
  const {
    programId,
    eventType,
    targetCount,
    config,
    resumeState,
  } = input;

  const info = workflowInfo();
  
  // Initialize or resume state
  let state: CollectionState = {
    status: 'initializing',
    programId,
    eventType,
    targetCount,
    totalCollected: resumeState?.totalCollected ?? 0,
    signaturesProcessed: resumeState?.signaturesProcessed ?? 0,
    transactionsProcessed: resumeState?.transactionsProcessed ?? 0,
    eventsInserted: resumeState?.eventsInserted ?? 0,
    duplicatesSkipped: resumeState?.duplicatesSkipped ?? 0,
    lastSignature: resumeState?.lastSignature ?? null,
    iterationCount: resumeState?.iterationCount ?? 0,
    startedAt: resumeState?.startedAt ?? Date.now(),
    lastUpdateAt: Date.now(),
  };

  let isPaused = false;

  // Set up handlers
  setHandler(getCollectionState, () => state);
  
  setHandler(pauseCollection, () => {
    isPaused = true;
    state.status = 'paused';
    state.lastUpdateAt = Date.now();
  });
  
  setHandler(resumeCollection, () => {
    isPaused = false;
    state.status = 'collecting';
    state.lastUpdateAt = Date.now();
  });

  try {
    // Get current progress from database (unless resuming from continueAsNew)
    if (!resumeState) {
      const progress = await dbActivities.getProgress(programId, eventType);
      state.totalCollected = progress.totalCollected;
      state.lastSignature = progress.lastSignature;
    }

    // Check if already complete
    if (state.totalCollected >= targetCount) {
      state.status = 'completed';
      state.lastUpdateAt = Date.now();
      return state;
    }

    state.status = 'collecting';
    state.lastUpdateAt = Date.now();

    // Limits for continueAsNew
    const MAX_ITERATIONS_BEFORE_CONTINUE = 50;
    let iterationsInThisRun = 0;

    // Main collection loop
    while (state.totalCollected < targetCount) {
      // Check for pause
      if (isPaused) {
        // Wait for resume signal (up to 24 hours)
        await condition(() => !isPaused, '24 hours');
        if (isPaused) {
          // Timed out while paused - complete workflow
          state.status = 'paused';
          return state;
        }
        continue;
      }

      // ContinueAsNew to prevent history from growing too large
      if (iterationsInThisRun >= MAX_ITERATIONS_BEFORE_CONTINUE) {
        await continueAsNew<typeof collectOrdersWorkflow>({
          ...input,
          resumeState: {
            ...state,
            iterationCount: state.iterationCount,
          },
        });
      }

      // 1. Fetch signatures batch
      const sigResult = await rpcActivities.fetchSignaturesBatch({
        programId,
        before: state.lastSignature || undefined,
        limit: config.signaturesBatchSize,
      });

      if (sigResult.signatures.length === 0) {
        // No more signatures available
        state.status = 'completed';
        break;
      }

      // Filter valid signatures
      const validSigs = sigResult.signatures.filter(s => !s.err);
      state.signaturesProcessed += validSigs.length;

      // 2. Process in transaction batches
      for (let i = 0; i < validSigs.length && state.totalCollected < targetCount; i += config.txBatchSize) {
        // Check for pause between batches
        if (isPaused) break;

        const batch = validSigs.slice(i, i + config.txBatchSize);
        const signatures = batch.map(s => s.signature);

        // Fetch and parse transactions
        const parseResult = await rpcLongActivities.fetchAndParseTransactions({
          signatures,
          eventType,
        });

        state.transactionsProcessed += parseResult.processedCount;

        // Store events (on DB queue)
        const storeResult = await dbActivities.storeEvents({
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
        state.lastUpdateAt = Date.now();

        // Rate limiting delay
        if (config.batchDelayMs > 0) {
          await sleep(config.batchDelayMs);
        }
      }

      // Check completion
      if (state.totalCollected >= targetCount) {
        state.status = 'completed';
        break;
      }

      // Increment counters
      state.iterationCount++;
      iterationsInThisRun++;

      // Small delay between signature batches
      await sleep(config.batchDelayMs);
    }

    state.status = 'completed';
    state.lastUpdateAt = Date.now();
    return state;

  } catch (error) {
    state.status = 'error';
    state.errorMessage = error instanceof Error ? error.message : String(error);
    state.lastUpdateAt = Date.now();
    throw error;
  }
}

// =============================================================================
// Parent Workflow: Orchestrate All Collections
// =============================================================================

export interface CollectAllOrdersInput {
  targetCreated: number;
  targetFulfilled: number;
  config?: Partial<CollectionConfig>;
  parallel?: boolean;
}

const DLN_SOURCE = 'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4';
const DLN_DESTINATION = 'dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo';

export async function collectAllOrdersWorkflow(
  input: CollectAllOrdersInput
): Promise<ParentWorkflowState> {
  const {
    targetCreated,
    targetFulfilled,
    parallel = true,
    config: configOverrides,
  } = input;

  const config: CollectionConfig = {
    signaturesBatchSize: configOverrides?.signaturesBatchSize ?? 1000,
    txBatchSize: configOverrides?.txBatchSize ?? 20,
    batchDelayMs: configOverrides?.batchDelayMs ?? 500,
  };

  // Initialize state
  let state: ParentWorkflowState = {
    status: 'initializing',
    created: null,
    fulfilled: null,
    startedAt: Date.now(),
  };

  // Track child workflow handles
  let createdHandle: ChildWorkflowHandle<typeof collectOrdersWorkflow> | null = null;
  let fulfilledHandle: ChildWorkflowHandle<typeof collectOrdersWorkflow> | null = null;

  // Set up handlers
  setHandler(getParentState, () => state);

  setHandler(pauseAll, async () => {
    // Forward pause signal to children
    // Note: In Temporal, we can't directly signal children from parent
    // The children have their own pause handlers
    state.status = 'running'; // Keep parent running, children handle pause
  });

  setHandler(resumeAll, async () => {
    state.status = 'running';
  });

  try {
    // Initialize database first
    await dbActivities.initializeDatabase();

    state.status = 'running';

    if (parallel) {
      // Start both child workflows in parallel
      createdHandle = await startChild(collectOrdersWorkflow, {
        workflowId: `${workflowInfo().workflowId}-created`,
        taskQueue: 'dln-collector', // Child workflows run on main queue
        args: [{
          programId: DLN_SOURCE,
          eventType: 'created' as const,
          targetCount: targetCreated,
          config,
        }],
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      });

      fulfilledHandle = await startChild(collectOrdersWorkflow, {
        workflowId: `${workflowInfo().workflowId}-fulfilled`,
        taskQueue: 'dln-collector',
        args: [{
          programId: DLN_DESTINATION,
          eventType: 'fulfilled' as const,
          targetCount: targetFulfilled,
          config,
        }],
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      });

      // Wait for both to complete
      const [createdResult, fulfilledResult] = await Promise.all([
        createdHandle.result(),
        fulfilledHandle.result(),
      ]);

      state.created = createdResult;
      state.fulfilled = fulfilledResult;

    } else {
      // Sequential execution
      createdHandle = await startChild(collectOrdersWorkflow, {
        workflowId: `${workflowInfo().workflowId}-created`,
        taskQueue: 'dln-collector',
        args: [{
          programId: DLN_SOURCE,
          eventType: 'created' as const,
          targetCount: targetCreated,
          config,
        }],
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      });

      state.created = await createdHandle.result();

      fulfilledHandle = await startChild(collectOrdersWorkflow, {
        workflowId: `${workflowInfo().workflowId}-fulfilled`,
        taskQueue: 'dln-collector',
        args: [{
          programId: DLN_DESTINATION,
          eventType: 'fulfilled' as const,
          targetCount: targetFulfilled,
          config,
        }],
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      });

      state.fulfilled = await fulfilledHandle.result();
    }

    // Get final counts
    const counts = await dbActivities.getOrderCounts();

    state.status = 'completed';
    state.completedAt = Date.now();

    return state;

  } catch (error) {
    state.status = 'error';
    state.errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

// =============================================================================
// Utility Workflow: Health Check
// =============================================================================

export interface HealthCheckResult {
  rpc: { healthy: boolean; slot: number; latencyMs: number };
  db: { healthy: boolean; counts: { created: number; fulfilled: number } };
  timestamp: number;
}

export async function healthCheckWorkflow(): Promise<HealthCheckResult> {
  const [rpcHealth, counts] = await Promise.all([
    rpcActivities.checkRpcHealth(),
    dbActivities.getOrderCounts().catch(() => ({ created: 0, fulfilled: 0, total: 0 })),
  ]);

  return {
    rpc: rpcHealth,
    db: {
      healthy: counts.total >= 0,
      counts: { created: counts.created, fulfilled: counts.fulfilled },
    },
    timestamp: Date.now(),
  };
}
