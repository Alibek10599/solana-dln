/**
 * DLN Order Events Collector
 * 
 * Collects OrderCreated and OrderFulfilled events from Solana
 * for the DLN (deBridge Liquidity Network) protocol.
 * 
 * Features:
 * - Exponential backoff retry with jitter
 * - Rate limiting to avoid RPC throttling  
 * - Deduplication via ReplacingMergeTree + explicit checks
 * - Progress checkpointing for resume capability
 * - Circuit breaker for persistent failures
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
  insertOrderEventsDeduped,
  getCollectionProgress,
  updateCollectionProgress,
  getUniqueOrderCount,
  closeClickHouse,
  type OrderEvent,
} from '../db/clickhouse.js';
import { parseTransactions } from '../parser/transaction.js';
import { logger } from '../utils/logger.js';
import { 
  withRetry, 
  sleep, 
  RateLimiter, 
  CircuitBreaker,
  isRetryableError,
} from '../utils/retry.js';

// Configuration from environment
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TARGET_CREATED = parseInt(process.env.TARGET_CREATED_ORDERS || '25000');
const TARGET_FULFILLED = parseInt(process.env.TARGET_FULFILLED_ORDERS || '25000');
const SIGNATURES_BATCH_SIZE = parseInt(process.env.SIGNATURES_BATCH_SIZE || '1000');
const TX_BATCH_SIZE = parseInt(process.env.TX_BATCH_SIZE || '20'); // Reduced for stability
const BATCH_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS || '500');

// Rate limiter: ~2 requests per second for public RPC
// Increase for premium RPC providers
const RATE_LIMIT_RPS = parseFloat(process.env.RATE_LIMIT_RPS || '2');
const rateLimiter = new RateLimiter(5, RATE_LIMIT_RPS);

// Circuit breaker for RPC failures
const circuitBreaker = new CircuitBreaker(10, 60000); // 10 failures, 60s timeout

/**
 * Create Solana connection with retry settings
 */
function createConnection(): Connection {
  return new Connection(SOLANA_RPC_URL, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
    disableRetryOnRateLimit: false, // Let connection handle some retries
  });
}

/**
 * Fetch signatures for a program with pagination, retry, and rate limiting
 */
async function* fetchSignatures(
  connection: Connection,
  programId: PublicKey,
  startBefore?: string
): AsyncGenerator<ConfirmedSignatureInfo[]> {
  let before = startBefore;
  let consecutiveEmptyBatches = 0;
  const MAX_EMPTY_BATCHES = 3;
  
  while (true) {
    // Rate limiting
    await rateLimiter.acquire();
    
    try {
      const signatures = await circuitBreaker.execute(() =>
        withRetry(
          () => connection.getSignaturesForAddress(
            programId,
            {
              before,
              limit: SIGNATURES_BATCH_SIZE,
            },
            'confirmed'
          ),
          {
            maxRetries: 5,
            baseDelayMs: 2000,
            maxDelayMs: 30000,
            context: 'getSignaturesForAddress',
          }
        )
      );
      
      if (signatures.length === 0) {
        consecutiveEmptyBatches++;
        if (consecutiveEmptyBatches >= MAX_EMPTY_BATCHES) {
          logger.info('No more signatures found');
          break;
        }
        // Maybe we hit a gap, try continuing
        await sleep(1000);
        continue;
      }
      
      consecutiveEmptyBatches = 0;
      yield signatures;
      
      // Set 'before' to the last signature for next page
      before = signatures[signatures.length - 1].signature;
      
      // Additional delay between batches
      await sleep(BATCH_DELAY_MS);
      
    } catch (error) {
      if ((error as Error).message?.includes('Circuit breaker')) {
        logger.error('Circuit breaker is open, waiting before retry...');
        await sleep(60000); // Wait 1 minute
        continue;
      }
      
      logger.error({ error }, 'Failed to fetch signatures after all retries');
      throw error;
    }
  }
}

