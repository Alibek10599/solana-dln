/**
 * Temporal Client for Starting DLN Collection Workflows
 * 
 * Use this to start, query, and manage collection workflows.
 * 
 * Usage:
 *   npm run temporal:start
 *   npm run temporal:status
 */

import 'dotenv/config';
import { Client, Connection } from '@temporalio/client';
import { 
  collectAllOrdersWorkflow, 
  collectOrdersWorkflow,
  getProgressQuery,
  pauseSignal,
} from './workflows.js';
import { logger } from '../utils/logger.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'dln-collector';

async function getClient(): Promise<Client> {
  const connection = await Connection.connect({
    address: TEMPORAL_ADDRESS,
  });
  return new Client({ connection });
}

// ============================================================
// Start Collection
// ============================================================

async function startCollection(): Promise<void> {
  const client = await getClient();
  
  const targetCreated = parseInt(process.env.TARGET_CREATED_ORDERS || '25000');
  const targetFulfilled = parseInt(process.env.TARGET_FULFILLED_ORDERS || '25000');
  const signaturesBatchSize = parseInt(process.env.SIGNATURES_BATCH_SIZE || '1000');
  const txBatchSize = parseInt(process.env.TX_BATCH_SIZE || '20');
  const batchDelayMs = parseInt(process.env.BATCH_DELAY_MS || '500');
  
  logger.info({
    targetCreated,
    targetFulfilled,
    signaturesBatchSize,
    txBatchSize,
    batchDelayMs,
  }, 'Starting collection workflow');
  
  const handle = await client.workflow.start(collectAllOrdersWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: 'dln-collect-all-orders',
    args: [{
      targetCreated,
      targetFulfilled,
      signaturesBatchSize,
      txBatchSize,
      batchDelayMs,
    }],
  });
  
  logger.info({
    workflowId: handle.workflowId,
    runId: handle.firstExecutionRunId,
  }, 'Workflow started');
  
  console.log(`
═══════════════════════════════════════════════════════════════
  DLN Collection Workflow Started!
═══════════════════════════════════════════════════════════════

  Workflow ID: ${handle.workflowId}
  Run ID:      ${handle.firstExecutionRunId}

  Monitor at:  http://localhost:8233/namespaces/default/workflows/${handle.workflowId}

  Commands:
    Check status:  npm run temporal:status
    Pause:         npm run temporal:pause
    Resume:        npm run temporal:resume
    Cancel:        npm run temporal:cancel

═══════════════════════════════════════════════════════════════
`);
}

// ============================================================
// Get Status
// ============================================================

async function getStatus(): Promise<void> {
  const client = await getClient();
  
  const handle = client.workflow.getHandle('dln-collect-all-orders');
  
  try {
    const description = await handle.describe();
    
    console.log(`
═══════════════════════════════════════════════════════════════
  DLN Collection Workflow Status
═══════════════════════════════════════════════════════════════

  Status:      ${description.status.name}
  Started:     ${description.startTime?.toISOString()}
  
  Type:        ${description.type}
  Task Queue:  ${description.taskQueue}
`);
    
    if (description.status.name === 'COMPLETED') {
      const result = await handle.result();
      console.log('  Result:', JSON.stringify(result, null, 2));
    }
    
  } catch (error: any) {
    if (error.message?.includes('not found')) {
      console.log('No active workflow found. Start one with: npm run temporal:start');
    } else {
      throw error;
    }
  }
}

// ============================================================
// Pause/Resume
// ============================================================

async function pauseWorkflow(): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle('dln-collect-all-orders');
  
  await handle.signal(pauseSignal, true);
  logger.info('Workflow paused');
}

async function resumeWorkflow(): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle('dln-collect-all-orders');
  
  await handle.signal(pauseSignal, false);
  logger.info('Workflow resumed');
}

// ============================================================
// Cancel
// ============================================================

async function cancelWorkflow(): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle('dln-collect-all-orders');
  
  await handle.cancel();
  logger.info('Workflow cancelled');
}

// ============================================================
// CLI
// ============================================================

const command = process.argv[2];

switch (command) {
  case 'start':
    startCollection().catch(console.error);
    break;
  case 'status':
    getStatus().catch(console.error);
    break;
  case 'pause':
    pauseWorkflow().catch(console.error);
    break;
  case 'resume':
    resumeWorkflow().catch(console.error);
    break;
  case 'cancel':
    cancelWorkflow().catch(console.error);
    break;
  default:
    console.log(`
Usage: npx tsx src/collector/client.ts <command>

Commands:
  start   - Start the collection workflow
  status  - Check workflow status
  pause   - Pause the running workflow
  resume  - Resume a paused workflow
  cancel  - Cancel the workflow
`);
}
