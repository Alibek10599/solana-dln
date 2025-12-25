/**
 * ClickHouse Database Client and Schema
 * 
 * Optimized for time-series analytics on DLN order events
 */

import { createClient, ClickHouseClient } from '@clickhouse/client';
import { logger } from '../utils/logger.js';

let client: ClickHouseClient | null = null;

export function getClickHouseClient(): ClickHouseClient {
  if (!client) {
    client = createClient({
      url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
      database: process.env.CLICKHOUSE_DATABASE || 'dln_dashboard',
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 0,
      },
    });
  }
  return client;
}

export async function closeClickHouse(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}

/**
 * ClickHouse Schema for DLN Orders
 */
export const SCHEMA = {
  /**
   * Main orders table - stores both created and fulfilled events
   * Using MergeTree for fast aggregations and time-series queries
   */
  ordersTable: `
    CREATE TABLE IF NOT EXISTS orders (
      -- Event identification
      order_id String,
      event_type Enum8('created' = 1, 'fulfilled' = 2),
      
      -- Transaction info
      signature String,
      slot UInt64,
      block_time DateTime,
      
      -- Order creation fields (populated for 'created' events)
      maker Nullable(String),
      give_token_address Nullable(String),
      give_token_symbol Nullable(String),
      give_amount Nullable(UInt128),
      give_amount_usd Nullable(Float64),
      give_chain_id Nullable(UInt64),
      
      take_token_address Nullable(String),
      take_token_symbol Nullable(String),
      take_amount Nullable(UInt128),
      take_amount_usd Nullable(Float64),
      take_chain_id Nullable(UInt64),
      
      receiver Nullable(String),
      
      -- Order fulfillment fields (populated for 'fulfilled' events)
      taker Nullable(String),
      fulfilled_amount Nullable(UInt128),
      fulfilled_amount_usd Nullable(Float64),
      
      -- Metadata
      created_at DateTime DEFAULT now()
    )
    ENGINE = MergeTree()
    PARTITION BY toYYYYMM(block_time)
    ORDER BY (block_time, order_id, event_type)
    SETTINGS index_granularity = 8192
  `,

  /**
   * Materialized view for daily volumes
   * Pre-aggregates data for fast dashboard queries
   */
  dailyVolumesMV: `
    CREATE MATERIALIZED VIEW IF NOT EXISTS daily_volumes_mv
    ENGINE = SummingMergeTree()
    PARTITION BY toYYYYMM(date)
    ORDER BY (date, event_type)
    AS SELECT
      toDate(block_time) AS date,
      event_type,
      count() AS order_count,
      sum(coalesce(give_amount_usd, fulfilled_amount_usd, 0)) AS volume_usd
    FROM orders
    GROUP BY date, event_type
  `,

  /**
   * Materialized view for token statistics
   */
  tokenStatsMV: `
    CREATE MATERIALIZED VIEW IF NOT EXISTS token_stats_mv
    ENGINE = SummingMergeTree()
    ORDER BY (give_token_symbol)
    AS SELECT
      give_token_symbol,
      count() AS order_count,
      sum(give_amount_usd) AS volume_usd
    FROM orders
    WHERE event_type = 'created' AND give_token_symbol IS NOT NULL
    GROUP BY give_token_symbol
  `,

  /**
   * Collection progress tracking table
   */
  collectionProgressTable: `
    CREATE TABLE IF NOT EXISTS collection_progress (
      program_id String,
      event_type String,
      last_signature String,
      total_collected UInt64,
      updated_at DateTime DEFAULT now()
    )
    ENGINE = ReplacingMergeTree(updated_at)
    ORDER BY (program_id, event_type)
  `,
};

/**
 * Initialize database schema
 */