/**
 * Fetch transactions in batches with retry and rate limiting
 */
async function fetchTransactionsBatch(
  connection: Connection,
  signatures: string[]
): Promise<(ParsedTransactionWithMeta | null)[]> {
  // Rate limiting
  await rateLimiter.acquire();
  
  try {
    const transactions = await circuitBreaker.execute(() =>
      withRetry(
        () => connection.getParsedTransactions(
          signatures,
          {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }
        ),
        {
          maxRetries: 5,
          baseDelayMs: 2000,
          maxDelayMs: 30000,
          context: 'getParsedTransactions',
        }
      )
    );
    
    return transactions;
  } catch (error) {
    logger.error({ 
      error, 
      signatureCount: signatures.length,
      firstSig: signatures[0]?.slice(0, 20),
    }, 'Failed to fetch transactions');
    
    // Return nulls for failed batch
    return signatures.map(() => null);
  }
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
  let lastSignature = progress.lastSignature;
  
  // Get actual deduplicated count from database
  let totalCollected = await getUniqueOrderCount(eventType);
  
  logger.info({
    totalCollected,
    lastSignature: lastSignature ? `${lastSignature.slice(0, 20)}...` : 'none',
  }, 'Resuming from previous progress');
  
  // Check if already at target
  if (totalCollected >= targetCount) {
    logger.info({ totalCollected, target: targetCount }, 'Target already reached!');
    return;
  }
  
  // Track stats for this run
  let signaturesProcessed = 0;
  let transactionsProcessed = 0;
  let eventsInserted = 0;
  let duplicatesSkipped = 0;
  const startTime = Date.now();
  
  // Fetch signatures in batches
  for await (const sigBatch of fetchSignatures(connection, programId, lastSignature || undefined)) {
    // Filter out failed transactions
    const validSigs = sigBatch.filter(s => s.err === null);
    
    if (validSigs.length === 0) {
      logger.debug('Batch had no valid signatures, continuing...');
      continue;
    }
    
    signaturesProcessed += validSigs.length;
    
    // Process in smaller batches for transaction fetching
    for (let i = 0; i < validSigs.length; i += TX_BATCH_SIZE) {
      const batch = validSigs.slice(i, i + TX_BATCH_SIZE);
      const signatures = batch.map(s => s.signature);
      
      // Fetch transactions with retry
      const transactions = await fetchTransactionsBatch(connection, signatures);
      
      // Count non-null transactions
      const validTxCount = transactions.filter(t => t !== null).length;
      transactionsProcessed += validTxCount;
      
      // Parse events
      const events = await parseTransactions(transactions, signatures);
      
      // Filter events by type
      const relevantEvents = events.filter(e => e.event_type === eventType);
      
      if (relevantEvents.length > 0) {
        // Insert with deduplication check
        try {
          const inserted = await insertOrderEventsDeduped(relevantEvents);
          eventsInserted += inserted;
          duplicatesSkipped += relevantEvents.length - inserted;
          
          // Update total (query actual count periodically for accuracy)
          totalCollected += inserted;
          
          if (inserted > 0) {
            logger.info({
              batch: Math.floor(signaturesProcessed / TX_BATCH_SIZE),
              inserted,
              duplicates: relevantEvents.length - inserted,
              totalCollected,
              target: targetCount,
              progress: `${((totalCollected / targetCount) * 100).toFixed(1)}%`,
            }, 'Batch processed');
          }
        } catch (error) {
          logger.error({ error }, 'Failed to insert events');
          // Continue processing - don't fail entire collection
        }
      }
      
      // Update progress checkpoint
      const lastSig = batch[batch.length - 1].signature;
      await updateCollectionProgress(programIdStr, eventType, lastSig, totalCollected);
      lastSignature = lastSig;
      
      // Check if we've reached target
      if (totalCollected >= targetCount) {
        logger.info({
          totalCollected,
          target: targetCount,
          duration: `${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`,
        }, 'Target reached!');
        return;
      }
      
      // Rate limiting between transaction batches
      await sleep(BATCH_DELAY_MS);
    }
    
    // Periodic stats logging
    const elapsedMinutes = (Date.now() - startTime) / 1000 / 60;
    const eventsPerMinute = eventsInserted / elapsedMinutes;
    
    logger.info({
      signaturesProcessed,
      transactionsProcessed,
      eventsInserted,
      duplicatesSkipped,
      totalCollected,
      target: targetCount,
      progress: `${((totalCollected / targetCount) * 100).toFixed(1)}%`,
      rate: `${eventsPerMinute.toFixed(1)} events/min`,
      circuitBreaker: circuitBreaker.getState(),
    }, 'Progress update');
  }
  
  // Final stats
  const totalDuration = (Date.now() - startTime) / 1000 / 60;
  logger.info({
    totalCollected,
    eventsInserted,
    duplicatesSkipped,
    signaturesProcessed,
    transactionsProcessed,
    duration: `${totalDuration.toFixed(1)} minutes`,
    avgRate: `${(eventsInserted / totalDuration).toFixed(1)} events/min`,
  }, 'Collection complete');
}

