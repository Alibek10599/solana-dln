/**
 * Temporal Activities for DLN Order Collection
 * 
 * Activities are organized into two categories:
 * 1. RPC Activities - Interact with Solana (rate limited)
 * 2. DB Activities - Interact with ClickHouse (high throughput)
 * 
 * Each category runs on a separate task queue for optimal resource usage.
 * 
 * Now uses:
 * - Multi-RPC connection pool with circuit breaker
 * - Parallel transaction fetching
 */

import { 
  PublicKey,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import { Context, ApplicationFailure, activityInfo } from '@temporalio/activity';
import { 
  insertOrderEventsDeduped,
  getCollectionProgress,
  updateCollectionProgress,
  getUniqueOrderCount,
  initializeSchema,
  closeClickHouse,
  type OrderEvent,
} from '../db/clickhouse.js';
import { parseTransactions } from '../parser/transaction.js';
import { logger } from '../utils/logger.js';
import {
  getRpcPool,
  reportSuccess,
  reportFailure,
  fetchTransactionsWithHeartbeat,
  type PoolStats,
} from '../rpc/index.js';

// =============================================================================
// Error Classification
// =============================================================================

export enum ErrorType {
  RETRYABLE = 'RETRYABLE',
  NON_RETRYABLE = 'NON_RETRYABLE',
  FATAL = 'FATAL',
}

interface ClassifiedError {
  type: ErrorType;
  message: string;
  cause?: Error;
}

function classifyError(error: unknown): ClassifiedError {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = err.message.toLowerCase();
  
  // Rate limit errors - retryable
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
    return { type: ErrorType.RETRYABLE, message: 'Rate limited', cause: err };
  }
  
  // Network errors - retryable
  if (message.includes('econnreset') || message.includes('econnrefused') || 
      message.includes('etimedout') || message.includes('socket hang up') ||
      message.includes('network') || message.includes('timeout')) {
    return { type: ErrorType.RETRYABLE, message: 'Network error', cause: err };
  }
  
  // Server errors - retryable
  if (message.includes('500') || message.includes('502') || 
      message.includes('503') || message.includes('504')) {
    return { type: ErrorType.RETRYABLE, message: 'Server error', cause: err };
  }
  
  // Solana-specific retryable
  if (message.includes('blockhash not found') || message.includes('node is behind')) {
    return { type: ErrorType.RETRYABLE, message: 'Solana node issue', cause: err };
  }
  
  // Invalid input - non-retryable
  if (message.includes('invalid') || message.includes('malformed')) {
    return { type: ErrorType.NON_RETRYABLE, message: 'Invalid input', cause: err };
  }
  
  // Default to retryable for unknown errors
  return { type: ErrorType.RETRYABLE, message: err.message, cause: err };
}

function throwClassifiedError(error: unknown): never {
  const classified = classifyError(error);
  
  if (classified.type === ErrorType.NON_RETRYABLE) {
    throw ApplicationFailure.nonRetryable(classified.message, 'NonRetryableError', classified.cause);
  }
  
  if (classified.type === ErrorType.FATAL) {
    throw ApplicationFailure.nonRetryable(classified.message, 'FatalError', classified.cause);
  }
  
  throw classified.cause || new Error(classified.message);
}

// =============================================================================
// Database Activities (Task Queue: dln-db)
// =============================================================================

/**
 * Initialize database schema
 */
export async function initializeDatabase(): Promise<void> {
  const info = activityInfo();
  logger.info({ activityId: info.activityId }, 'Initializing database schema');
  
  try {
    await initializeSchema();
    logger.info('Database schema initialized successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize database');
    throwClassifiedError(error);
  }
}

/**
 * Get current collection progress from database
 */
export async function getProgress(
  programId: string,
  eventType: 'created' | 'fulfilled'
): Promise<{ lastSignature: string | null; totalCollected: number }> {
  try {
    const progress = await getCollectionProgress(programId, eventType);
    const actualCount = await getUniqueOrderCount(eventType);
    
    return {
      lastSignature: progress.lastSignature,
      totalCollected: actualCount,
    };
  } catch (error) {
    logger.error({ error, programId, eventType }, 'Failed to get progress');
    throwClassifiedError(error);
  }
}

/**
 * Store events in ClickHouse with deduplication
 */
export interface StoreEventsInput {
  events: OrderEvent[];
  programId: string;
  eventType: 'created' | 'fulfilled';
  lastSignature: string;
}

export interface StoreEventsOutput {
  insertedCount: number;
  duplicateCount: number;
  totalCollected: number;
}

