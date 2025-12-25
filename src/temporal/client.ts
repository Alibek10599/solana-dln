/**
 * Temporal Client - Start and manage workflows
 * 
 * This script starts the collection workflow and provides
 * commands to query state, pause/resume, etc.
 * 
 * Usage:
 *   npm run temporal:start              # Start collection
 *   npm run temporal:status             # Check status
 *   npm run temporal:pause              # Pause collection
 *   npm run temporal:resume             # Resume collection
 */

import 'dotenv/config';
import { Connection, Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { 
  collectAllOrdersWorkflow,
  collectOrdersWorkflow,
  getCollectionState,
  getAllOrdersState,
  pauseCollection,
  resumeCollection,
} from './workflows.js';
import { logger } from '../utils/logger.js';

const TASK_QUEUE = 'dln-collector';
const WORKFLOW_ID_PREFIX = 'dln-collect';

async function getClient(): Promise<Client> {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  });
  
  return new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
  });
}

/**
 * Start the main collection workflow
 */
async function startCollection() {
  const client = await getClient();
  
  const targetCreated = parseInt(process.env.TARGET_CREATED_ORDERS || '25000');
  const targetFulfilled = parseInt(process.env.TARGET_FULFILLED_ORDERS || '25000');
  const batchDelayMs = parseInt(process.env.BATCH_DELAY_MS || '500');
  const txBatchSize = parseInt(process.env.TX_BATCH_SIZE || '20');
  
  const workflowId = `${WORKFLOW_ID_PREFIX}-all-orders`;
  
  logger.info({
    workflowId,
    targetCreated,
    targetFulfilled,
    txBatchSize,
    batchDelayMs,
  }, 'Starting collection workflow...');
  
  try {
    const handle = await client.workflow.start(collectAllOrdersWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{
        targetCreated,
        targetFulfilled,
        signaturesBatchSize: 1000,
        txBatchSize,
        batchDelayMs,
      }],
      // Keep workflow history for 7 days
      workflowExecutionTimeout: '7 days',
    });
    
    logger.info({
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    }, 'Workflow started successfully!');
    
    console.log('\n📊 Monitor progress:');
    console.log(`   npm run temporal:status`);
    console.log('\n🔗 Or view in Temporal UI:');
    console.log(`   http://localhost:8233/namespaces/default/workflows/${workflowId}`);
    
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      logger.warn({ workflowId }, 'Workflow already running');
      console.log('\n⚠️  Workflow is already running. Check status:');
      console.log(`   npm run temporal:status`);
    } else {
      throw error;
    }
  }
}

/**
 * Start collection for a specific event type only
 */
async function startSingleCollection(eventType: 'created' | 'fulfilled') {
  const client = await getClient();
  
  const programId = eventType === 'created' 
    ? 'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4'
    : 'dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo';
  
  const targetKey = eventType === 'created' ? 'TARGET_CREATED_ORDERS' : 'TARGET_FULFILLED_ORDERS';
  const targetCount = parseInt(process.env[targetKey] || '25000');
  
  const workflowId = `${WORKFLOW_ID_PREFIX}-${eventType}`;
  
  try {
    const handle = await client.workflow.start(collectOrdersWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{
        programId,
        eventType,
        targetCount,
        signaturesBatchSize: 1000,
        txBatchSize: parseInt(process.env.TX_BATCH_SIZE || '20'),
        batchDelayMs: parseInt(process.env.BATCH_DELAY_MS || '500'),
      }],
    });
    
    logger.info({
      workflowId: handle.workflowId,
      eventType,
      targetCount,
    }, 'Single collection workflow started');
    
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      logger.warn({ workflowId }, 'Workflow already running');
    } else {
      throw error;
    }
  }
}

/**
 * Get status of running workflows
 */
