/**
 * Temporal Client - Start and manage workflows
 * 
 * Commands:
 *   start     - Start the main collection workflow
 *   status    - Check workflow status with child workflow details
 *   pause     - Pause collection (sends signal to children)
 *   resume    - Resume paused collection
 *   cancel    - Cancel the workflow
 *   health    - Run health check workflow
 */

import 'dotenv/config';
import { Connection, Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { 
  collectAllOrdersWorkflow,
  collectOrdersWorkflow,
  healthCheckWorkflow,
  getCollectionState,
  getParentState,
  pauseCollection,
  resumeCollection,
  type CollectionState,
  type ParentWorkflowState,
} from './workflows.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// Configuration
// =============================================================================

const TASK_QUEUE = 'dln-collector';
const WORKFLOW_ID = 'dln-collect-all';

interface ClientConfig {
  temporalAddress: string;
  namespace: string;
  targetCreated: number;
  targetFulfilled: number;
  parallel: boolean;
  config: {
    signaturesBatchSize: number;
    txBatchSize: number;
    batchDelayMs: number;
  };
}

function getConfig(): ClientConfig {
  return {
    temporalAddress: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    targetCreated: parseInt(process.env.TARGET_CREATED_ORDERS || '25000'),
    targetFulfilled: parseInt(process.env.TARGET_FULFILLED_ORDERS || '25000'),
    parallel: process.env.COLLECTION_PARALLEL !== 'false',
    config: {
      // More aggressive defaults for faster collection
      signaturesBatchSize: parseInt(process.env.SIGNATURES_BATCH_SIZE || '1000'),
      txBatchSize: parseInt(process.env.TX_BATCH_SIZE || '100'),      // Increased from 20
      batchDelayMs: parseInt(process.env.BATCH_DELAY_MS || '100'),    // Reduced from 500
    },
  };
}

async function getClient(): Promise<Client> {
  const config = getConfig();
  
  const connection = await Connection.connect({
    address: config.temporalAddress,
  });
  
  return new Client({
    connection,
    namespace: config.namespace,
  });
}

// =============================================================================
// Display Helpers
// =============================================================================

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatProgress(collected: number, target: number): string {
  const pct = ((collected / target) * 100).toFixed(1);
  const bar = '█'.repeat(Math.floor(Number(pct) / 5)) + '░'.repeat(20 - Math.floor(Number(pct) / 5));
  return `${bar} ${pct}%`;
}

function printCollectionState(state: CollectionState, indent: string = '  '): void {
  const statusEmoji = {
    'initializing': '🔄',
    'collecting': '📥',
    'completed': '✅',
    'paused': '⏸️',
    'error': '❌',
  }[state.status] || '❓';

  console.log(`${indent}${statusEmoji} Status: ${state.status.toUpperCase()}`);
  console.log(`${indent}   Progress: ${formatProgress(state.totalCollected, state.targetCount)}`);
  console.log(`${indent}   Collected: ${state.totalCollected.toLocaleString()} / ${state.targetCount.toLocaleString()}`);
  console.log(`${indent}   Inserted: ${state.eventsInserted.toLocaleString()}`);
  console.log(`${indent}   Duplicates: ${state.duplicatesSkipped.toLocaleString()}`);
  console.log(`${indent}   Signatures: ${state.signaturesProcessed.toLocaleString()}`);
  console.log(`${indent}   Iterations: ${state.iterationCount}`);
  
  if (state.status === 'collecting' && state.eventsInserted > 0) {
    const elapsed = (Date.now() - state.startedAt) / 1000 / 60;
    const rate = state.eventsInserted / elapsed;
    const remaining = state.targetCount - state.totalCollected;
    const eta = remaining / rate;
    console.log(`${indent}   Rate: ${rate.toFixed(1)} events/min`);
    console.log(`${indent}   ETA: ${formatDuration(eta * 60 * 1000)}`);
  }
  
  if (state.errorMessage) {
    console.log(`${indent}   Error: ${state.errorMessage}`);
  }
}

// =============================================================================
// Commands
// =============================================================================

async function startCollection(): Promise<void> {
  const config = getConfig();
  const client = await getClient();
  
  console.log('\n🚀 Starting DLN Order Collection\n');
  console.log('═'.repeat(50));
  console.log(`Workflow ID: ${WORKFLOW_ID}`);
  console.log(`Target Created: ${config.targetCreated.toLocaleString()}`);
  console.log(`Target Fulfilled: ${config.targetFulfilled.toLocaleString()}`);
  console.log(`Parallel: ${config.parallel}`);
  console.log(`Batch Size: ${config.config.txBatchSize} txs`);
  console.log(`Batch Delay: ${config.config.batchDelayMs}ms`);
  console.log('═'.repeat(50));
  
  try {
    const handle = await client.workflow.start(collectAllOrdersWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: WORKFLOW_ID,
      args: [{
        targetCreated: config.targetCreated,
        targetFulfilled: config.targetFulfilled,
        parallel: config.parallel,
        config: config.config,
      }],
      // Long timeout for collection
      workflowExecutionTimeout: '7 days',
    });
    
    console.log(`\n✅ Workflow started!`);
    console.log(`   Run ID: ${handle.firstExecutionRunId}`);
    console.log('\n📊 Monitor progress:');
    console.log('   npm run temporal:status');
    console.log('\n🌐 Temporal UI:');
    console.log(`   http://localhost:8233/namespaces/default/workflows/${WORKFLOW_ID}`);
    
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      console.log('\n⚠️  Workflow is already running!');
      console.log('   Check status: npm run temporal:status');
      console.log('   Cancel first: npm run temporal:cancel');
    } else {
      throw error;
    }
  }
}