export async function storeEvents(input: StoreEventsInput): Promise<StoreEventsOutput> {
  const info = activityInfo();
  
  Context.current().heartbeat({ phase: 'storing', eventCount: input.events.length });
  
  try {
    if (input.events.length === 0) {
      const totalCollected = await getUniqueOrderCount(input.eventType);
      await updateCollectionProgress(
        input.programId,
        input.eventType,
        input.lastSignature,
        totalCollected
      );
      
      return { insertedCount: 0, duplicateCount: 0, totalCollected };
    }
    
    // Deserialize events from Temporal
    const deserializedEvents: OrderEvent[] = input.events.map((e: any) => ({
      ...e,
      give_amount: e.give_amount ? BigInt(e.give_amount) : undefined,
      take_amount: e.take_amount ? BigInt(e.take_amount) : undefined,
      fulfilled_amount: e.fulfilled_amount ? BigInt(e.fulfilled_amount) : undefined,
      block_time: new Date(e.block_time),
    }));

    const insertedCount = await insertOrderEventsDeduped(deserializedEvents);
    const duplicateCount = input.events.length - insertedCount;
    
    const totalCollected = await getUniqueOrderCount(input.eventType);
    
    await updateCollectionProgress(
      input.programId,
      input.eventType,
      input.lastSignature,
      totalCollected
    );
    
    logger.info({
      activityId: info.activityId,
      inserted: insertedCount,
      duplicates: duplicateCount,
      total: totalCollected,
    }, 'Events stored');
    
    return { insertedCount, duplicateCount, totalCollected };
    
  } catch (error) {
    logger.error({ error, eventCount: input.events.length }, 'Failed to store events');
    throwClassifiedError(error);
  }
}

/**
 * Get current order counts
 */
export interface OrderCounts {
  created: number;
  fulfilled: number;
  total: number;
}

export async function getOrderCounts(): Promise<OrderCounts> {
  try {
    const [created, fulfilled] = await Promise.all([
      getUniqueOrderCount('created'),
      getUniqueOrderCount('fulfilled'),
    ]);
    
    return { created, fulfilled, total: created + fulfilled };
  } catch (error) {
    logger.error({ error }, 'Failed to get order counts');
    throwClassifiedError(error);
  }
}

// =============================================================================
// RPC Activities (Task Queue: dln-rpc)
// =============================================================================

/**
 * Fetch a batch of signatures from Solana
 */
export interface FetchSignaturesInput {
  programId: string;
  before?: string;
  limit: number;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: boolean;
}

export interface FetchSignaturesOutput {
  signatures: SignatureInfo[];
  lastSignature: string | null;
  hasMore: boolean;
}

export async function fetchSignaturesBatch(
  input: FetchSignaturesInput
): Promise<FetchSignaturesOutput> {
  const info = activityInfo();
  const pool = getRpcPool();
  
  Context.current().heartbeat({ 
    phase: 'fetching_signatures',
    programId: input.programId.slice(0, 8),
    before: input.before?.slice(0, 8),
  });
  
  logger.debug({ 
    activityId: info.activityId,
    programId: input.programId, 
    before: input.before?.slice(0, 20),
    limit: input.limit,
  }, 'Fetching signatures');
  
  try {
    const { connection, endpoint } = pool.getConnection();
    const programPubkey = new PublicKey(input.programId);
    const startTime = Date.now();
    
    const rawSignatures = await connection.getSignaturesForAddress(
      programPubkey,
      {
        before: input.before,
        limit: input.limit,
      },
      'confirmed'
    );
    
    // Report success with latency
    const latency = Date.now() - startTime;
    reportSuccess(endpoint.name, latency);
    
    const signatures: SignatureInfo[] = rawSignatures.map(s => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime ?? null,
      err: s.err !== null,
    }));
    
    const lastSignature = signatures.length > 0 
      ? signatures[signatures.length - 1].signature 
      : null;
    
    const validCount = signatures.filter(s => !s.err).length;
    
    logger.info({ 
      activityId: info.activityId,
      endpoint: endpoint.name,
      fetched: signatures.length,
      valid: validCount,
      latencyMs: latency,
      hasMore: signatures.length === input.limit,
    }, 'Signatures fetched');
    
    return {
      signatures,
      lastSignature,
      hasMore: signatures.length === input.limit,
    };
    
  } catch (error) {
    // Report failure - circuit breaker will handle it
    const { endpoint } = pool.getConnection();
    reportFailure(endpoint.name, error as Error);
    
    logger.error({ error, programId: input.programId }, 'Failed to fetch signatures');
    throwClassifiedError(error);
  }
}

/**
 * Fetch and parse transactions using parallel fetcher
 */