async function getStatus() {
  const client = await getClient();
  
  // Check main workflow
  const mainWorkflowId = `${WORKFLOW_ID_PREFIX}-all-orders`;
  
  try {
    const handle = client.workflow.getHandle(mainWorkflowId);
    const description = await handle.describe();
    
    console.log('\n📊 DLN Collection Status\n');
    console.log('═'.repeat(50));
    console.log(`Workflow ID: ${mainWorkflowId}`);
    console.log(`Status: ${description.status.name}`);
    console.log(`Started: ${description.startTime}`);
    
    if (description.status.name === 'RUNNING') {
      // Query workflow state
      try {
        const state = await handle.query(getAllOrdersState);
        
        console.log('\n📈 Progress:');
        
        if (state.created) {
          const createdPct = ((state.created.totalCollected / state.created.targetCount) * 100).toFixed(1);
          console.log(`\n  Created Orders:`);
          console.log(`    Status: ${state.created.status}`);
          console.log(`    Progress: ${state.created.totalCollected} / ${state.created.targetCount} (${createdPct}%)`);
          console.log(`    Inserted: ${state.created.eventsInserted}`);
          console.log(`    Duplicates: ${state.created.duplicatesSkipped}`);
        }
        
        if (state.fulfilled) {
          const fulfilledPct = ((state.fulfilled.totalCollected / state.fulfilled.targetCount) * 100).toFixed(1);
          console.log(`\n  Fulfilled Orders:`);
          console.log(`    Status: ${state.fulfilled.status}`);
          console.log(`    Progress: ${state.fulfilled.totalCollected} / ${state.fulfilled.targetCount} (${fulfilledPct}%)`);
          console.log(`    Inserted: ${state.fulfilled.eventsInserted}`);
          console.log(`    Duplicates: ${state.fulfilled.duplicatesSkipped}`);
        }
      } catch (e) {
        console.log('\n  (Unable to query state - workflow may be between activities)');
      }
    } else if (description.status.name === 'COMPLETED') {
      console.log('\n✅ Collection completed!');
    } else if (description.status.name === 'FAILED') {
      console.log('\n❌ Collection failed');
    }
    
    console.log('\n' + '═'.repeat(50));
    
  } catch (error) {
    if ((error as any).code === 'NOT_FOUND') {
      console.log('\n⚠️  No running workflow found.');
      console.log('   Start one with: npm run temporal:start');
    } else {
      throw error;
    }
  }
}

/**
 * Pause the running workflow
 */
async function pause() {
  const client = await getClient();
  const workflowId = `${WORKFLOW_ID_PREFIX}-all-orders`;
  
  try {
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal(pauseCollection);
    
    logger.info({ workflowId }, 'Pause signal sent');
    console.log('\n⏸️  Pause signal sent. Collection will pause after current batch.');
    
  } catch (error) {
    if ((error as any).code === 'NOT_FOUND') {
      console.log('\n⚠️  No running workflow found.');
    } else {
      throw error;
    }
  }
}

/**
 * Resume paused workflow
 */
async function resume() {
  const client = await getClient();
  const workflowId = `${WORKFLOW_ID_PREFIX}-all-orders`;
  
  try {
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal(resumeCollection);
    
    logger.info({ workflowId }, 'Resume signal sent');
    console.log('\n▶️  Resume signal sent. Collection will continue.');
    
  } catch (error) {
    if ((error as any).code === 'NOT_FOUND') {
      console.log('\n⚠️  No running workflow found.');
    } else {
      throw error;
    }
  }
}

/**
 * Cancel the running workflow
 */
async function cancel() {
  const client = await getClient();
  const workflowId = `${WORKFLOW_ID_PREFIX}-all-orders`;
  
  try {
    const handle = client.workflow.getHandle(workflowId);
    await handle.cancel();
    
    logger.info({ workflowId }, 'Cancel signal sent');
    console.log('\n🛑 Cancel signal sent. Workflow will terminate.');
    
  } catch (error) {
    if ((error as any).code === 'NOT_FOUND') {
      console.log('\n⚠️  No running workflow found.');
    } else {
      throw error;
    }
  }
}

// CLI
const command = process.argv[2];

switch (command) {
  case 'start':
    startCollection();
    break;
  case 'start-created':
    startSingleCollection('created');
    break;
  case 'start-fulfilled':
    startSingleCollection('fulfilled');
    break;
  case 'status':
    getStatus();
    break;
  case 'pause':
    pause();
    break;
  case 'resume':
    resume();
    break;
  case 'cancel':
    cancel();
    break;
  default:
    console.log(`
DLN Temporal Collector CLI

Commands:
  start           Start collecting all orders (created + fulfilled)
  start-created   Start collecting only OrderCreated events
  start-fulfilled Start collecting only OrderFulfilled events
  status          Check collection status
  pause           Pause collection
  resume          Resume paused collection
  cancel          Cancel collection

Usage:
  npx tsx src/temporal/client.ts <command>
  
  Or use npm scripts:
  npm run temporal:start
  npm run temporal:status
  npm run temporal:pause
  npm run temporal:resume
`);
}
