/**
 * Temporal Activities for DLN Order Collection
 * 
 * Activities are organized into two categories:
 * 1. RPC Activities - Interact with Solana (rate limited)
 * 2. DB Activities - Interact with ClickHouse (high throughput)
 * 
 * Each category runs on a separate task queue for optimal resource usage.
 */

import { 
  Connection, 
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
  getClickHouseClient,
  closeClickHouse,
  type OrderEvent,
} from '../db/clickhouse.js';
import { parseTransactions } from '../parser/transaction.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// Connection Pool Management
// =============================================================================

/**
 * Solana Connection Pool
 * Reuses connections across activity invocations to reduce overhead
 */
class SolanaConnectionPool {
  private static instance: SolanaConnectionPool;
  private connection: Connection | null = null;
  private lastUsed: number = 0;
  private readonly maxIdleTime = 5 * 60 * 1000; // 5 minutes

  static getInstance(): SolanaConnectionPool {
    if (!SolanaConnectionPool.instance) {
      SolanaConnectionPool.instance = new SolanaConnectionPool();
    }
    return SolanaConnectionPool.instance;
  }

  getConnection(): Connection {
    const now = Date.now();
    
    // Create new connection if none exists or idle too long
    if (!this.connection || (now - this.lastUsed) > this.maxIdleTime) {
      const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      this.connection = new Connection(rpcUrl, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: false,
      });
      logger.debug({ rpcUrl: rpcUrl.replace(/api[-_]?key=[\w-]+/gi, 'api-key=***') }, 'Created new Solana connection');
    }
    
    this.lastUsed = now;
    return this.connection;
  }
}

// =============================================================================
// Error Classification
// =============================================================================

/**
 * Classifies errors for proper retry handling
 */
export enum ErrorType {
  RETRYABLE = 'RETRYABLE',           // Network issues, rate limits
  NON_RETRYABLE = 'NON_RETRYABLE',   // Invalid input, not found
  FATAL = 'FATAL',                    // Should stop workflow
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
  
  // Retryable - just throw the original error
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
  
  // Heartbeat for long batches
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
    
    // Insert with deduplication
    const insertedCount = await insertOrderEventsDeduped(input.events);
    const duplicateCount = input.events.length - insertedCount;
    
    // Get updated total
    const totalCollected = await getUniqueOrderCount(input.eventType);
    
    // Update progress checkpoint
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
 * Get current order counts (for final reporting)
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
  const pool = SolanaConnectionPool.getInstance();
  const connection = pool.getConnection();
  
  // Heartbeat
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
    const programPubkey = new PublicKey(input.programId);
    
    const rawSignatures = await connection.getSignaturesForAddress(
      programPubkey,
      {
        before: input.before,
        limit: input.limit,
      },
      'confirmed'
    );
    
    const signatures: SignatureInfo[] = rawSignatures.map(s => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime,
      err: s.err !== null,
    }));
    
    const lastSignature = signatures.length > 0 
      ? signatures[signatures.length - 1].signature 
      : null;
    
    const validCount = signatures.filter(s => !s.err).length;
    
    logger.info({ 
      activityId: info.activityId,
      fetched: signatures.length,
      valid: validCount,
      hasMore: signatures.length === input.limit,
    }, 'Signatures fetched');
    
    return {
      signatures,
      lastSignature,
      hasMore: signatures.length === input.limit,
    };
    
  } catch (error) {
    logger.error({ error, programId: input.programId }, 'Failed to fetch signatures');
    throwClassifiedError(error);
  }
}

/**
 * Fetch and parse transactions
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
  const pool = SolanaConnectionPool.getInstance();
  const connection = pool.getConnection();
  
  if (input.signatures.length === 0) {
    return { events: [], processedCount: 0, errorCount: 0 };
  }
  
  // Heartbeat with progress
  Context.current().heartbeat({ 
    phase: 'fetching_transactions',
    count: input.signatures.length,
  });
  
  logger.debug({ 
    activityId: info.activityId,
    signatureCount: input.signatures.length,
    eventType: input.eventType,
  }, 'Fetching transactions');
  
  try {
    // Fetch transactions
    const transactions = await connection.getParsedTransactions(
      input.signatures,
      {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }
    );
    
    // Heartbeat before parsing
    Context.current().heartbeat({ phase: 'parsing_transactions' });
    
    // Count errors
    const errorCount = transactions.filter(t => t === null).length;
    const processedCount = transactions.length - errorCount;
    
    // Parse events
    const allEvents = await parseTransactions(transactions, input.signatures);
    
    // Filter by event type
    const events = allEvents.filter(e => e.event_type === input.eventType);
    
    logger.info({
      activityId: info.activityId,
      fetched: transactions.length,
      processed: processedCount,
      errors: errorCount,
      events: events.length,
    }, 'Transactions parsed');
    
    return { events, processedCount, errorCount };
    
  } catch (error) {
    logger.error({ error, signatureCount: input.signatures.length }, 'Failed to fetch/parse transactions');
    throwClassifiedError(error);
  }
}

/**
 * Health check for Solana RPC
 */
export async function checkRpcHealth(): Promise<{ healthy: boolean; slot: number; latencyMs: number }> {
  const pool = SolanaConnectionPool.getInstance();
  const connection = pool.getConnection();
  
  const start = Date.now();
  
  try {
    const slot = await connection.getSlot();
    const latencyMs = Date.now() - start;
    
    return { healthy: true, slot, latencyMs };
  } catch (error) {
    return { healthy: false, slot: 0, latencyMs: Date.now() - start };
  }
}

// =============================================================================
// Activity Cleanup
// =============================================================================

/**
 * Cleanup resources (call on worker shutdown)
 */
export async function cleanup(): Promise<void> {
  await closeClickHouse();
  logger.info('Activity resources cleaned up');
}