/**
 * Main collector function
 */
async function main(): Promise<void> {
  logger.info('='.repeat(60));
  logger.info('DLN Solana Dashboard - Data Collector');
  logger.info('='.repeat(60));
  
  // Mask API key in logs
  const maskedRpc = SOLANA_RPC_URL.replace(/api[-_]?key=[\w-]+/gi, 'api-key=***');
  
  logger.info({
    rpc: maskedRpc,
    targetCreated: TARGET_CREATED,
    targetFulfilled: TARGET_FULFILLED,
    signaturesBatch: SIGNATURES_BATCH_SIZE,
    txBatch: TX_BATCH_SIZE,
    rateLimit: `${RATE_LIMIT_RPS} req/s`,
  }, 'Configuration');
  
  try {
    // Initialize database schema
    logger.info('Initializing database...');
    await initializeSchema();
    
    // Create Solana connection
    const connection = createConnection();
    
    // Test connection with retry
    const slot = await withRetry(
      () => connection.getSlot(),
      { maxRetries: 3, context: 'getSlot' }
    );
    logger.info({ slot }, 'Connected to Solana');
    
    // Collect OrderCreated events (from DlnSource program)
    logger.info('');
    logger.info('═'.repeat(50));
    logger.info('Phase 1: Collecting OrderCreated events');
    logger.info('═'.repeat(50));
    await collectFromProgram(
      connection,
      DLN_SOURCE_PROGRAM_ID,
      'created',
      TARGET_CREATED
    );
    
    // Collect OrderFulfilled events (from DlnDestination program)
    logger.info('');
    logger.info('═'.repeat(50));
    logger.info('Phase 2: Collecting OrderFulfilled events');
    logger.info('═'.repeat(50));
    await collectFromProgram(
      connection,
      DLN_DESTINATION_PROGRAM_ID,
      'fulfilled',
      TARGET_FULFILLED
    );
    
    // Final summary
    const [createdCount, fulfilledCount] = await Promise.all([
      getUniqueOrderCount('created'),
      getUniqueOrderCount('fulfilled'),
    ]);
    
    logger.info('');
    logger.info('═'.repeat(60));
    logger.info('Collection Complete!');
    logger.info('═'.repeat(60));
    logger.info({
      createdOrders: createdCount,
      fulfilledOrders: fulfilledCount,
      total: createdCount + fulfilledCount,
    }, 'Final counts');
    
  } catch (error) {
    logger.error({ error }, 'Collector failed');
    process.exit(1);
  } finally {
    await closeClickHouse();
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  await closeClickHouse();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  await closeClickHouse();
  process.exit(0);
});

// Run collector
main();
