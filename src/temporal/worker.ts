/**
 * Temporal Worker Configuration
 * 
 * This module defines the worker configuration for different task queues:
 * - dln-collector: Main workflow task queue
 * - dln-rpc: RPC activities (rate limited)
 * - dln-db: Database activities (high throughput)
 * 
 * You can run workers in different modes:
 * - Full: Handles all queues (default, good for development)
 * - RPC-only: Only handles RPC activities
 * - DB-only: Only handles database activities
 */

import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// Configuration
// =============================================================================

interface WorkerConfig {
  // Connection
  temporalAddress: string;
  namespace: string;
  
  // Task queues to handle
  taskQueues: {
    main: string;      // Workflow queue
    rpc: string;       // RPC activities
    db: string;        // DB activities
  };
  
  // Concurrency limits
  maxConcurrentWorkflowTasks: number;
  maxConcurrentActivities: number;
  
  // Rate limiting for RPC activities
  maxActivitiesPerSecond: number;
}

function getConfig(): WorkerConfig {
  return {
    temporalAddress: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    
    taskQueues: {
      main: process.env.TEMPORAL_TASK_QUEUE || 'dln-collector',
      rpc: process.env.TEMPORAL_RPC_QUEUE || 'dln-rpc',
      db: process.env.TEMPORAL_DB_QUEUE || 'dln-db',
    },
    
    maxConcurrentWorkflowTasks: parseInt(process.env.WORKER_MAX_WORKFLOW_TASKS || '10'),
    maxConcurrentActivities: parseInt(process.env.WORKER_MAX_ACTIVITIES || '5'),
    maxActivitiesPerSecond: parseFloat(process.env.WORKER_ACTIVITIES_PER_SECOND || '10'),
  };
}

// =============================================================================
// Worker Types
// =============================================================================

type WorkerMode = 'full' | 'rpc' | 'db' | 'workflow';

function getWorkerMode(): WorkerMode {
  const mode = process.env.WORKER_MODE?.toLowerCase();
  if (mode === 'rpc' || mode === 'db' || mode === 'workflow') {
    return mode;
  }
  return 'full';
}

// =============================================================================
// Worker Creation
// =============================================================================

async function createMainWorker(
  connection: NativeConnection,
  config: WorkerConfig
): Promise<Worker> {
  return Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueues.main,
    workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
    // Main queue also handles activities for simplicity
    activities,
    maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflowTasks,
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivities,
  });
}

async function createRpcWorker(
  connection: NativeConnection,
  config: WorkerConfig
): Promise<Worker> {
  return Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueues.rpc,
    activities: {
      // Only RPC-related activities
      fetchSignaturesBatch: activities.fetchSignaturesBatch,
      fetchAndParseTransactions: activities.fetchAndParseTransactions,
      checkRpcHealth: activities.checkRpcHealth,
    },
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivities,
    // Rate limiting for RPC activities
    maxTaskQueueActivitiesPerSecond: config.maxActivitiesPerSecond,
  });
}

async function createDbWorker(
  connection: NativeConnection,
  config: WorkerConfig
): Promise<Worker> {
  return Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueues.db,
    activities: {
      // Only DB-related activities
      initializeDatabase: activities.initializeDatabase,
      getProgress: activities.getProgress,
      storeEvents: activities.storeEvents,
      getOrderCounts: activities.getOrderCounts,
    },
    // Higher concurrency for DB operations
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivities * 2,
  });
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function run() {
  const config = getConfig();
  const mode = getWorkerMode();
  
  logger.info({
    mode,
    address: config.temporalAddress,
    namespace: config.namespace,
    taskQueues: config.taskQueues,
  }, 'Starting Temporal worker');

  // Connect to Temporal server
  const connection = await NativeConnection.connect({
    address: config.temporalAddress,
  });

  const workers: Worker[] = [];

  try {
    switch (mode) {
      case 'full':
        // Create all workers
        logger.info('Creating full worker (all queues)');
        workers.push(
          await createMainWorker(connection, config),
          await createRpcWorker(connection, config),
          await createDbWorker(connection, config)
        );
        break;
        
      case 'workflow':
        // Only workflow task queue
        logger.info('Creating workflow-only worker');
        workers.push(await createMainWorker(connection, config));
        break;
        
      case 'rpc':
        // Only RPC activities
        logger.info('Creating RPC-only worker');
        workers.push(await createRpcWorker(connection, config));
        break;
        
      case 'db':
        // Only DB activities
        logger.info('Creating DB-only worker');
        workers.push(await createDbWorker(connection, config));
        break;
    }

    logger.info({
      workerCount: workers.length,
      queues: workers.map(w => w.options.taskQueue),
    }, 'Workers created, starting...');

    // Run all workers concurrently
    await Promise.all(workers.map(w => w.run()));

  } finally {
    // Cleanup
    await activities.cleanup();
    await connection.close();
    logger.info('Worker shutdown complete');
  }
}

// =============================================================================
// Shutdown Handling
// =============================================================================

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info({ signal }, 'Received shutdown signal');
  
  // Cleanup will happen in finally block
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
  process.exit(1);
});

// Run
run().catch((err) => {
  logger.error({ error: err }, 'Worker failed');
  process.exit(1);
});
