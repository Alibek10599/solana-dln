/**
 * Dashboard API Server
 * 
 * Provides REST endpoints and Server-Sent Events (SSE) for real-time updates
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import {
  getClickHouseClient,
  closeClickHouse,
  getDailyVolumes,
  getTotalStats,
  getTopTokens,
  getRecentOrders,
  getCollectionProgress,
} from '../db/clickhouse.js';
import { DLN_SOURCE_PROGRAM_ID, DLN_DESTINATION_PROGRAM_ID } from '../constants.js';
import { logger } from '../utils/logger.js';
import { getRpcPool } from '../rpc/index.js';
import { getParseStats, getUnknownTokens } from '../parser/transaction.js';

const app = express();
const PORT = parseInt(process.env.API_PORT || '3001');

// =============================================================================
// SSE Client Management
// =============================================================================

interface SSEClient {
  id: string;
  res: Response;
}

const sseClients: Map<string, SSEClient> = new Map();
let sseUpdateInterval: ReturnType<typeof setInterval> | null = null;

function generateClientId(): string {
  return `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function broadcastToClients(event: string, data: any): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  
  for (const [id, client] of sseClients) {
    try {
      client.res.write(message);
    } catch (error) {
      logger.debug({ clientId: id }, 'Failed to send to client, removing');
      sseClients.delete(id);
    }
  }
}

async function fetchAndBroadcastUpdates(): Promise<void> {
  if (sseClients.size === 0) return;
  
  try {
    const [stats, createdProgress, fulfilledProgress, recentOrders] = await Promise.all([
      getTotalStats(),
      getCollectionProgress(DLN_SOURCE_PROGRAM_ID.toBase58(), 'created'),
      getCollectionProgress(DLN_DESTINATION_PROGRAM_ID.toBase58(), 'fulfilled'),
      getRecentOrders(10),
    ]);
    
    const poolStats = getRpcPool().getStats();
    const parseStats = getParseStats();
    
    broadcastToClients('update', {
      stats: {
        totalOrdersCreated: stats.total_created,
        totalOrdersFulfilled: stats.total_fulfilled,
        totalVolumeCreatedUsd: Number(stats.total_created_volume_usd) || 0,
        totalVolumeFulfilledUsd: Number(stats.total_fulfilled_volume_usd) || 0,
      },
      collectionProgress: {
        created: createdProgress.totalCollected,
        fulfilled: fulfilledProgress.totalCollected,
      },
      recentOrders: recentOrders.slice(0, 5).map(o => ({
        orderId: o.order_id,
        eventType: o.event_type,
        signature: o.signature,
        blockTime: o.block_time,
        giveTokenSymbol: o.give_token_symbol,
        takeAmountUsd: o.take_amount_usd,
      })),
      rpcPool: {
        healthyEndpoints: poolStats.healthyEndpoints,
        totalEndpoints: poolStats.totalEndpoints,
        totalRequests: poolStats.totalRequests,
      },
      parseStats: parseStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch SSE updates');
  }
}

function startSSEUpdates(): void {
  if (sseUpdateInterval) return;
  
  sseUpdateInterval = setInterval(fetchAndBroadcastUpdates, 2000);
  logger.info('SSE updates started');
}

function stopSSEUpdates(): void {
  if (sseUpdateInterval) {
    clearInterval(sseUpdateInterval);
    sseUpdateInterval = null;
    logger.info('SSE updates stopped');
  }
}

// =============================================================================
// Middleware
// =============================================================================

app.use(cors());
app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/api/events') {
    return next();
  }
  
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${Date.now() - start}ms`,
    }, 'Request');
  });
  next();
});

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

// =============================================================================
// SSE Endpoint
// =============================================================================

app.get('/api/events', (req: Request, res: Response) => {
  const clientId = generateClientId();
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  
  res.write(`event: connected\ndata: {"clientId": "${clientId}"}\n\n`);
  
  sseClients.set(clientId, { id: clientId, res });
  logger.info({ clientId, totalClients: sseClients.size }, 'SSE client connected');
  
  if (sseClients.size === 1) {
    startSSEUpdates();
  }
  
  fetchAndBroadcastUpdates();
  
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);
  
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
    logger.info({ clientId, totalClients: sseClients.size }, 'SSE client disconnected');
    
    if (sseClients.size === 0) {
      stopSSEUpdates();
    }
  });
});

// =============================================================================
// REST Endpoints
// =============================================================================

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/stats', asyncHandler(async (req: Request, res: Response) => {
  const stats = await getTotalStats();

  res.json({
    success: true,
    data: {
      totalOrdersCreated: stats.total_created,
      totalOrdersFulfilled: stats.total_fulfilled,
      totalVolumeCreatedUsd: Number(stats.total_created_volume_usd) || 0,
      totalVolumeFulfilledUsd: Number(stats.total_fulfilled_volume_usd) || 0,
    },
  });
}));

app.get('/api/daily-volumes', asyncHandler(async (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 30;
  const volumes = await getDailyVolumes(Math.min(days, 365));
  
  res.json({
    success: true,
    data: volumes.map(v => ({
      date: v.date,
      createdCount: Number(v.created_count),
      createdVolumeUsd: Number(v.created_volume_usd) || 0,
      fulfilledCount: Number(v.fulfilled_count),
      fulfilledVolumeUsd: Number(v.fulfilled_volume_usd) || 0,
    })),
  });
}));

app.get('/api/top-tokens', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 10;
  const tokens = await getTopTokens(Math.min(limit, 50));
  
  res.json({
    success: true,
    data: tokens.map(t => ({
      symbol: t.symbol,
      orderCount: Number(t.order_count),
      volumeUsd: Number(t.volume_usd) || 0,
    })),
  });
}));

app.get('/api/recent-orders', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const orders = await getRecentOrders(Math.min(limit, 200));
  
  res.json({
    success: true,
    data: orders.map(o => ({
      orderId: o.order_id,
      eventType: o.event_type,
      signature: o.signature,
      blockTime: o.block_time,
      giveTokenSymbol: o.give_token_symbol,
      giveAmountUsd: o.give_amount_usd,
      takeTokenSymbol: o.take_token_symbol,
      takeAmountUsd: o.take_amount_usd,
      maker: o.maker,
      taker: o.taker,
    })),
  });
}));

app.get('/api/collection-progress', asyncHandler(async (req: Request, res: Response) => {
  const [createdProgress, fulfilledProgress] = await Promise.all([
    getCollectionProgress(DLN_SOURCE_PROGRAM_ID.toBase58(), 'created'),
    getCollectionProgress(DLN_DESTINATION_PROGRAM_ID.toBase58(), 'fulfilled'),
  ]);
  
  res.json({
    success: true,
    data: {
      created: {
        totalCollected: createdProgress.totalCollected,
        lastSignature: createdProgress.lastSignature,
      },
      fulfilled: {
        totalCollected: fulfilledProgress.totalCollected,
        lastSignature: fulfilledProgress.lastSignature,
      },
    },
  });
}));

app.get('/api/metrics', asyncHandler(async (req: Request, res: Response) => {
  const poolStats = getRpcPool().getStats();
  const parseStats = getParseStats();
  
  res.json({
    success: true,
    data: {
      rpcPool: poolStats,
      parser: parseStats,
      timestamp: new Date().toISOString(),
    },
  });
}));

/**
 * Debug endpoint - check USD calculation data and unknown tokens
 */
