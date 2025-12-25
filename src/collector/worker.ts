/**
 * Temporal Worker for DLN Order Collection
 * 
 * The worker executes activities and runs workflows.
 * Start this before running the client to start workflows.
 * 
 * Usage:
 *   npm run temporal:worker
 */

import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities.js';
import { initializeSchema, closeClickHouse } from '../db/clickhouse.js';
import { logger } from '../utils/logger.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'dln-collector';

async function run(): Promise<void> {
  logger.info('═'.repeat(60));
  logger.info('DLN Temporal Worker Starting');
  logger.info('═'.repeat(60));
  
  // Initialize database
  logger.info('Initializing ClickHouse...');
  await initializeSchema();
  
  // Connect to Temporal
  logger.info({ address: TEMPORAL_ADDRESS }, 'Connecting to Temporal...');
  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });
  
  // Create worker
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
    activities,
    // Worker configuration
    maxConcurrentActivityTaskExecutions: 10,
    maxConcurrentWorkflowTaskExecutions: 5,
  });
  
  logger.info({ taskQueue: TASK_QUEUE }, 'Worker created, starting...');
  
  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await worker.shutdown();
    await closeClickHouse();
    await connection.close();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  // Start the worker
  await worker.run();
}

run().catch((err) => {
  logger.error({ error: err }, 'Worker failed');
  process.exit(1);
});
