/**
 * RPC Module - Multi-endpoint connection pool with circuit breaker
 */

export {
  MultiRpcPool,
  getRpcPool,
  getConnection,
  reportSuccess,
  reportFailure,
  type RpcEndpoint,
  type CircuitState,
  type PoolStats,
} from './pool.js';

export {
  ParallelFetcher,
  fetchTransactionsParallel,
  fetchTransactionsWithHeartbeat,
  type FetchOptions,
  type FetchProgress,
} from './fetcher.js';