async function getStatus(): Promise<void> {
  const client = await getClient();
  
  console.log('\n📊 DLN Collection Status\n');
  console.log('═'.repeat(60));
  
  try {
    // Get main workflow handle
    const handle = client.workflow.getHandle(WORKFLOW_ID);
    const description = await handle.describe();
    
    console.log(`Workflow ID: ${WORKFLOW_ID}`);
    console.log(`Status: ${description.status.name}`);
    console.log(`Started: ${description.startTime?.toISOString()}`);
    
    if (description.closeTime) {
      console.log(`Completed: ${description.closeTime.toISOString()}`);
    }
    
    if (description.status.name === 'RUNNING') {
      // Query parent workflow state
      try {
        const parentState = await handle.query(getParentState);
        
        console.log('\n📦 Parent Workflow');
        console.log(`   Status: ${parentState.status}`);
        console.log(`   Started: ${new Date(parentState.startedAt).toISOString()}`);
        
        // Query child workflows
        console.log('\n📥 Created Orders (DlnSource)');
        if (parentState.created) {
          printCollectionState(parentState.created);
        } else {
          // Try to query child directly
          try {
            const createdHandle = client.workflow.getHandle(`${WORKFLOW_ID}-created`);
            const createdState = await createdHandle.query(getCollectionState);
            printCollectionState(createdState);
          } catch {
            console.log('   (Child workflow not started yet)');
          }
        }
        
        console.log('\n📤 Fulfilled Orders (DlnDestination)');
        if (parentState.fulfilled) {
          printCollectionState(parentState.fulfilled);
        } else {
          try {
            const fulfilledHandle = client.workflow.getHandle(`${WORKFLOW_ID}-fulfilled`);
            const fulfilledState = await fulfilledHandle.query(getCollectionState);
            printCollectionState(fulfilledState);
          } catch {
            console.log('   (Child workflow not started yet)');
          }
        }
        
      } catch (e) {
        console.log('\n   (Unable to query workflow state)');
      }
      
    } else if (description.status.name === 'COMPLETED') {
      console.log('\n✅ Collection completed successfully!');
      
      // Try to get final result
      try {
        const result = await handle.result();
        if (result.created) {
          console.log(`\n📥 Created: ${result.created.totalCollected.toLocaleString()} orders`);
        }
        if (result.fulfilled) {
          console.log(`📤 Fulfilled: ${result.fulfilled.totalCollected.toLocaleString()} orders`);
        }
      } catch {}
      
    } else if (description.status.name === 'FAILED') {
      console.log('\n❌ Workflow failed');
      
    } else if (description.status.name === 'CANCELLED') {
      console.log('\n🛑 Workflow was cancelled');
    }
    
    console.log('\n' + '═'.repeat(60));
    
  } catch (error: any) {
    if (error.code === 'NOT_FOUND' || error.message?.includes('not found')) {
      console.log('⚠️  No workflow found.');
      console.log('   Start one with: npm run temporal:start');
    } else {
      throw error;
    }
  }
}