export async function initializeSchema(): Promise<void> {
  const ch = getClickHouseClient();
  
  // Create database if not exists (need to connect without database first)
  const dbName = process.env.CLICKHOUSE_DATABASE || 'dln_dashboard';
  
  const rootClient = createClient({
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
  });
  
  try {
    await rootClient.command({
      query: `CREATE DATABASE IF NOT EXISTS ${dbName}`,
    });
    logger.info(`Database ${dbName} ready`);
  } finally {
    await rootClient.close();
  }
  
  // Create tables
  logger.info('Creating orders table...');
  await ch.command({ query: SCHEMA.ordersTable });
  
  logger.info('Creating daily volumes materialized view...');
  await ch.command({ query: SCHEMA.dailyVolumesMV });
  
  logger.info('Creating token stats materialized view...');
  await ch.command({ query: SCHEMA.tokenStatsMV });
  
  logger.info('Creating collection progress table...');
  await ch.command({ query: SCHEMA.collectionProgressTable });
  
  logger.info('Schema initialization complete');
}

/**
 * Order event for insertion
 */
export interface OrderEvent {
  order_id: string;
  event_type: 'created' | 'fulfilled';
  signature: string;
  slot: number;
  block_time: Date;
  
  // Created event fields
  maker?: string;
  give_token_address?: string;
  give_token_symbol?: string;
  give_amount?: bigint;
  give_amount_usd?: number;
  give_chain_id?: number;
  
  take_token_address?: string;
  take_token_symbol?: string;
  take_amount?: bigint;
  take_amount_usd?: number;
  take_chain_id?: number;
  
  receiver?: string;
  
  // Fulfilled event fields
  taker?: string;
  fulfilled_amount?: bigint;
  fulfilled_amount_usd?: number;
}

/**
 * Insert order events in batch
 */
export async function insertOrderEvents(events: OrderEvent[]): Promise<void> {
  if (events.length === 0) return;
  
  const ch = getClickHouseClient();
  
  // Convert to ClickHouse format
  const rows = events.map(e => ({
    order_id: e.order_id,
    event_type: e.event_type,
    signature: e.signature,
    slot: e.slot,
    block_time: e.block_time,
    maker: e.maker || null,
    give_token_address: e.give_token_address || null,
    give_token_symbol: e.give_token_symbol || null,
    give_amount: e.give_amount ? e.give_amount.toString() : null,
    give_amount_usd: e.give_amount_usd || null,
    give_chain_id: e.give_chain_id || null,
    take_token_address: e.take_token_address || null,
    take_token_symbol: e.take_token_symbol || null,
    take_amount: e.take_amount ? e.take_amount.toString() : null,
    take_amount_usd: e.take_amount_usd || null,
    take_chain_id: e.take_chain_id || null,
    receiver: e.receiver || null,
    taker: e.taker || null,
    fulfilled_amount: e.fulfilled_amount ? e.fulfilled_amount.toString() : null,
    fulfilled_amount_usd: e.fulfilled_amount_usd || null,
  }));
  
  await ch.insert({
    table: 'orders',
    values: rows,
    format: 'JSONEachRow',
  });
}

/**
 * Get collection progress
 */
export interface CollectionProgress {
  lastSignature: string | null;
  totalCollected: number;
}

export async function getCollectionProgress(
  programId: string,
  eventType: 'created' | 'fulfilled'
): Promise<CollectionProgress> {
  const ch = getClickHouseClient();
  
  const result = await ch.query({
    query: `
      SELECT last_signature, total_collected
      FROM collection_progress FINAL
      WHERE program_id = {programId: String} AND event_type = {eventType: String}
    `,
    query_params: { programId, eventType },
    format: 'JSONEachRow',
  });
  
  const rows = await result.json<{ last_signature: string; total_collected: number }>();
  
  if (rows.length === 0) {
    return { lastSignature: null, totalCollected: 0 };
  }
  
  return {
    lastSignature: rows[0].last_signature || null,
    totalCollected: rows[0].total_collected,
  };
}

/**
 * Update collection progress
 */
export async function updateCollectionProgress(
  programId: string,
  eventType: 'created' | 'fulfilled',
  lastSignature: string,
  totalCollected: number
): Promise<void> {
  const ch = getClickHouseClient();
  
  await ch.insert({
    table: 'collection_progress',
    values: [{
      program_id: programId,
      event_type: eventType,
      last_signature: lastSignature,
      total_collected: totalCollected,
      updated_at: new Date(),
    }],
    format: 'JSONEachRow',
  });
}

