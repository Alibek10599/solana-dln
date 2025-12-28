/**
 * ClickHouse Database Client and Schema
 * 
 * Optimized for time-series analytics on DLN order events
 * with proper deduplication using ReplacingMergeTree.
 */

import { createClient, ClickHouseClient } from '@clickhouse/client';
import { createChildLogger } from '../utils/logger.js';
import { config } from '../config/index.js';

const logger = createChildLogger('clickhouse');

let client: ClickHouseClient | null = null;

export function getClickHouseClient(): ClickHouseClient {
  if (!client) {
    logger.info(
      { url: config.clickhouse.url, database: config.clickhouse.database },
      'Initializing ClickHouse client'
    );

    client = createClient({
      url: config.clickhouse.url,
      database: config.clickhouse.database,
      username: config.clickhouse.user,
      password: config.clickhouse.password,
      clickhouse_settings: {
        async_insert: config.clickhouse.asyncInsert ? 1 : 0,
        wait_for_async_insert: config.clickhouse.waitForAsyncInsert ? 1 : 0,
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
  ordersTable: `
    CREATE TABLE IF NOT EXISTS orders (
      order_id String,
      event_type Enum8('created' = 1, 'fulfilled' = 2),
      signature String,
      slot UInt64,
      block_time DateTime,
      
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
      taker Nullable(String),
      fulfilled_amount Nullable(UInt128),
      fulfilled_amount_usd Nullable(Float64),
      
      created_at DateTime DEFAULT now(),
      _version UInt64 DEFAULT toUnixTimestamp(now())
    )
    ENGINE = ReplacingMergeTree(_version)
    PARTITION BY toYYYYMM(block_time)
    ORDER BY (signature, event_type)
    SETTINGS index_granularity = 8192
  `,

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
  
  logger.info('Creating orders table...');
  await ch.command({ query: SCHEMA.ordersTable });
  
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
  taker?: string;
  fulfilled_amount?: bigint;
  fulfilled_amount_usd?: number;
}

/**
 * Insert order events in batch
 */
export async function insertOrderEvents(events: OrderEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  
  const ch = getClickHouseClient();
  const MAX_UINT64 = 18446744073709551615n;

  const rows = events.map(e => ({
    order_id: e.order_id,
    event_type: e.event_type,
    signature: e.signature,
    slot: e.slot,
    block_time: Math.floor(e.block_time.getTime() / 1000),
    maker: e.maker || null,
    give_token_address: e.give_token_address || null,
    give_token_symbol: e.give_token_symbol || null,
    give_amount: e.give_amount ? Number(e.give_amount) : null,
    give_amount_usd: e.give_amount_usd || null,
    give_chain_id: (e.give_chain_id && e.give_chain_id <= MAX_UINT64) ? Number(e.give_chain_id) : null,
    take_token_address: e.take_token_address || null,
    take_token_symbol: e.take_token_symbol || null,
    take_amount: e.take_amount ? Number(e.take_amount) : null,
    take_amount_usd: e.take_amount_usd || null,
    take_chain_id: (e.take_chain_id && e.take_chain_id <= MAX_UINT64) ? Number(e.take_chain_id) : null,
    receiver: e.receiver || null,
    taker: e.taker || null,
    fulfilled_amount: e.fulfilled_amount ? Number(e.fulfilled_amount) : null,
    fulfilled_amount_usd: e.fulfilled_amount_usd || null,
  }));
  
  await ch.insert({
    table: 'orders',
    values: rows,
    format: 'JSONEachRow',
    clickhouse_settings: {
      input_format_skip_unknown_fields: 1,
    },
  });
  
  return events.length;
}

/**
 * Insert order events with explicit deduplication check
 */
export async function insertOrderEventsDeduped(events: OrderEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  
  const ch = getClickHouseClient();
  
  const signatures = events.map(e => e.signature);
  const existingResult = await ch.query({
    query: `
      SELECT signature, event_type
      FROM orders FINAL
      WHERE signature IN ({signatures: Array(String)})
    `,
    query_params: { signatures },
    format: 'JSONEachRow',
  });
  
  const existingRows = await existingResult.json<{ signature: string; event_type: string }>();
  const existingSet = new Set(
    existingRows.map(r => `${r.signature}:${r.event_type}`)
  );
  
  const newEvents = events.filter(
    e => !existingSet.has(`${e.signature}:${e.event_type}`)
  );
  
  if (newEvents.length === 0) {
    return 0;
  }
  
  await insertOrderEvents(newEvents);
  return newEvents.length;
}

/**
 * Collection progress
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
  
  try {
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
  } catch (error) {
    logger.error({ error }, 'Failed to get collection progress');
    return { lastSignature: null, totalCollected: 0 };
  }
}

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
      updated_at: Math.floor(Date.now() / 1000),
    }],
    format: 'JSONEachRow',
  });
}

/**
 * Get unique order count
 */
export async function getUniqueOrderCount(
  eventType?: 'created' | 'fulfilled'
): Promise<number> {
  const ch = getClickHouseClient();
  
  try {
    const whereClause = eventType 
      ? `WHERE event_type = {eventType: String}` 
      : '';
    
    const result = await ch.query({
      query: `
        SELECT count() as cnt
        FROM orders FINAL
        ${whereClause}
      `,
      query_params: eventType ? { eventType } : {},
      format: 'JSONEachRow',
    });
    
    const rows = await result.json<{ cnt: string }>();
    return parseInt(rows[0]?.cnt || '0', 10);
  } catch (error) {
    logger.error({ error }, 'Failed to get unique order count');
    return 0;
  }
}

// =============================================================================
// DASHBOARD QUERIES - Simple and reliable
// =============================================================================

export interface DailyVolume {
  date: string;
  created_count: number;
  created_volume_usd: number;
  fulfilled_count: number;
  fulfilled_volume_usd: number;
}

export async function getDailyVolumes(days: number = 30): Promise<DailyVolume[]> {
  const ch = getClickHouseClient();
  
  try {
    // Simple query - get counts and volumes per day per event type
    const result = await ch.query({
      query: `
        SELECT
          toDate(block_time) AS date,
          countIf(event_type = 'created') AS created_count,
          coalesce(sumIf(take_amount_usd, event_type = 'created'), 0) AS created_volume_usd,
          countIf(event_type = 'fulfilled') AS fulfilled_count,
          coalesce(sumIf(take_amount_usd, event_type = 'fulfilled'), 0) AS fulfilled_volume_usd
        FROM orders FINAL
        WHERE block_time >= today() - toIntervalDay({days: UInt32})
        GROUP BY date
        ORDER BY date ASC
      `,
      query_params: { days },
      format: 'JSONEachRow',
    });
    
    return result.json<DailyVolume>();
  } catch (error) {
    logger.error({ error }, 'Failed to get daily volumes');
    return [];
  }
}

export interface TotalStats {
  total_created: number;
  total_fulfilled: number;
  total_created_volume_usd: number;
  total_fulfilled_volume_usd: number;
}

export async function getTotalStats(): Promise<TotalStats> {
  const ch = getClickHouseClient();

  try {
    const result = await ch.query({
      query: `
        SELECT
          countIf(event_type = 'created') AS total_created,
          countIf(event_type = 'fulfilled') AS total_fulfilled,
          coalesce(sumIf(take_amount_usd, event_type = 'created'), 0) AS total_created_volume_usd,
          coalesce(sumIf(take_amount_usd, event_type = 'fulfilled'), 0) AS total_fulfilled_volume_usd
        FROM orders FINAL
      `,
      format: 'JSONEachRow',
    });

    const rows = await result.json<TotalStats>();
    const row = rows[0];
    
    return {
      total_created: Number(row?.total_created) || 0,
      total_fulfilled: Number(row?.total_fulfilled) || 0,
      total_created_volume_usd: Number(row?.total_created_volume_usd) || 0,
      total_fulfilled_volume_usd: Number(row?.total_fulfilled_volume_usd) || 0,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get total stats');
    return {
      total_created: 0,
      total_fulfilled: 0,
      total_created_volume_usd: 0,
      total_fulfilled_volume_usd: 0,
    };
  }
}

export interface TokenStat {
  symbol: string;
  order_count: number;
  volume_usd: number;
}

export async function getTopTokens(limit: number = 10): Promise<TokenStat[]> {
  const ch = getClickHouseClient();

  try {
    const result = await ch.query({
      query: `
        SELECT
          give_token_symbol AS symbol,
          count() AS order_count,
          coalesce(sum(give_amount_usd), 0) AS volume_usd
        FROM orders FINAL
        WHERE event_type = 'created' 
          AND give_token_symbol IS NOT NULL 
          AND give_token_symbol != ''
        GROUP BY symbol
        ORDER BY volume_usd DESC
        LIMIT {limit: UInt32}
      `,
      query_params: { limit },
      format: 'JSONEachRow',
    });

    return result.json<TokenStat>();
  } catch (error) {
    logger.error({ error }, 'Failed to get top tokens');
    return [];
  }
}

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
  
  try {
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
        FROM orders FINAL
        ORDER BY block_time DESC
        LIMIT {limit: UInt32}
      `,
      query_params: { limit },
      format: 'JSONEachRow',
    });
    
    return result.json<RecentOrder>();
  } catch (error) {
    logger.error({ error }, 'Failed to get recent orders');
    return [];
  }
}

export async function orderEventExists(
  signature: string, 
  eventType: 'created' | 'fulfilled'
): Promise<boolean> {
  const ch = getClickHouseClient();
  
  try {
    const result = await ch.query({
      query: `
        SELECT 1
        FROM orders FINAL
        WHERE signature = {signature: String} AND event_type = {eventType: String}
        LIMIT 1
      `,
      query_params: { signature, eventType },
      format: 'JSONEachRow',
    });
    
    const rows = await result.json();
    return rows.length > 0;
  } catch (error) {
    return false;
  }
}

export async function optimizeOrdersTable(): Promise<void> {
  const ch = getClickHouseClient();
  
  logger.info('Starting table optimization...');
  await ch.command({
    query: 'OPTIMIZE TABLE orders FINAL',
  });
  logger.info('Table optimization complete');
}

// =============================================================================
// ADVANCED ANALYTICS
// =============================================================================

/**
 * Chain breakdown - orders by source/destination chain
 */
export interface ChainStats {
  chain_id: number;
  chain_name: string;
  order_count: number;
  volume_usd: number;
}

export async function getChainBreakdown(): Promise<{ source: ChainStats[]; destination: ChainStats[] }> {
  const ch = getClickHouseClient();
  
  const chainNames: Record<number, string> = {
    1: 'Ethereum',
    10: 'Optimism',
    56: 'BSC',
    100: 'Gnosis',
    137: 'Polygon',
    250: 'Fantom',
    8453: 'Base',
    42161: 'Arbitrum',
    43114: 'Avalanche',
    7565164: 'Solana',
  };
  
  try {
    const sourceResult = await ch.query({
      query: `
        SELECT
          give_chain_id AS chain_id,
          count() AS order_count,
          coalesce(sum(give_amount_usd), 0) AS volume_usd
        FROM orders FINAL
        WHERE event_type = 'created' AND give_chain_id IS NOT NULL
        GROUP BY chain_id
        ORDER BY order_count DESC
      `,
      format: 'JSONEachRow',
    });
    
    const destResult = await ch.query({
      query: `
        SELECT
          take_chain_id AS chain_id,
          count() AS order_count,
          coalesce(sum(take_amount_usd), 0) AS volume_usd
        FROM orders FINAL
        WHERE event_type = 'created' AND take_chain_id IS NOT NULL
        GROUP BY chain_id
        ORDER BY order_count DESC
      `,
      format: 'JSONEachRow',
    });
    
    const sourceData = await sourceResult.json<{ chain_id: number; order_count: number; volume_usd: number }>();
    const destData = await destResult.json<{ chain_id: number; order_count: number; volume_usd: number }>();
    
    return {
      source: sourceData.map(s => ({
        ...s,
        chain_id: Number(s.chain_id),
        chain_name: chainNames[Number(s.chain_id)] || `Chain ${s.chain_id}`,
        order_count: Number(s.order_count),
        volume_usd: Number(s.volume_usd),
      })),
      destination: destData.map(d => ({
        ...d,
        chain_id: Number(d.chain_id),
        chain_name: chainNames[Number(d.chain_id)] || `Chain ${d.chain_id}`,
        order_count: Number(d.order_count),
        volume_usd: Number(d.volume_usd),
      })),
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get chain breakdown');
    return { source: [], destination: [] };
  }
}

/**
 * Time-filtered stats
 */
export interface TimeFilteredStats {
  total_created: number;
  total_fulfilled: number;
  total_volume_usd: number;
  fill_rate: number;
  avg_order_size: number;
  median_order_size: number;
}

export async function getStatsForPeriod(hours: number): Promise<TimeFilteredStats> {
  const ch = getClickHouseClient();
  
  try {
    const result = await ch.query({
      query: `
        SELECT
          countIf(event_type = 'created') AS total_created,
          countIf(event_type = 'fulfilled') AS total_fulfilled,
          coalesce(sumIf(take_amount_usd, event_type = 'created'), 0) AS total_volume_usd,
          coalesce(avgIf(take_amount_usd, event_type = 'created' AND take_amount_usd > 0), 0) AS avg_order_size,
          coalesce(medianIf(take_amount_usd, event_type = 'created' AND take_amount_usd > 0), 0) AS median_order_size
        FROM orders FINAL
        WHERE block_time >= now() - toIntervalHour({hours: UInt32})
      `,
      query_params: { hours },
      format: 'JSONEachRow',
    });
    
    const rows = await result.json<{
      total_created: number;
      total_fulfilled: number;
      total_volume_usd: number;
      avg_order_size: number;
      median_order_size: number;
    }>();
    
    const row = rows[0] || {};
    const created = Number(row.total_created) || 0;
    const fulfilled = Number(row.total_fulfilled) || 0;
    
    return {
      total_created: created,
      total_fulfilled: fulfilled,
      total_volume_usd: Number(row.total_volume_usd) || 0,
      fill_rate: created > 0 ? (fulfilled / created) * 100 : 0,
      avg_order_size: Number(row.avg_order_size) || 0,
      median_order_size: Number(row.median_order_size) || 0,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get stats for period');
    return {
      total_created: 0,
      total_fulfilled: 0,
      total_volume_usd: 0,
      fill_rate: 0,
      avg_order_size: 0,
      median_order_size: 0,
    };
  }
}

/**
 * Top makers/takers leaderboard
 */
export interface AddressStats {
  address: string;
  order_count: number;
  volume_usd: number;
}

export async function getTopMakers(limit: number = 10): Promise<AddressStats[]> {
  const ch = getClickHouseClient();
  
  try {
    const result = await ch.query({
      query: `
        SELECT
          maker AS address,
          count() AS order_count,
          coalesce(sum(give_amount_usd), 0) AS volume_usd
        FROM orders FINAL
        WHERE event_type = 'created' AND maker IS NOT NULL AND maker != ''
        GROUP BY maker
        ORDER BY volume_usd DESC
        LIMIT {limit: UInt32}
      `,
      query_params: { limit },
      format: 'JSONEachRow',
    });
    
    return result.json<AddressStats>();
  } catch (error) {
    logger.error({ error }, 'Failed to get top makers');
    return [];
  }
}

export async function getTopTakers(limit: number = 10): Promise<AddressStats[]> {
  const ch = getClickHouseClient();
  
  try {
    const result = await ch.query({
      query: `
        SELECT
          taker AS address,
          count() AS order_count,
          coalesce(sum(fulfilled_amount_usd), 0) AS volume_usd
        FROM orders FINAL
        WHERE event_type = 'fulfilled' AND taker IS NOT NULL AND taker != ''
        GROUP BY taker
        ORDER BY order_count DESC
        LIMIT {limit: UInt32}
      `,
      query_params: { limit },
      format: 'JSONEachRow',
    });
    
    return result.json<AddressStats>();
  } catch (error) {
    logger.error({ error }, 'Failed to get top takers');
    return [];
  }
}

/**
 * Token pair heatmap data
 */
export interface TokenPairStats {
  give_token: string;
  take_token: string;
  order_count: number;
  volume_usd: number;
}

export async function getTokenPairs(limit: number = 20): Promise<TokenPairStats[]> {
  const ch = getClickHouseClient();
  
  try {
    const result = await ch.query({
      query: `
        SELECT
          give_token_symbol AS give_token,
          take_token_symbol AS take_token,
          count() AS order_count,
          coalesce(sum(give_amount_usd), 0) AS volume_usd
        FROM orders FINAL
        WHERE event_type = 'created' 
          AND give_token_symbol IS NOT NULL AND give_token_symbol != ''
          AND take_token_symbol IS NOT NULL AND take_token_symbol != ''
        GROUP BY give_token, take_token
        ORDER BY order_count DESC
        LIMIT {limit: UInt32}
      `,
      query_params: { limit },
      format: 'JSONEachRow',
    });
    
    return result.json<TokenPairStats>();
  } catch (error) {
    logger.error({ error }, 'Failed to get token pairs');
    return [];
  }
}

/**
 * Order lifecycle - find matching created/fulfilled orders
 */
export interface OrderLifecycle {
  order_id: string;
  created_at: string | null;
  created_signature: string | null;
  fulfilled_at: string | null;
  fulfilled_signature: string | null;
  maker: string | null;
  taker: string | null;
  give_token: string | null;
  take_token: string | null;
  amount_usd: number | null;
  time_to_fill_seconds: number | null;
}

export async function getOrderLifecycle(orderId: string): Promise<OrderLifecycle | null> {
  const ch = getClickHouseClient();
  
  try {
    const result = await ch.query({
      query: `
        SELECT
          order_id,
          minIf(block_time, event_type = 'created') AS created_at,
          argMinIf(signature, block_time, event_type = 'created') AS created_signature,
          minIf(block_time, event_type = 'fulfilled') AS fulfilled_at,
          argMinIf(signature, block_time, event_type = 'fulfilled') AS fulfilled_signature,
          anyIf(maker, event_type = 'created') AS maker,
          anyIf(taker, event_type = 'fulfilled') AS taker,
          anyIf(give_token_symbol, event_type = 'created') AS give_token,
          anyIf(take_token_symbol, event_type = 'created') AS take_token,
          anyIf(take_amount_usd, event_type = 'created') AS amount_usd
        FROM orders FINAL
        WHERE order_id = {orderId: String}
        GROUP BY order_id
      `,
      query_params: { orderId },
      format: 'JSONEachRow',
    });
    
    const rows = await result.json<any>();
    if (rows.length === 0) return null;
    
    const row = rows[0];
    const createdAt = row.created_at ? new Date(row.created_at) : null;
    const fulfilledAt = row.fulfilled_at ? new Date(row.fulfilled_at) : null;
    
    return {
      order_id: row.order_id,
      created_at: row.created_at,
      created_signature: row.created_signature,
      fulfilled_at: row.fulfilled_at,
      fulfilled_signature: row.fulfilled_signature,
      maker: row.maker,
      taker: row.taker,
      give_token: row.give_token,
      take_token: row.take_token,
      amount_usd: Number(row.amount_usd) || null,
      time_to_fill_seconds: createdAt && fulfilledAt 
        ? Math.floor((fulfilledAt.getTime() - createdAt.getTime()) / 1000)
        : null,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get order lifecycle');
    return null;
  }
}

/**
 * Recent fulfilled orders with fill times
 */
export async function getRecentFills(limit: number = 20): Promise<OrderLifecycle[]> {
  const ch = getClickHouseClient();
  
  try {
    const result = await ch.query({
      query: `
        SELECT
          order_id,
          minIf(block_time, event_type = 'created') AS created_at,
          argMinIf(signature, block_time, event_type = 'created') AS created_signature,
          minIf(block_time, event_type = 'fulfilled') AS fulfilled_at,
          argMinIf(signature, block_time, event_type = 'fulfilled') AS fulfilled_signature,
          anyIf(maker, event_type = 'created') AS maker,
          anyIf(taker, event_type = 'fulfilled') AS taker,
          anyIf(give_token_symbol, event_type = 'created') AS give_token,
          anyIf(take_token_symbol, event_type = 'created') AS take_token,
          anyIf(take_amount_usd, event_type = 'created') AS amount_usd
        FROM orders FINAL
        GROUP BY order_id
        HAVING fulfilled_at IS NOT NULL AND fulfilled_at != '1970-01-01 00:00:00'
        ORDER BY fulfilled_at DESC
        LIMIT {limit: UInt32}
      `,
      query_params: { limit },
      format: 'JSONEachRow',
    });
    
    const rows = await result.json<any>();
    
    return rows.map((row: any) => {
      const createdAt = row.created_at ? new Date(row.created_at) : null;
      const fulfilledAt = row.fulfilled_at ? new Date(row.fulfilled_at) : null;
      
      return {
        order_id: row.order_id,
        created_at: row.created_at,
        created_signature: row.created_signature,
        fulfilled_at: row.fulfilled_at,
        fulfilled_signature: row.fulfilled_signature,
        maker: row.maker,
        taker: row.taker,
        give_token: row.give_token,
        take_token: row.take_token,
        amount_usd: Number(row.amount_usd) || null,
        time_to_fill_seconds: createdAt && fulfilledAt 
          ? Math.floor((fulfilledAt.getTime() - createdAt.getTime()) / 1000)
          : null,
      };
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get recent fills');
    return [];
  }
}
