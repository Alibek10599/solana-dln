/**
 * Parallel Transaction Fetcher
 * 
 * Fetches Solana transactions in parallel with:
 * - Controlled concurrency
 * - Automatic retry with backoff
 * - RPC pool integration
 * - Progress tracking
 * - Adaptive concurrency based on error rates
 */

import { ParsedTransactionWithMeta } from '@solana/web3.js';
import { getRpcPool, reportSuccess, reportFailure } from './pool.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

export interface FetchProgress {
  completed: number;
  total: number;
  successful: number;
  failed: number;
  retried: number;
}

export interface FetchOptions {
  /** Max concurrent requests (default: 5) */
  concurrency?: number;
  /** Max retries per transaction (default: 3) */
  maxRetries?: number;
  /** Base delay between retries in ms (default: 1000) */
  retryDelayMs?: number;
  /** Progress callback */
  onProgress?: (progress: FetchProgress) => void;
  /** Heartbeat callback for Temporal */
  onHeartbeat?: (info: object) => void;
  /** Use batch API if available (default: true) */
  useBatchApi?: boolean;
  /** Batch size for batch API (default: 100) */
  batchSize?: number;
}

interface QueueItem {
  signature: string;
  index: number;
  retries: number;
}

// =============================================================================
// Parallel Fetcher
// =============================================================================

export class ParallelFetcher {
  private options: Required<FetchOptions>;
  private currentConcurrency: number;
  
  private readonly minConcurrency = 2;
  private readonly maxConcurrency = 20;
  
  constructor(options: FetchOptions = {}) {
    this.options = {
      concurrency: options.concurrency ?? 5,
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 1000,
      onProgress: options.onProgress ?? (() => {}),
      onHeartbeat: options.onHeartbeat ?? (() => {}),
      useBatchApi: options.useBatchApi ?? true,
      batchSize: options.batchSize ?? 50,
    };
    
    this.currentConcurrency = this.options.concurrency;
  }
  
  /**
   * Fetch multiple transactions in parallel
   */
  async fetchTransactions(
    signatures: string[]
  ): Promise<(ParsedTransactionWithMeta | null)[]> {
    if (signatures.length === 0) {
      return [];
    }
    
    const pool = getRpcPool();
    const healthyCount = pool.getHealthyCount();
    
    // Adjust concurrency based on healthy endpoints
    this.currentConcurrency = Math.min(
      this.options.concurrency,
      healthyCount * 3 // ~3 concurrent per endpoint
    );
    
    logger.debug({
      signatures: signatures.length,
      concurrency: this.currentConcurrency,
      healthyEndpoints: healthyCount,
      useBatchApi: this.options.useBatchApi,
    }, 'Starting parallel fetch');
    
    // Choose strategy
    if (this.options.useBatchApi && healthyCount > 0) {
      return this.fetchWithBatchApi(signatures);
    } else {
      return this.fetchIndividually(signatures);
    }
  }
  
  /**
   * Fetch using batch API (getParsedTransactions)
   */
  private async fetchWithBatchApi(
    signatures: string[]
  ): Promise<(ParsedTransactionWithMeta | null)[]> {
    const results: (ParsedTransactionWithMeta | null)[] = new Array(signatures.length).fill(null);
    const pool = getRpcPool();
    
    // Split into batches
    const batches: { signatures: string[]; startIndex: number }[] = [];
    for (let i = 0; i < signatures.length; i += this.options.batchSize) {
      batches.push({
        signatures: signatures.slice(i, i + this.options.batchSize),
        startIndex: i,
      });
    }
    
    const progress: FetchProgress = {
      completed: 0,
      total: signatures.length,
      successful: 0,
      failed: 0,
      retried: 0,
    };
    
    // Process batches with controlled concurrency
    const batchQueue = [...batches];
    const workers = Array(Math.min(this.currentConcurrency, batches.length))
      .fill(null)
      .map(() => this.batchWorker(batchQueue, results, progress, pool));
    
    await Promise.all(workers);
    
    // Final progress update
    this.options.onProgress(progress);
    
    // Adjust concurrency based on error rate
    this.adjustConcurrency(progress);
    
    logger.info({
      total: signatures.length,
      successful: progress.successful,
      failed: progress.failed,
      retried: progress.retried,
    }, 'Parallel fetch complete');
    
    return results;
  }
  
  /**
   * Worker for batch processing
   */
  private async batchWorker(
    queue: { signatures: string[]; startIndex: number }[],
    results: (ParsedTransactionWithMeta | null)[],
    progress: FetchProgress,
    pool: ReturnType<typeof getRpcPool>
  ): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.shift();
      if (!batch) break;
      
      let retries = 0;
      let success = false;
      
      while (!success && retries <= this.options.maxRetries) {
        const { connection, endpoint } = pool.getConnection();
        const startTime = Date.now();
        
        try {
          const txs = await connection.getParsedTransactions(
            batch.signatures,
            {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }
          );
          
          // Store results
          for (let i = 0; i < txs.length; i++) {
            results[batch.startIndex + i] = txs[i];
            if (txs[i]) progress.successful++;
            else progress.failed++;
          }
          
          progress.completed += batch.signatures.length;
          
          // Report success
          const latency = Date.now() - startTime;
          reportSuccess(endpoint.name, latency);
          
          success = true;
          
        } catch (error) {
          retries++;
          progress.retried++;
          
          reportFailure(endpoint.name, error as Error);
          
          logger.warn({
            endpoint: endpoint.name,
            batchSize: batch.signatures.length,
            retries,
            error: (error as Error).message,
          }, 'Batch fetch failed, retrying');
          
          if (retries <= this.options.maxRetries) {
            // Exponential backoff with jitter
            const delay = this.options.retryDelayMs * Math.pow(2, retries - 1);
            const jitter = Math.random() * delay * 0.3;
            await this.sleep(delay + jitter);
          }
        }
      }
      