/**
 * Query: Get daily volumes
 */
export interface DailyVolume {
  date: string;
  created_count: number;
  created_volume_usd: number;
  fulfilled_count: number;
  fulfilled_volume_usd: number;
}

export async function getDailyVolumes(days: number = 30): Promise<DailyVolume[]> {
  const ch = getClickHouseClient();
  
  const result = await ch.query({
    query: `
      SELECT
        date,
        sumIf(order_count, event_type = 'created') AS created_count,
        sumIf(volume_usd, event_type = 'created') AS created_volume_usd,
        sumIf(order_count, event_type = 'fulfilled') AS fulfilled_count,
        sumIf(volume_usd, event_type = 'fulfilled') AS fulfilled_volume_usd
      FROM daily_volumes_mv
      WHERE date >= today() - {days: UInt32}
      GROUP BY date
      ORDER BY date ASC
    `,
    query_params: { days },
    format: 'JSONEachRow',
  });
  
  return result.json<DailyVolume>();
}

/**
 * Query: Get total statistics
 */
export interface TotalStats {
  total_created: number;
  total_fulfilled: number;
  total_created_volume_usd: number;
  total_fulfilled_volume_usd: number;
}

export async function getTotalStats(): Promise<TotalStats> {
  const ch = getClickHouseClient();
  
  const result = await ch.query({
    query: `
      SELECT
        countIf(event_type = 'created') AS total_created,
        countIf(event_type = 'fulfilled') AS total_fulfilled,
        sumIf(give_amount_usd, event_type = 'created') AS total_created_volume_usd,
        sumIf(fulfilled_amount_usd, event_type = 'fulfilled') AS total_fulfilled_volume_usd
      FROM orders
    `,
    format: 'JSONEachRow',
  });
  
  const rows = await result.json<TotalStats>();
  return rows[0] || {
    total_created: 0,
    total_fulfilled: 0,
    total_created_volume_usd: 0,
    total_fulfilled_volume_usd: 0,
  };
}

/**
 * Query: Get top tokens by volume
 */
export interface TokenStat {
  symbol: string;
  order_count: number;
  volume_usd: number;
}

export async function getTopTokens(limit: number = 10): Promise<TokenStat[]> {
  const ch = getClickHouseClient();
  
  const result = await ch.query({
    query: `
      SELECT
        give_token_symbol AS symbol,
        sum(order_count) AS order_count,
        sum(volume_usd) AS volume_usd
      FROM token_stats_mv
      WHERE give_token_symbol IS NOT NULL AND give_token_symbol != ''
      GROUP BY give_token_symbol
      ORDER BY volume_usd DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { limit },
    format: 'JSONEachRow',
  });
  
  return result.json<TokenStat>();
}

/**
 * Query: Get recent orders
 */
export interface RecentOrder {
  order_id: string;
  event_type: string;
  signature: string;
  block_time: string;
  give_token_symbol: string | null;
  give_amount_usd: number | null;
  take_token_symbol: string | null;
  take_amount_usd: number | null;
  maker: string | null;
  taker: string | null;
}

export async function getRecentOrders(limit: number = 50): Promise<RecentOrder[]> {
  const ch = getClickHouseClient();
  
  const result = await ch.query({
    query: `
      SELECT
        order_id,
        event_type,
        signature,
        block_time,
        give_token_symbol,
        give_amount_usd,
        take_token_symbol,
        take_amount_usd,
        maker,
        taker
      FROM orders
      ORDER BY block_time DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { limit },
    format: 'JSONEachRow',
  });
  
  return result.json<RecentOrder>();
}

/**
 * Check if order already exists (for deduplication)
 */
export async function orderEventExists(signature: string, eventType: 'created' | 'fulfilled'): Promise<boolean> {
  const ch = getClickHouseClient();
  
  const result = await ch.query({
    query: `
      SELECT 1
      FROM orders
      WHERE signature = {signature: String} AND event_type = {eventType: String}
      LIMIT 1
    `,
    query_params: { signature, eventType },
    format: 'JSONEachRow',
  });
  
  const rows = await result.json();
  return rows.length > 0;
}