async function pauseWorkflow(): Promise<void> {
  const client = await getClient();
  
  console.log('\n⏸️  Pausing collection...');
  
  try {
    // Pause both child workflows
    const children = [`${WORKFLOW_ID}-created`, `${WORKFLOW_ID}-fulfilled`];
    
    for (const childId of children) {
      try {
        const handle = client.workflow.getHandle(childId);
        await handle.signal(pauseCollection);
        console.log(`   Paused: ${childId}`);
      } catch (e: any) {
        if (!e.message?.includes('not found')) {
          console.log(`   Failed to pause ${childId}: ${e.message}`);
        }
      }
    }
    
    console.log('\n✅ Pause signals sent. Collection will pause after current batch.');
    
  } catch (error: any) {
    if (error.code === 'NOT_FOUND') {
      console.log('⚠️  No running workflow found.');
    } else {
      throw error;
    }
  }
}

async function resumeWorkflow(): Promise<void> {
  const client = await getClient();
  
  console.log('\n▶️  Resuming collection...');
  
  try {
    const children = [`${WORKFLOW_ID}-created`, `${WORKFLOW_ID}-fulfilled`];
    
    for (const childId of children) {
      try {
        const handle = client.workflow.getHandle(childId);
        await handle.signal(resumeCollection);
        console.log(`   Resumed: ${childId}`);
      } catch (e: any) {
        if (!e.message?.includes('not found')) {
          console.log(`   Failed to resume ${childId}: ${e.message}`);
        }
      }
    }
    
    console.log('\n✅ Resume signals sent. Collection will continue.');
    
  } catch (error: any) {
    if (error.code === 'NOT_FOUND') {
      console.log('⚠️  No running workflow found.');
    } else {
      throw error;
    }
  }
}

async function cancelWorkflow(): Promise<void> {
  const client = await getClient();
  
  console.log('\n🛑 Cancelling collection...');
  
  try {
    const handle = client.workflow.getHandle(WORKFLOW_ID);
    await handle.cancel();
    
    console.log('✅ Cancel signal sent. Workflow will terminate.');
    
  } catch (error: any) {
    if (error.code === 'NOT_FOUND' || error.message?.includes('not found')) {
      console.log('⚠️  No running workflow found.');
    } else {
      throw error;
    }
  }
}

async function runHealthCheck(): Promise<void> {
  const client = await getClient();
  
  console.log('\n🏥 Running health check...\n');
  
  try {
    const handle = await client.workflow.start(healthCheckWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `health-check-${Date.now()}`,
      args: [],
    });
    
    const result = await handle.result();
    
    console.log('RPC Health:');
    console.log(`   Status: ${result.rpc.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
    console.log(`   Slot: ${result.rpc.slot.toLocaleString()}`);
    console.log(`   Latency: ${result.rpc.latencyMs}ms`);
    
    console.log('\nDatabase Health:');
    console.log(`   Status: ${result.db.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
    console.log(`   Created Orders: ${result.db.counts.created.toLocaleString()}`);
    console.log(`   Fulfilled Orders: ${result.db.counts.fulfilled.toLocaleString()}`);
    
  } catch (error) {
    console.log('❌ Health check failed:', error);
  }
}

async function watchStatus(): Promise<void> {
  console.log('\n👁️  Watching status (Ctrl+C to stop)...\n');
  
  while (true) {
    console.clear();
    await getStatus();
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// =============================================================================
// CLI
// =============================================================================

function printHelp(): void {
  console.log(`
DLN Temporal Collector CLI

Commands:
  start     Start collecting all orders (created + fulfilled)
  status    Check collection status
  watch     Watch status with auto-refresh
  pause     Pause collection
  resume    Resume paused collection
  cancel    Cancel collection
  health    Run health check

Usage:
  npx tsx src/temporal/client.ts <command>
  
  Or use npm scripts:
  npm run temporal:start
  npm run temporal:status
  npm run temporal:pause
  npm run temporal:resume
  npm run temporal:cancel

Environment Variables:
  TEMPORAL_ADDRESS       Temporal server address (default: localhost:7233)
  TEMPORAL_NAMESPACE     Temporal namespace (default: default)
  TARGET_CREATED_ORDERS  Target created orders (default: 25000)
  TARGET_FULFILLED_ORDERS Target fulfilled orders (default: 25000)
  TX_BATCH_SIZE          Transactions per batch (default: 20)
  BATCH_DELAY_MS         Delay between batches (default: 500)
  COLLECTION_PARALLEL    Run collections in parallel (default: true)
`);
}

const command = process.argv[2];

switch (command) {
  case 'start':
    startCollection().catch(console.error);
    break;
  case 'status':
    getStatus().catch(console.error);
    break;
  case 'watch':
    watchStatus().catch(console.error);
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
  case 'health':
    runHealthCheck().catch(console.error);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    printHelp();
}