app.get('/api/debug/usd', asyncHandler(async (req: Request, res: Response) => {
  const ch = getClickHouseClient();
  
  // Check token addresses in database
  const tokenAddresses = await ch.query({
    query: `
      SELECT 
        give_token_address,
        give_token_symbol,
        count() as cnt,
        sum(give_amount_usd) as total_usd
      FROM orders FINAL
      WHERE event_type = 'created'
      GROUP BY give_token_address, give_token_symbol
      ORDER BY cnt DESC
      LIMIT 20
    `,
    format: 'JSONEachRow',
  });
  
  const tokens = await tokenAddresses.json();
  
  // Get sample of orders with and without USD
  const sampleWithUsd = await ch.query({
    query: `
      SELECT order_id, give_token_address, give_token_symbol, give_amount, give_amount_usd
      FROM orders FINAL
      WHERE event_type = 'created' AND give_amount_usd > 0
      LIMIT 5
    `,
    format: 'JSONEachRow',
  });
  
  const sampleWithoutUsd = await ch.query({
    query: `
      SELECT order_id, give_token_address, give_token_symbol, give_amount, give_amount_usd
      FROM orders FINAL
      WHERE event_type = 'created' AND (give_amount_usd IS NULL OR give_amount_usd = 0)
      LIMIT 5
    `,
    format: 'JSONEachRow',
  });

  // Get unknown tokens from parser
  const unknownTokens = getUnknownTokens();
  const unknownTokensList = Array.from(unknownTokens.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([address, count]) => ({ address, count }));
  
  res.json({
    success: true,
    data: {
      tokenAddresses: tokens,
      sampleWithUsd: await sampleWithUsd.json(),
      sampleWithoutUsd: await sampleWithoutUsd.json(),
      unknownTokens: unknownTokensList,
    },
  });
}));