export interface ParseTransactionsInput {
  signatures: string[];
  eventType: 'created' | 'fulfilled';
}

export interface ParseTransactionsOutput {
  events: OrderEvent[];
  processedCount: number;
  errorCount: number;
}

export async function fetchAndParseTransactions(
  input: ParseTransactionsInput
): Promise<ParseTransactionsOutput> {
  const info = activityInfo();
  
  if (input.signatures.length === 0) {
    return { events: [], processedCount: 0, errorCount: 0 };
  }
  
  logger.debug({ 
    activityId: info.activityId,
    signatureCount: input.signatures.length,
    eventType: input.eventType,
  }, 'Fetching transactions with parallel fetcher');
  
  try {
    // Use parallel fetcher with Temporal heartbeat
    const transactions = await fetchTransactionsWithHeartbeat(
      input.signatures,
      (heartbeatInfo) => Context.current().heartbeat(heartbeatInfo),
      {
        concurrency: parseInt(process.env.FETCH_CONCURRENCY || '5'),
        maxRetries: 3,
        retryDelayMs: 1000,
        useBatchApi: process.env.RPC_BATCH_REQUESTS !== 'false',
        batchSize: parseInt(process.env.FETCH_BATCH_SIZE || '50'),
        onProgress: (progress) => {
          if (progress.completed % 100 === 0) {
            logger.debug({
              completed: progress.completed,
              total: progress.total,
              successful: progress.successful,
              failed: progress.failed,
            }, 'Fetch progress');
          }
        },
      }
    );

    Context.current().heartbeat({ phase: 'parsing_transactions' });
    
    const errorCount = transactions.filter(t => t === null).length;
    const processedCount = transactions.length - errorCount;
    
    // Parse events
    const allEvents = await parseTransactions(transactions, input.signatures);
    const events = allEvents.filter(e => e.event_type === input.eventType);

    // DEBUG: Log chain ID info for created orders
    const createdOrders = events.filter(e => e.event_type === 'created');
    if (createdOrders.length > 0) {
      const sample = createdOrders.slice(0, 3);
      logger.info({
        eventType: 'created',
        totalCreated: createdOrders.length,
        sampleOrders: sample.map(e => ({
          orderId: e.order_id.slice(0, 16),
          giveChainId: e.give_chain_id,
          takeChainId: e.take_chain_id,
          giveSymbol: e.give_token_symbol,
          takeSymbol: e.take_token_symbol,
        })),
      }, 'Created orders chain ID status');
    }

    // Serialize for Temporal
    const serializedEvents = events.map(e => ({
      ...e,
      give_amount: e.give_amount ? e.give_amount.toString() : undefined,
      take_amount: e.take_amount ? e.take_amount.toString() : undefined,
      fulfilled_amount: e.fulfilled_amount ? e.fulfilled_amount.toString() : undefined,
      block_time: e.block_time.toISOString(),
      // Explicitly include chain IDs to prevent JSON omission of undefined
      give_chain_id: e.give_chain_id ?? null,
      take_chain_id: e.take_chain_id ?? null,
    })) as any;

    logger.info({
      activityId: info.activityId,
      fetched: transactions.length,
      processed: processedCount,
      errors: errorCount,
      events: events.length,
    }, 'Transactions parsed');

    return { events: serializedEvents, processedCount, errorCount };
    
  } catch (error) {
    logger.error({ error, signatureCount: input.signatures.length }, 'Failed to fetch/parse transactions');
    throwClassifiedError(error);
  }
}

/**
 * Health check for Solana RPC pool
 */
export async function checkRpcHealth(): Promise<{ 
  healthy: boolean; 
  slot: number; 
  latencyMs: number;
  poolStats: PoolStats;
}> {
  const pool = getRpcPool();
  const { connection, endpoint } = pool.getConnection();
  
  const start = Date.now();
  
  try {
    const slot = await connection.getSlot();
    const latencyMs = Date.now() - start;
    
    reportSuccess(endpoint.name, latencyMs);
    
    return { 
      healthy: true, 
      slot, 
      latencyMs,
      poolStats: pool.getStats(),
    };
  } catch (error) {
    reportFailure(endpoint.name, error as Error);
    
    return { 
      healthy: false, 
      slot: 0, 
      latencyMs: Date.now() - start,
      poolStats: pool.getStats(),
    };
  }
}

/**
 * Get RPC pool statistics
 */
export async function getRpcPoolStats(): Promise<PoolStats> {
  const pool = getRpcPool();
  return pool.getStats();
}

// =============================================================================
// Activity Cleanup
// =============================================================================

export async function cleanup(): Promise<void> {
  await closeClickHouse();
  logger.info('Activity resources cleaned up');
}
