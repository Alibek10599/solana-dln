/**
 * Multi-RPC Connection Pool with Circuit Breaker
 * 
 * Features:
 * - Round-robin load balancing across multiple RPC endpoints
 * - Circuit breaker pattern for fault tolerance
 * - Rate limiting per endpoint
 * - Automatic recovery and health monitoring
 * - Metrics collection for monitoring
 */

import { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

export interface RpcEndpoint {
  url: string;
  name: string;
  weight: number;
  maxRps: number;
  priority: number; // Lower = higher priority
}

export interface CircuitState {
  failures: number;
  successes: number;
  lastFailure: number;
  lastSuccess: number;
  state: 'closed' | 'open' | 'half-open';
  totalRequests: number;
  totalFailures: number;
}

export interface PoolStats {
  endpoints: {
    [name: string]: {
      url: string;
      circuitState: string;
      failures: number;
      successes: number;
      currentRps: number;
      maxRps: number;
      healthy: boolean;
      latencyMs: number | null;
    };
  };
  totalRequests: number;
  totalFailures: number;
  healthyEndpoints: number;
  totalEndpoints: number;
}

export interface RpcMetrics {
  requestCount: number;
  failureCount: number;
  latencySum: number;
  latencyCount: number;
}

// =============================================================================
// Circuit Breaker Configuration
// =============================================================================

interface CircuitBreakerConfig {
  failureThreshold: number;      // Failures before opening circuit
  recoveryTimeout: number;       // Ms before trying half-open
  halfOpenMaxRequests: number;   // Successful requests to close circuit
  failureWindow: number;         // Ms window for counting failures
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeout: 30_000,       // 30 seconds
  halfOpenMaxRequests: 3,
  failureWindow: 60_000,         // 1 minute
};

// =============================================================================
// Multi-RPC Connection Pool
// =============================================================================

export class MultiRpcPool {
  private static instance: MultiRpcPool | null = null;
  
  private endpoints: RpcEndpoint[] = [];
  private connections: Map<string, Connection> = new Map();
  private circuitStates: Map<string, CircuitState> = new Map();
  private requestTimestamps: Map<string, number[]> = new Map();
  private latencies: Map<string, number[]> = new Map();
  private metrics: Map<string, RpcMetrics> = new Map();
  
  private currentIndex = 0;
  private config: CircuitBreakerConfig;
  
  private constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
    this.initializeEndpoints();
  }
  
  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<CircuitBreakerConfig>): MultiRpcPool {
    if (!MultiRpcPool.instance) {
      MultiRpcPool.instance = new MultiRpcPool(config);
    }
    return MultiRpcPool.instance;
  }
  
  /**
   * Reset instance (for testing)
   */
  static resetInstance(): void {
    MultiRpcPool.instance = null;
  }
  
  /**
   * Initialize endpoints from environment
   */
  private initializeEndpoints(): void {
    // Parse RPC_URLS: url1,url2,url3 or url1|name1|maxRps1,url2|name2|maxRps2
    const rpcUrls = process.env.RPC_URLS || process.env.SOLANA_RPC_URL || '';
    
    const urlList = rpcUrls.split(',').filter(Boolean);
    
    if (urlList.length === 0) {
      // Default to public RPC
      urlList.push('https://api.mainnet-beta.solana.com');
    }
    
    this.endpoints = urlList.map((entry, index) => {
      const parts = entry.split('|');
      const url = parts[0].trim();
      const name = parts[1]?.trim() || this.inferName(url, index);
      const maxRps = parseInt(parts[2]?.trim() || '') || this.inferMaxRps(url);
      
      return {
        url,
        name,
        weight: 1,
        maxRps,
        priority: index,
      };
    });
    
    // Initialize state for each endpoint
    for (const ep of this.endpoints) {
      this.circuitStates.set(ep.name, {
        failures: 0,
        successes: 0,
        lastFailure: 0,
        lastSuccess: 0,
        state: 'closed',
        totalRequests: 0,
        totalFailures: 0,
      });
      
      this.requestTimestamps.set(ep.name, []);
      this.latencies.set(ep.name, []);
      this.metrics.set(ep.name, {
        requestCount: 0,
        failureCount: 0,
        latencySum: 0,
        latencyCount: 0,
      });
    }
    
    logger.info({
      endpoints: this.endpoints.map(e => ({
        name: e.name,
        maxRps: e.maxRps,
      })),
    }, `RPC pool initialized with ${this.endpoints.length} endpoints`);
  }
  
  /**
   * Infer endpoint name from URL
   */
  private inferName(url: string, index: number): string {
    if (url.includes('helius')) return `helius-${index}`;
    if (url.includes('quicknode')) return `quicknode-${index}`;
    if (url.includes('alchemy')) return `alchemy-${index}`;
    if (url.includes('triton')) return `triton-${index}`;
    if (url.includes('mainnet-beta.solana.com')) return `public-${index}`;
    if (url.includes('ankr')) return `ankr-${index}`;
    if (url.includes('getblock')) return `getblock-${index}`;
    return `rpc-${index}`;
  }
  
  /**
   * Infer max RPS based on provider
   */
  private inferMaxRps(url: string): number {
    if (url.includes('helius')) return 50;
    if (url.includes('quicknode')) return 25;
    if (url.includes('alchemy')) return 25;
    if (url.includes('triton')) return 100;
    if (url.includes('ankr')) return 30;
    if (url.includes('getblock')) return 40;
    return 10; // Conservative default for public/unknown RPCs
  }
  
  /**
   * Get a healthy connection (main entry point)
   */
  getConnection(): { connection: Connection; endpoint: RpcEndpoint } {
    const endpoint = this.selectEndpoint();
    const connection = this.getOrCreateConnection(endpoint);
    
    // Track request
    this.trackRequest(endpoint.name);
    
    return { connection, endpoint };
  }
  
  /**
   * Select best available endpoint
   */
  private selectEndpoint(): RpcEndpoint {
    // Get healthy endpoints with capacity
    const available = this.endpoints.filter(ep => 
      this.isEndpointAvailable(ep.name) && this.hasCapacity(ep.name)
    );
    
    if (available.length === 0) {
      // All endpoints unavailable - try half-open on least recently failed
      const halfOpenCandidate = this.getHalfOpenCandidate();
      if (halfOpenCandidate) {
        logger.warn({ endpoint: halfOpenCandidate.name }, 'All circuits open, trying half-open');
        return halfOpenCandidate;
      }
      
      // Last resort - use first endpoint regardless of state
      logger.error('All RPC endpoints unavailable, using first endpoint');
      return this.endpoints[0];
    }
    
    // Round-robin among available endpoints
    const endpoint = available[this.currentIndex % available.length];
    this.currentIndex++;
    
    return endpoint;
  }
  
  /**
   * Check if endpoint is available (circuit not open)
   */
  private isEndpointAvailable(name: string): boolean {
    const state = this.circuitStates.get(name);
    if (!state) return false;
    
    switch (state.state) {
      case 'closed':
        return true;
        
      case 'open':
        // Check if recovery timeout has passed
        if (Date.now() - state.lastFailure > this.config.recoveryTimeout) {
          // Transition to half-open
          state.state = 'half-open';
          state.successes = 0;
          logger.info({ endpoint: name }, 'Circuit breaker half-open');
          return true;
        }
        return false;
        
      case 'half-open':
        return true;
    }
  }
  
  /**
   * Check if endpoint has capacity (rate limit)
   */
  private hasCapacity(name: string): boolean {
    const endpoint = this.endpoints.find(e => e.name === name);
    if (!endpoint) return false;
    
    const timestamps = this.requestTimestamps.get(name) || [];
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    // Count requests in last second
    const recentRequests = timestamps.filter(t => t > oneSecondAgo).length;
    
    // Leave 20% headroom
    return recentRequests < endpoint.maxRps * 0.8;
  }
  
  /**
   * Get candidate for half-open test
   */
  private getHalfOpenCandidate(): RpcEndpoint | null {
    let oldest: RpcEndpoint | null = null;
    let oldestTime = Infinity;
    
    for (const ep of this.endpoints) {
      const state = this.circuitStates.get(ep.name);
      if (state && state.state === 'open') {
        if (state.lastFailure < oldestTime) {
          oldestTime = state.lastFailure;
          oldest = ep;
        }
      }
    }
    
    return oldest;
  }
  
  /**
   * Get or create connection for endpoint
   */
  private getOrCreateConnection(endpoint: RpcEndpoint): Connection {
    if (!this.connections.has(endpoint.name)) {
      const connection = new Connection(endpoint.url, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: true, // We handle retries
      });
      
      this.connections.set(endpoint.name, connection);
      logger.debug({ endpoint: endpoint.name }, 'Created new connection');
    }
    
    return this.connections.get(endpoint.name)!;
  }
  
  /**
   * Track request timestamp for rate limiting
   */
  private trackRequest(name: string): void {
    const timestamps = this.requestTimestamps.get(name) || [];
    timestamps.push(Date.now());
    
    // Keep only last 2 seconds of data
    const cutoff = Date.now() - 2000;
    this.requestTimestamps.set(name, timestamps.filter(t => t > cutoff));
    
    // Update metrics
    const metrics = this.metrics.get(name);
    if (metrics) {
      metrics.requestCount++;
    }
    
    // Update circuit state
    const state = this.circuitStates.get(name);
    if (state) {
      state.totalRequests++;
    }
  }
  
  /**
   * Report successful request
   */
  reportSuccess(endpointName: string, latencyMs?: number): void {
    const state = this.circuitStates.get(endpointName);
    if (!state) return;
    
    state.successes++;
    state.lastSuccess = Date.now();
    
    // Track latency
    if (latencyMs !== undefined) {
      const latencies = this.latencies.get(endpointName) || [];
      latencies.push(latencyMs);
      // Keep last 100 latencies
      if (latencies.length > 100) latencies.shift();
      this.latencies.set(endpointName, latencies);
      
      const metrics = this.metrics.get(endpointName);
      if (metrics) {
        metrics.latencySum += latencyMs;
        metrics.latencyCount++;
      }
    }
    
    // Decay failures on success
    if (state.failures > 0) {
      state.failures = Math.max(0, state.failures - 1);
    }
    
    // Handle state transitions
    switch (state.state) {
      case 'half-open':
        if (state.successes >= this.config.halfOpenMaxRequests) {
          state.state = 'closed';
          state.failures = 0;
          state.successes = 0;
          logger.info({ endpoint: endpointName }, 'Circuit breaker closed (recovered)');
        }
        break;
        
      case 'closed':
        // Reset failure count if we've had consistent success
        if (state.successes >= 10) {
          state.failures = 0;
        }
        break;
    }
  }
  
  /**
   * Report failed request
   */
  reportFailure(endpointName: string, error: Error): void {
    const state = this.circuitStates.get(endpointName);
    if (!state) return;
    
    const now = Date.now();
    
    // Only count failures within the failure window
    if (now - state.lastFailure > this.config.failureWindow) {
      state.failures = 1; // Reset if outside window
    } else {
      state.failures++;
    }
    
    state.lastFailure = now;
    state.successes = 0;
    state.totalFailures++;
    
    // Update metrics
    const metrics = this.metrics.get(endpointName);
    if (metrics) {
      metrics.failureCount++;
    }
    
    // Check if we should open the circuit
    const shouldOpen = state.failures >= this.config.failureThreshold;
    
    // Handle state transitions
    switch (state.state) {
      case 'closed':
        if (shouldOpen) {
          state.state = 'open';
          logger.warn({
            endpoint: endpointName,
            failures: state.failures,
            error: error.message,
          }, 'Circuit breaker opened');
        }
        break;
        
      case 'half-open':
        // Any failure in half-open immediately opens the circuit
        state.state = 'open';
        logger.warn({
          endpoint: endpointName,
          error: error.message,
        }, 'Circuit breaker re-opened from half-open');
        break;
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    const stats: PoolStats = {
      endpoints: {},
      totalRequests: 0,
      totalFailures: 0,
      healthyEndpoints: 0,
      totalEndpoints: this.endpoints.length,
    };
    
    for (const ep of this.endpoints) {
      const state = this.circuitStates.get(ep.name);
      const timestamps = this.requestTimestamps.get(ep.name) || [];
      const latencies = this.latencies.get(ep.name) || [];
      const metrics = this.metrics.get(ep.name);
      
      const recentRequests = timestamps.filter(t => t > Date.now() - 1000).length;
      const avgLatency = latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : null;
      
      const isHealthy = state?.state !== 'open';
      
      stats.endpoints[ep.name] = {
        url: ep.url.replace(/api[-_]?key=[\w-]+/gi, '***'),
        circuitState: state?.state || 'unknown',
        failures: state?.failures || 0,
        successes: state?.successes || 0,
        currentRps: recentRequests,
        maxRps: ep.maxRps,
        healthy: isHealthy,
        latencyMs: avgLatency ? Math.round(avgLatency) : null,
      };
      
      if (isHealthy) stats.healthyEndpoints++;
      stats.totalRequests += metrics?.requestCount || 0;
      stats.totalFailures += metrics?.failureCount || 0;
    }
    
    return stats;
  }
  
  /**
   * Get all endpoints (for parallel fetching)
   */
  getEndpoints(): RpcEndpoint[] {
    return [...this.endpoints];
  }
  
  /**
   * Get healthy endpoint count
   */
  getHealthyCount(): number {
    return this.endpoints.filter(ep => this.isEndpointAvailable(ep.name)).length;
  }
  
  /**
   * Check overall pool health
   */
  isHealthy(): boolean {
    return this.getHealthyCount() > 0;
  }
  
  /**
   * Manually reset a circuit (for testing/recovery)
   */
  resetCircuit(endpointName: string): void {
    const state = this.circuitStates.get(endpointName);
    if (state) {
      state.state = 'closed';
      state.failures = 0;
      state.successes = 0;
      logger.info({ endpoint: endpointName }, 'Circuit breaker manually reset');
    }
  }
  
  /**
   * Reset all circuits
   */
  resetAllCircuits(): void {
    for (const ep of this.endpoints) {
      this.resetCircuit(ep.name);
    }
  }
}

// =============================================================================
// Convenience Exports
// =============================================================================

/**
 * Get the global RPC pool instance
 */
export function getRpcPool(): MultiRpcPool {
  return MultiRpcPool.getInstance();
}

/**
 * Get a connection from the pool
 */
export function getConnection(): { connection: Connection; endpoint: RpcEndpoint } {
  return getRpcPool().getConnection();
}

/**
 * Report success to the pool
 */
export function reportSuccess(endpointName: string, latencyMs?: number): void {
  getRpcPool().reportSuccess(endpointName, latencyMs);
}

/**
 * Report failure to the pool
 */
export function reportFailure(endpointName: string, error: Error): void {
  getRpcPool().reportFailure(endpointName, error);
}