app.get('/metrics', asyncHandler(async (req: Request, res: Response) => {
  const poolStats = getRpcPool().getStats();
  const parseStats = getParseStats();
  const [createdProgress, fulfilledProgress] = await Promise.all([
    getCollectionProgress(DLN_SOURCE_PROGRAM_ID.toBase58(), 'created'),
    getCollectionProgress(DLN_DESTINATION_PROGRAM_ID.toBase58(), 'fulfilled'),
  ]);
  
  const lines: string[] = [
    '# HELP dln_orders_total Total orders in database',
    '# TYPE dln_orders_total gauge',
    `dln_orders_total{type="created"} ${createdProgress.totalCollected}`,
    `dln_orders_total{type="fulfilled"} ${fulfilledProgress.totalCollected}`,
    '',
    '# HELP dln_parse_total Parse statistics',
    '# TYPE dln_parse_total counter',
    `dln_parse_total{result="success"} ${parseStats.success}`,
    `dln_parse_total{result="failed"} ${parseStats.failed}`,
    `dln_parse_total{result="no_events"} ${parseStats.noEvents}`,
    '',
    '# HELP dln_rpc_requests_total Total RPC requests',
    '# TYPE dln_rpc_requests_total counter',
    `dln_rpc_requests_total ${poolStats.totalRequests}`,
    '',
    '# HELP dln_rpc_failures_total Total RPC failures',
    '# TYPE dln_rpc_failures_total counter',
    `dln_rpc_failures_total ${poolStats.totalFailures}`,
    '',
    '# HELP dln_rpc_healthy_endpoints Number of healthy RPC endpoints',
    '# TYPE dln_rpc_healthy_endpoints gauge',
    `dln_rpc_healthy_endpoints ${poolStats.healthyEndpoints}`,
    '',
    '# HELP dln_rpc_circuit_state Circuit breaker state (0=closed, 1=open, 0.5=half-open)',
    '# TYPE dln_rpc_circuit_state gauge',
  ];
  
  for (const [name, stats] of Object.entries(poolStats.endpoints)) {
    const stateValue = stats.circuitState === 'open' ? 1 : stats.circuitState === 'half-open' ? 0.5 : 0;
    lines.push(`dln_rpc_circuit_state{endpoint="${name}"} ${stateValue}`);
  }
  
  lines.push('');
  lines.push('# HELP dln_rpc_current_rps Current requests per second per endpoint');
  lines.push('# TYPE dln_rpc_current_rps gauge');
  
  for (const [name, stats] of Object.entries(poolStats.endpoints)) {
    lines.push(`dln_rpc_current_rps{endpoint="${name}"} ${stats.currentRps}`);
  }
  
  lines.push('');
  lines.push('# HELP dln_rpc_latency_ms Average latency per endpoint');
  lines.push('# TYPE dln_rpc_latency_ms gauge');
  
  for (const [name, stats] of Object.entries(poolStats.endpoints)) {
    if (stats.latencyMs !== null) {
      lines.push(`dln_rpc_latency_ms{endpoint="${name}"} ${stats.latencyMs}`);
    }
  }
  
  lines.push('');
  lines.push('# HELP dln_sse_clients Number of connected SSE clients');
  lines.push('# TYPE dln_sse_clients gauge');
  lines.push(`dln_sse_clients ${sseClients.size}`);
  
  res.type('text/plain').send(lines.join('\n'));
}));

