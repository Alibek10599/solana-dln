/**
 * Temporal Activities for DLN Order Collection
 * 
 * Activities are the building blocks of workflows - they handle
 * the actual work (RPC calls, DB operations) with automatic retries.
 */

import { 
  Connection, 
  PublicKey,
} from '@solana/web3.js';
import { 
  insertOrderEventsDeduped,
  getCollectionProgress,
  updateCollectionProgress,
  getUniqueOrderCount,
  type OrderEvent,
} from '../db/clickhouse.js';
import { parseTransactions } from '../parser/transaction.js';
import { logger } from '../utils/logger.js';
import { heartbeat } from '@temporalio/activity';

// Shared connection (created once per worker)
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

// ============================================================
// Activity: Fetch Signatures
// ============================================================

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
  hasMore: boolean;
  lastSignature?: string;
}

/**
 * Fetch transaction signatures for a program
 * 
 * This is a short activity - just one RPC call.
 * Temporal handles retries based on retry policy.
 */
export async function fetchSignatures(input: FetchSignaturesInput): Promise<FetchSignaturesOutput> {
  const conn = getConnection();
  const programId = new PublicKey(input.programId);
  
  // Report heartbeat for monitoring
  heartbeat('Fetching signatures...');
  
  const signatures = await conn.getSignaturesForAddress(
    programId,
    {
      before: input.before,
      limit: input.limit,
    },
    'confirmed'
  );
  
  logger.debug({
    programId: input.programId.slice(0, 20),
    count: signatures.length,
    before: input.before?.slice(0, 20),
  }, 'Fetched signatures');
  
  return {
    signatures: signatures.map(s => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime,
      err: s.err !== null,
    })),
    hasMore: signatures.length === input.limit,
    lastSignature: signatures.length > 0 
      ? signatures[signatures.length - 1].signature 
      : undefined,
  };
}

// ============================================================
// Activity: Fetch and Parse Transactions
// ============================================================

export interface FetchTransactionsInput {
  signatures: string[];
}

export interface ParsedEvent {
  order_id: string;
  event_type: 'created' | 'fulfilled';
  signature: string;
  slot: number;
  block_time: string; // ISO string for serialization
  maker?: string;
  give_token_address?: string;
  give_token_symbol?: string;
  give_amount?: string; // bigint as string for serialization
  give_amount_usd?: number;
  give_chain_id?: number;
  take_token_address?: string;
  take_token_symbol?: string;
  take_amount?: string;
  take_amount_usd?: number;
  take_chain_id?: number;
  receiver?: string;
  taker?: string;
  fulfilled_amount?: string;
  fulfilled_amount_usd?: number;
}

export interface FetchTransactionsOutput {
  events: ParsedEvent[];
  successCount: number;
  failureCount: number;
}

/**
 * Fetch transactions and parse them into events
 * 
 * Combines fetch + parse into one activity for efficiency.
 * Uses heartbeats for long batches.
 */
export async function fetchAndParseTransactions(
  input: FetchTransactionsInput
): Promise<FetchTransactionsOutput> {
  const conn = getConnection();
  
  heartbeat(`Fetching ${input.signatures.length} transactions...`);
  
  const transactions = await conn.getParsedTransactions(
    input.signatures,
    {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    }
  );
  
  const successCount = transactions.filter(t => t !== null).length;
  const failureCount = transactions.length - successCount;
  
  heartbeat('Parsing transactions...');
  
  // Parse events
  const events = await parseTransactions(transactions, input.signatures);
  
  // Convert to serializable format (bigints -> strings)
  const serializedEvents: ParsedEvent[] = events.map(e => ({
    ...e,
    block_time: e.block_time.toISOString(),
    give_amount: e.give_amount?.toString(),
    take_amount: e.take_amount?.toString(),
    fulfilled_amount: e.fulfilled_amount?.toString(),
  }));
  
  logger.debug({
    requested: input.signatures.length,
    success: successCount,
    failed: failureCount,
    events: events.length,
  }, 'Parsed transactions');
  
  return {
    events: serializedEvents,
    successCount,
    failureCount,
  };
}

// ============================================================
// Activity: Store Events
// ============================================================

export interface StoreEventsInput {
  events: ParsedEvent[];
}

export interface StoreEventsOutput {
  inserted: number;
  duplicates: number;
}

/**
 * Store events in ClickHouse with deduplication
 */
export async function storeEvents(input: StoreEventsInput): Promise<StoreEventsOutput> {
  if (input.events.length === 0) {
    return { inserted: 0, duplicates: 0 };
  }
  
  heartbeat(`Storing ${input.events.length} events...`);
  
  // Convert back from serializable format
  const events: OrderEvent[] = input.events.map(e => ({
    ...e,
    block_time: new Date(e.block_time),
    give_amount: e.give_amount ? BigInt(e.give_amount) : undefined,
    take_amount: e.take_amount ? BigInt(e.take_amount) : undefined,
    fulfilled_amount: e.fulfilled_amount ? BigInt(e.fulfilled_amount) : undefined,
  }));
  
  const inserted = await insertOrderEventsDeduped(events);
  const duplicates = events.length - inserted;
  
  logger.debug({
    total: events.length,
    inserted,
    duplicates,
  }, 'Stored events');
  
  return { inserted, duplicates };
}

// ============================================================
// Activity: Get/Update Progress
// ============================================================

export interface GetProgressInput {
  programId: string;
  eventType: 'created' | 'fulfilled';
}

export interface ProgressOutput {
  lastSignature: string | null;
  totalCollected: number;
}

export async function getProgress(input: GetProgressInput): Promise<ProgressOutput> {
  const progress = await getCollectionProgress(input.programId, input.eventType);
  return progress;
}

export interface UpdateProgressInput {
  programId: string;
  eventType: 'created' | 'fulfilled';
  lastSignature: string;
  totalCollected: number;
}

export async function updateProgress(input: UpdateProgressInput): Promise<void> {
  await updateCollectionProgress(
    input.programId,
    input.eventType,
    input.lastSignature,
    input.totalCollected
  );
}

// ============================================================
// Activity: Get Counts
// ============================================================

export interface GetCountInput {
  eventType?: 'created' | 'fulfilled';
}

export async function getCount(input: GetCountInput): Promise<number> {
  return await getUniqueOrderCount(input.eventType);
}
