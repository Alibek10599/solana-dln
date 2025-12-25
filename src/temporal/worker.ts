/**
 * Temporal Worker
 * 
 * The worker runs workflows and activities.
 * It connects to the Temporal server and polls for tasks.
 * 
 * Usage:
 *   npm run temporal:worker
 *   
 * Start Temporal server first:
 *   temporal server start-dev
 */

import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities.js';
import { logger } from '../utils/logger.js';

async function run() {
  logger.info('Starting Temporal worker...');

  // Connect to Temporal server
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  });

  try {
    // Create worker
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE || 'default',
      taskQueue: 'dln-collector',
      workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
      activities,
      // Worker options
      maxConcurrentActivityTaskExecutions: 5,
      maxConcurrentWorkflowTaskExecutions: 5,
    });

    logger.info({
      taskQueue: 'dln-collector',
      namespace: process.env.TEMPORAL_NAMESPACE || 'default',
      address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
    }, 'Worker created, starting...');

    // Run worker until shutdown signal
    await worker.run();

  } finally {
    await connection.close();
  }
}

// Handle shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  process.exit(0);
});

run().catch((err) => {
  logger.error({ error: err }, 'Worker failed');
  process.exit(1);
});
