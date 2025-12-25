/**
 * DLN Order Events Collector
 * 
 * Collects OrderCreated and OrderFulfilled events from Solana
 * for the DLN (deBridge Liquidity Network) protocol.
 * 
 * Target: 50k+ orders (25k created, 25k fulfilled)
 */

import 'dotenv/config';
import { 
  Connection, 
  PublicKey,
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import { 
  DLN_SOURCE_PROGRAM_ID, 
  DLN_DESTINATION_PROGRAM_ID 
} from '../constants.js';
import { 
  initializeSchema,
  insertOrderEvents,
  getCollectionProgress,
  updateCollectionProgress,
  closeClickHouse,
  type OrderEvent,
} from '../db/clickhouse.js';
import { parseTransactions } from '../parser/transaction.js';
import { logger } from '../utils/logger.js';

// Configuration from environment
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TARGET_CREATED = parseInt(process.env.TARGET_CREATED_ORDERS || '25000');
const TARGET_FULFILLED = parseInt(process.env.TARGET_FULFILLED_ORDERS || '25000');
const SIGNATURES_BATCH_SIZE = parseInt(process.env.SIGNATURES_BATCH_SIZE || '1000');
const TX_BATCH_SIZE = parseInt(process.env.TX_BATCH_SIZE || '50');
const BATCH_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS || '200');

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create Solana connection with retry settings
 */
function createConnection(): Connection {
  return new Connection(SOLANA_RPC_URL, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  });
}

/**
 * Fetch signatures for a program with pagination
 */
async function* fetchSignatures(
  connection: Connection,
  programId: PublicKey,
  startBefore?: string
): AsyncGenerator<ConfirmedSignatureInfo[]> {
  let before = startBefore;
  
  while (true) {
    try {
      const signatures = await connection.getSignaturesForAddress(
        programId,
        {
          before,
          limit: SIGNATURES_BATCH_SIZE,
        },
        'confirmed'
      );
      
      if (signatures.length === 0) {
        break;
      }
      
      yield signatures;
      
      // Set 'before' to the last signature for next page
      before = signatures[signatures.length - 1].signature;
      
      // Rate limiting
      await sleep(BATCH_DELAY_MS);
    } catch (error) {
      logger.error({ error }, 'Failed to fetch signatures, retrying...');
      await sleep(5000); // Wait 5s before retry
    }
  }
}

/**
 * Fetch transactions in batches
 */
async function fetchTransactionsBatch(
  connection: Connection,
  signatures: string[]
): Promise<(ParsedTransactionWithMeta | null)[]> {
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const transactions = await connection.getParsedTransactions(
        signatures,
        {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }
      );
      return transactions;
    } catch (error) {
      logger.warn({ error, attempt }, 'Failed to fetch transactions, retrying...');
      await sleep(2000 * (attempt + 1)); // Exponential backoff
    }
  }
  
  // Return nulls if all retries failed
  return signatures.map(() => null);
}

/**
 * Collect events from a specific program
 */
async function collectFromProgram(
  connection: Connection,
  programId: PublicKey,
  eventType: 'created' | 'fulfilled',
  targetCount: number
): Promise<void> {
  const programIdStr = programId.toBase58();
  
  logger.info({
    program: programIdStr,
    eventType,
    target: targetCount,
  }, 'Starting collection');
  
  // Get progress from last run
  const progress = await getCollectionProgress(programIdStr, eventType);
  let totalCollected = progress.totalCollected;
  let lastSignature = progress.lastSignature;
  
  logger.info({
    totalCollected,
    lastSignature: lastSignature?.slice(0, 20) + '...',
  }, 'Resuming from previous progress');
  
  // Track new events collected in this run
  let newEventsCollected = 0;
  let processedSignatures = 0;
  
  // Fetch signatures in batches
  for await (const sigBatch of fetchSignatures(connection, programId, lastSignature || undefined)) {
    // Filter out failed transactions
    const validSigs = sigBatch.filter(s => s.err === null);
    
    if (validSigs.length === 0) {
      continue;
    }
    
    // Process in smaller batches for transaction fetching
    for (let i = 0; i < validSigs.length; i += TX_BATCH_SIZE) {
      const batch = validSigs.slice(i, i + TX_BATCH_SIZE);
      const signatures = batch.map(s => s.signature);
      
      // Fetch transactions
      const transactions = await fetchTransactionsBatch(connection, signatures);
      
      // Parse events
      const events = await parseTransactions(transactions, signatures);
      
      // Filter events by type
      const relevantEvents = events.filter(e => e.event_type === eventType);
      
      if (relevantEvents.length > 0) {
        // Insert into ClickHouse
        try {
          await insertOrderEvents(relevantEvents);
          newEventsCollected += relevantEvents.length;
          totalCollected += relevantEvents.length;
          
          logger.info({
            batch: Math.floor(processedSignatures / TX_BATCH_SIZE),
            newEvents: relevantEvents.length,
            totalCollected,
            target: targetCount,
          }, 'Batch processed');
        } catch (error) {
          logger.error({ error }, 'Failed to insert events');
        }
      }
      
      processedSignatures += batch.length;
      
      // Update progress checkpoint
      const lastSig = batch[batch.length - 1].signature;
      await updateCollectionProgress(programIdStr, eventType, lastSig, totalCollected);
      lastSignature = lastSig;
      
      // Check if we've reached target
      if (totalCollected >= targetCount) {
        logger.info({
          totalCollected,
          target: targetCount,
        }, 'Target reached!');
        return;
      }
      
      // Rate limiting between transaction batches
      await sleep(BATCH_DELAY_MS);
    }
    
    // Log progress
    logger.info({
      processedSignatures,
      totalCollected,
      target: targetCount,
      progress: `${((totalCollected / targetCount) * 100).toFixed(1)}%`,
    }, 'Progress update');
  }
  
  logger.info({
    totalCollected,
    newEventsCollected,
  }, 'Collection complete (no more signatures)');
}

/**
 * Main collector function
 */
async function main(): Promise<void> {
  logger.info('='.repeat(60));
  logger.info('DLN Solana Dashboard - Data Collector');
  logger.info('='.repeat(60));
  logger.info({
    rpc: SOLANA_RPC_URL.replace(/api[-_]?key=\w+/gi, 'api-key=***'),
    targetCreated: TARGET_CREATED,
    targetFulfilled: TARGET_FULFILLED,
  }, 'Configuration');
  
  try {
    // Initialize database schema
    logger.info('Initializing database...');
    await initializeSchema();
    
    // Create Solana connection
    const connection = createConnection();
    
    // Test connection
    const slot = await connection.getSlot();
    logger.info({ slot }, 'Connected to Solana');
    
    // Collect OrderCreated events (from DlnSource program)
    logger.info('');
    logger.info('Phase 1: Collecting OrderCreated events...');
    await collectFromProgram(
      connection,
      DLN_SOURCE_PROGRAM_ID,
      'created',
      TARGET_CREATED
    );
    
    // Collect OrderFulfilled events (from DlnDestination program)
    logger.info('');
    logger.info('Phase 2: Collecting OrderFulfilled events...');
    await collectFromProgram(
      connection,
      DLN_DESTINATION_PROGRAM_ID,
      'fulfilled',
      TARGET_FULFILLED
    );
    
    logger.info('');
    logger.info('='.repeat(60));
    logger.info('Collection complete!');
    logger.info('='.repeat(60));
    
  } catch (error) {
    logger.error({ error }, 'Collector failed');
    process.exit(1);
  } finally {
    await closeClickHouse();
  }
}

// Run collector
main();