      // If still failed after retries, mark all as null
      if (!success) {
        for (let i = 0; i < batch.signatures.length; i++) {
          results[batch.startIndex + i] = null;
          progress.failed++;
        }
        progress.completed += batch.signatures.length;
      }
      
      // Progress callback
      this.options.onProgress(progress);
      
      // Heartbeat for Temporal
      if (progress.completed % 100 === 0) {
        this.options.onHeartbeat({
          phase: 'fetching',
          progress: `${progress.completed}/${progress.total}`,
          successRate: `${((progress.successful / progress.completed) * 100).toFixed(1)}%`,
        });
      }
    }
  }
  
  /**
   * Fetch transactions individually (fallback for free tier RPCs)
   */
  private async fetchIndividually(
    signatures: string[]
  ): Promise<(ParsedTransactionWithMeta | null)[]> {
    const results: (ParsedTransactionWithMeta | null)[] = new Array(signatures.length).fill(null);
    const pool = getRpcPool();
    
    // Create queue
    const queue: QueueItem[] = signatures.map((sig, index) => ({
      signature: sig,
      index,
      retries: 0,
    }));
    
    const progress: FetchProgress = {
      completed: 0,
      total: signatures.length,
      successful: 0,
      failed: 0,
      retried: 0,
    };
    
    // Process with workers
    const workers = Array(this.currentConcurrency)
      .fill(null)
      .map(() => this.individualWorker(queue, results, progress, pool));
    
    await Promise.all(workers);
    
    // Final progress update
    this.options.onProgress(progress);
    
    // Adjust concurrency
    this.adjustConcurrency(progress);
    
    logger.info({
      total: signatures.length,
      successful: progress.successful,
      failed: progress.failed,
      retried: progress.retried,
    }, 'Individual fetch complete');
    
    return results;
  }
  
  /**
   * Worker for individual transaction fetching
   */
  private async individualWorker(
    queue: QueueItem[],
    results: (ParsedTransactionWithMeta | null)[],
    progress: FetchProgress,
    pool: ReturnType<typeof getRpcPool>
  ): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      
      const { connection, endpoint } = pool.getConnection();
      const startTime = Date.now();
      
      try {
        const tx = await connection.getParsedTransaction(item.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        
        results[item.index] = tx;
        progress.completed++;
        
        if (tx) {
          progress.successful++;
        } else {
          progress.failed++;
        }
        
        // Report success
        const latency = Date.now() - startTime;
        reportSuccess(endpoint.name, latency);
        
      } catch (error) {
        reportFailure(endpoint.name, error as Error);
        
        // Retry logic
        if (item.retries < this.options.maxRetries) {
          item.retries++;
          progress.retried++;
          queue.push(item); // Re-queue for retry
          
          // Backoff
          const delay = this.options.retryDelayMs * Math.pow(2, item.retries - 1);
          await this.sleep(delay);
        } else {
          // Max retries exceeded
          results[item.index] = null;
          progress.completed++;
          progress.failed++;
          
          logger.warn({
            signature: item.signature.slice(0, 20),
            retries: item.retries,
            error: (error as Error).message,
          }, 'Transaction fetch failed after max retries');
        }
      }
      
      // Progress callback
      this.options.onProgress(progress);
      
      // Heartbeat
      if (progress.completed % 50 === 0) {
        this.options.onHeartbeat({
          phase: 'fetching',
          progress: `${progress.completed}/${progress.total}`,
        });
      }
      
      // Small delay to avoid hammering
      await this.sleep(50);
    }
  }
  
  /**
   * Adjust concurrency based on error rate
   */
  private adjustConcurrency(progress: FetchProgress): void {
    if (progress.completed === 0) return;
    
    const errorRate = progress.failed / progress.completed;
    const retryRate = progress.retried / progress.completed;
    
    if (errorRate > 0.1 || retryRate > 0.2) {
      // Too many errors, reduce concurrency
      this.currentConcurrency = Math.max(
        this.minConcurrency,
        Math.floor(this.currentConcurrency * 0.7)
      );
      logger.info({
        newConcurrency: this.currentConcurrency,
        errorRate: `${(errorRate * 100).toFixed(1)}%`,
      }, 'Reduced concurrency due to errors');
      
    } else if (errorRate < 0.01 && retryRate < 0.05) {
      // Very low errors, can increase concurrency
      this.currentConcurrency = Math.min(
        this.maxConcurrency,
        this.currentConcurrency + 1
      );
    }
  }
  
  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Fetch transactions with default settings
 */
export async function fetchTransactionsParallel(
  signatures: string[],
  options?: FetchOptions
): Promise<(ParsedTransactionWithMeta | null)[]> {
  const fetcher = new ParallelFetcher(options);
  return fetcher.fetchTransactions(signatures);
}

/**
 * Fetch transactions with Temporal heartbeat integration
 */
export async function fetchTransactionsWithHeartbeat(
  signatures: string[],
  heartbeatFn: (info: object) => void,
  options?: Omit<FetchOptions, 'onHeartbeat'>
): Promise<(ParsedTransactionWithMeta | null)[]> {
  const fetcher = new ParallelFetcher({
    ...options,
    onHeartbeat: heartbeatFn,
  });
  return fetcher.fetchTransactions(signatures);
}
