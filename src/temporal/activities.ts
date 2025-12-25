/**
 * Temporal Activities for DLN Order Collection
 * 
 * Activities are the "side-effect" functions that interact with external systems:
 * - Solana RPC
 * - ClickHouse database
 * 
 * Each activity is automatically retried by Temporal based on retry policy.
 * Activities should be idempotent when possible.
 */

import { 
  Connection, 
  PublicKey,
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import { Context } from '@temporalio/activity';
import { 
  insertOrderEventsDeduped,
  getCollectionProgress,
  updateCollectionProgress,
  getUniqueOrderCount,
  initializeSchema,
  type OrderEvent,
} from '../db/clickhouse.js';
import { parseTransactions } from '../parser/transaction.js';
import { logger } from '../utils/logger.js';

// Lazy-initialized connection
let connection: Connection | null = null;

function getConnection(): Connection {
  if (!connection) {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
  }
  return connection;
}

/**
 * Activity: Initialize database schema
 */
export async function initializeDatabase(): Promise<void> {
  logger.info('Initializing database schema...');
  await initializeSchema();
  logger.info('Database schema initialized');
}

/**
 * Activity: Get current collection progress
 */
export async function getProgress(
  programId: string,
  eventType: 'created' | 'fulfilled'
): Promise<{ lastSignature: string | null; totalCollected: number }> {
  const progress = await getCollectionProgress(programId, eventType);
  const actualCount = await getUniqueOrderCount(eventType);
  
  return {
    lastSignature: progress.lastSignature,
    totalCollected: actualCount,
  };
}

/**
 * Activity: Fetch a batch of signatures from Solana
 * 
 * Returns signatures for transactions involving the program.
 * Uses 'before' for pagination.
 */
export interface FetchSignaturesInput {
  programId: string;
  before?: string;
  limit: number;
}

export interface FetchSignaturesOutput {
  signatures: Array<{
    signature: string;
    slot: number;
    blockTime: number | null;
    err: boolean;
  }>;
  lastSignature: string | null;
  hasMore: boolean;
}

export async function fetchSignaturesBatch(
  input: FetchSignaturesInput
): Promise<FetchSignaturesOutput> {
  const conn = getConnection();
  const programPubkey = new PublicKey(input.programId);
  
  // Heartbeat to let Temporal know we're still working
  Context.current().heartbeat('Fetching signatures...');
  
  logger.debug({ 
    programId: input.programId, 
    before: input.before?.slice(0, 20),
    limit: input.limit,
  }, 'Fetching signatures');
  
  const rawSignatures = await conn.getSignaturesForAddress(
    programPubkey,
    {
      before: input.before,
      limit: input.limit,
    },
    'confirmed'
  );
  
  const signatures = rawSignatures.map(s => ({
    signature: s.signature,
    slot: s.slot,
    blockTime: s.blockTime,
    err: s.err !== null,
  }));
  
  const lastSignature = signatures.length > 0 
    ? signatures[signatures.length - 1].signature 
    : null;
  
  logger.info({ 
    fetched: signatures.length,
    validCount: signatures.filter(s => !s.err).length,
    lastSignature: lastSignature?.slice(0, 20),
  }, 'Signatures fetched');
  
  return {
    signatures,
    lastSignature,
    hasMore: signatures.length === input.limit,
  };
}

/**
 * Activity: Fetch and parse transactions
 * 
 * Takes a batch of signatures, fetches full transactions,
 * and parses them into OrderEvents.
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
  const conn = getConnection();
  
  Context.current().heartbeat(`Parsing ${input.signatures.length} transactions...`);
  
  logger.debug({ 
    signatureCount: input.signatures.length,
    eventType: input.eventType,
  }, 'Fetching transactions');
  
  // Fetch transactions
  const transactions = await conn.getParsedTransactions(
    input.signatures,
    {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    }
  );
  
  // Count errors
  const errorCount = transactions.filter(t => t === null).length;
  
  // Parse events
  const allEvents = await parseTransactions(transactions, input.signatures);
  
  // Filter by event type
  const events = allEvents.filter(e => e.event_type === input.eventType);
  
  logger.info({
    fetched: transactions.length,
    parsed: allEvents.length,
    filtered: events.length,
    errors: errorCount,
  }, 'Transactions parsed');
  
  return {
    events,
    processedCount: transactions.length - errorCount,
    errorCount,
  };
}

/**
 * Activity: Store events in ClickHouse
 * 
 * Inserts events with deduplication.
 * Returns count of actually inserted (new) events.
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

export async function storeEvents(
  input: StoreEventsInput
): Promise<StoreEventsOutput> {
  Context.current().heartbeat('Storing events...');
  
  if (input.events.length === 0) {
    // Still update progress even with no events
    const totalCollected = await getUniqueOrderCount(input.eventType);
    await updateCollectionProgress(
      input.programId,
      input.eventType,
      input.lastSignature,
      totalCollected
    );
    
    return {
      insertedCount: 0,
      duplicateCount: 0,
      totalCollected,
    };
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
    inserted: insertedCount,
    duplicates: duplicateCount,
    total: totalCollected,
  }, 'Events stored');
  
  return {
    insertedCount,
    duplicateCount,
    totalCollected,
  };
}

/**
 * Activity: Get current order counts
 */
export interface OrderCounts {
  created: number;
  fulfilled: number;
  total: number;
}

export async function getOrderCounts(): Promise<OrderCounts> {
  const [created, fulfilled] = await Promise.all([
    getUniqueOrderCount('created'),
    getUniqueOrderCount('fulfilled'),
  ]);
  
  return {
    created,
    fulfilled,
    total: created + fulfilled,
  };
}