app.get('/api/dashboard', asyncHandler(async (req: Request, res: Response) => {
  const [stats, volumes, tokens, recentOrders, createdProgress, fulfilledProgress] = await Promise.all([
    getTotalStats(),
    getDailyVolumes(30),
    getTopTokens(10),
    getRecentOrders(100), // Increased limit for pagination
    getCollectionProgress(DLN_SOURCE_PROGRAM_ID.toBase58(), 'created'),
    getCollectionProgress(DLN_DESTINATION_PROGRAM_ID.toBase58(), 'fulfilled'),
  ]);
  
  res.json({
    success: true,
    data: {
      stats: {
        totalOrdersCreated: stats.total_created,
        totalOrdersFulfilled: stats.total_fulfilled,
        totalVolumeCreatedUsd: Number(stats.total_created_volume_usd) || 0,
        totalVolumeFulfilledUsd: Number(stats.total_fulfilled_volume_usd) || 0,
      },
      dailyVolumes: volumes.map(v => ({
        date: v.date,
        createdCount: Number(v.created_count),
        createdVolumeUsd: Number(v.created_volume_usd) || 0,
        fulfilledCount: Number(v.fulfilled_count),
        fulfilledVolumeUsd: Number(v.fulfilled_volume_usd) || 0,
      })),
      topTokens: tokens.map(t => ({
        symbol: t.symbol,
        orderCount: Number(t.order_count),
        volumeUsd: Number(t.volume_usd) || 0,
      })),
      recentOrders: recentOrders.map(o => ({
        orderId: o.order_id,
        eventType: o.event_type,
        signature: o.signature,
        blockTime: o.block_time,
        giveTokenSymbol: o.give_token_symbol,
        giveAmountUsd: o.give_amount_usd,
        takeTokenSymbol: o.take_token_symbol,
        takeAmountUsd: o.take_amount_usd,
        maker: o.maker,
        taker: o.taker,
      })),
      collectionProgress: {
        created: createdProgress.totalCollected,
        fulfilled: fulfilledProgress.totalCollected,
      },
    },
  });
}));

// =============================================================================
// Error Handler
// =============================================================================

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, 'API Error');
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// =============================================================================
// Server Startup
// =============================================================================

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'API server started');
  logger.info(`Dashboard API available at http://localhost:${PORT}`);
  logger.info(`SSE endpoint available at http://localhost:${PORT}/api/events`);
  logger.info(`Debug endpoint available at http://localhost:${PORT}/api/debug/usd`);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  stopSSEUpdates();
  
  for (const [id, client] of sseClients) {
    client.res.end();
  }
  sseClients.clear();
  
  server.close();
  await closeClickHouse();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  stopSSEUpdates();
  
  for (const [id, client] of sseClients) {
    client.res.end();
  }
  sseClients.clear();
  
  server.close();
  await closeClickHouse();
  process.exit(0);
});
