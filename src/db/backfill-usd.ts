/**
 * USD Backfill Script
 * 
 * This script backfills USD values for fulfilled orders by:
 * 1. Joining fulfilled orders with their created counterparts
 * 2. Using the created order's USD values as the fulfilled values
 * 
 * Run this after collection is complete:
 *   docker compose exec api node dist/db/backfill-usd.js
 */

import 'dotenv/config';
import { createClient } from '@clickhouse/client';
import { logger } from '../utils/logger.js';

async function backfillFulfilledUsd(): Promise<void> {
  const client = createClient({
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DATABASE || 'dln_dashboard',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
  });

  try {
    logger.info('Starting USD backfill for fulfilled orders...');

    // First, let's check current state
    const beforeResult = await client.query({
      query: `
        SELECT 
          event_type,
          count() as cnt,
          sum(coalesce(take_amount_usd, fulfilled_amount_usd, 0)) as total_usd
        FROM orders FINAL
        GROUP BY event_type
      `,
      format: 'JSONEachRow',
    });
    
    const beforeStats = await beforeResult.json<{event_type: string; cnt: string; total_usd: string}>();
    logger.info({ stats: beforeStats }, 'Before backfill');

    // Strategy 1: Update fulfilled orders with USD values from matching created orders
    // This creates a new version that will be merged by ReplacingMergeTree
    logger.info('Backfilling USD from created orders to fulfilled orders...');
    
    await client.command({
      query: `
        INSERT INTO orders
        SELECT
          f.order_id,
          f.event_type,
          f.signature,
          f.slot,
          f.block_time,
          f.maker,
          c.give_token_address,
          c.give_token_symbol,
          c.give_amount,
          c.give_amount_usd,
          c.give_chain_id,
          c.take_token_address,
          c.take_token_symbol,
          c.take_amount,
          c.take_amount_usd,
          c.take_chain_id,
          c.receiver,
          f.taker,
          c.take_amount as fulfilled_amount,
          c.take_amount_usd as fulfilled_amount_usd,
          now() as created_at,
          toUnixTimestamp(now()) + 1 as _version
        FROM orders FINAL AS f
        INNER JOIN (
          SELECT *
          FROM orders FINAL
          WHERE event_type = 'created'
        ) AS c ON f.order_id = c.order_id
        WHERE f.event_type = 'fulfilled'
          AND f.fulfilled_amount_usd IS NULL
      `,
    });
    
    logger.info('Backfill insert complete');

    // Optimize to merge duplicates
    logger.info('Optimizing table...');
    await client.command({
      query: 'OPTIMIZE TABLE orders FINAL',
    });

    // Check results
    const afterResult = await client.query({
      query: `
        SELECT 
          event_type,
          count() as cnt,
          sum(coalesce(take_amount_usd, fulfilled_amount_usd, 0)) as total_usd,
          countIf(fulfilled_amount_usd IS NOT NULL AND event_type = 'fulfilled') as fulfilled_with_usd
        FROM orders FINAL
        GROUP BY event_type
      `,
      format: 'JSONEachRow',
    });
    
    const afterStats = await afterResult.json<{event_type: string; cnt: string; total_usd: string; fulfilled_with_usd: string}>();
    logger.info({ stats: afterStats }, 'After backfill');

    // Also update the daily_volumes_mv by recreating it
    logger.info('Recreating materialized views...');
    
    // Drop and recreate daily volumes MV
    await client.command({ query: 'DROP TABLE IF EXISTS daily_volumes_mv' });
    await client.command({
      query: `
        CREATE MATERIALIZED VIEW daily_volumes_mv
        ENGINE = SummingMergeTree()
        PARTITION BY toYYYYMM(date)
        ORDER BY (date, event_type)
        POPULATE
        AS SELECT
          toDate(block_time) AS date,
          event_type,
          count() AS order_count,
          sum(coalesce(take_amount_usd, fulfilled_amount_usd, 0)) AS volume_usd
        FROM orders FINAL
        GROUP BY date, event_type
      `,
    });

    // Drop and recreate token stats MV
    await client.command({ query: 'DROP TABLE IF EXISTS token_stats_mv' });
    await client.command({
      query: `
        CREATE MATERIALIZED VIEW token_stats_mv
        ENGINE = SummingMergeTree()
        PARTITION BY tuple()
        ORDER BY (symbol)
        POPULATE
        AS SELECT
          assumeNotNull(give_token_symbol) AS symbol,
          count() AS order_count,
          sum(give_amount_usd) AS volume_usd
        FROM orders FINAL
        WHERE event_type = 'created' AND give_token_symbol IS NOT NULL
        GROUP BY symbol
      `,
    });

    logger.info('Materialized views recreated with POPULATE');

    // Final verification
    const finalResult = await client.query({
      query: `
        SELECT 
          date,
          sumIf(volume_usd, event_type = 'created') as created_volume,
          sumIf(volume_usd, event_type = 'fulfilled') as fulfilled_volume
        FROM daily_volumes_mv
        GROUP BY date
        ORDER BY date DESC
        LIMIT 10
      `,
      format: 'JSONEachRow',
    });
    
    const dailyVolumes = await finalResult.json<{date: string; created_volume: string; fulfilled_volume: string}>();
    logger.info({ recentDays: dailyVolumes }, 'Recent daily volumes after backfill');

    logger.info('USD backfill complete!');

  } catch (error) {
    logger.error({ error }, 'Backfill failed');
    throw error;
  } finally {
    await client.close();
  }
}

// Run backfill
backfillFulfilledUsd()
  .then(() => {
    logger.info('Backfill script finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    logger.error({ error }, 'Backfill script failed');
    process.exit(1);
  });
