/**
 * Retry Utility with Exponential Backoff
 * 
 * Provides robust retry logic for handling rate limits and transient failures
 */

import { logger } from './logger.js';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 5) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 to randomize delay (default: 0.3) */
  jitterFactor?: number;
  /** Function to determine if error is retryable (default: rate limit errors) */
  retryOn?: (error: Error) => boolean;
  /** Optional context for logging */
  context?: string;
}

/**
 * Default function to determine if an error is retryable
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message?.toLowerCase() || '';
  const name = error.name?.toLowerCase() || '';
  
  // Rate limit errors
  if (message.includes('429') || message.includes('rate limit')) {
    return true;
  }
  
  // Connection errors
  if (
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('network') ||
    name.includes('fetcherror')
  ) {
    return true;
  }
  
  // Timeout errors
  if (message.includes('timeout') || name.includes('timeout')) {
    return true;
  }
  
  // Server errors (5xx)
  if (message.includes('500') || message.includes('502') || 
      message.includes('503') || message.includes('504')) {
    return true;
  }
  
  // Solana-specific errors
  if (message.includes('blockhash not found') || 
      message.includes('node is behind') ||
      message.includes('too many requests')) {
    return true;
  }
  
  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number
): number {
  // Exponential backoff: base * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  
  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  
  // Add jitter to prevent thundering herd
  const jitter = cappedDelay * jitterFactor * Math.random();
  
  return Math.floor(cappedDelay + jitter);
}

/**
 * Execute a function with retry logic
 * 
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => connection.getParsedTransactions(signatures),
 *   { maxRetries: 5, context: 'fetchTransactions' }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 5,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    jitterFactor = 0.3,
    retryOn = isRetryableError,
    context = 'operation',
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // Check if we should retry
      const isRetryable = retryOn(lastError);
      const hasRetriesLeft = attempt < maxRetries;
      
      if (!isRetryable || !hasRetriesLeft) {
        logger.error({
          context,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          error: lastError.message,
          retryable: isRetryable,
        }, 'Operation failed (no more retries)');
        throw lastError;
      }

      // Calculate delay
      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs, jitterFactor);
      
      logger.warn({
        context,
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        delayMs: delay,
        error: lastError.message,
      }, 'Retrying after error');

      // Wait before retry
      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('Retry failed');
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limiter using token bucket algorithm
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a token, waiting if necessary
   */
  async acquire(): Promise<void> {
    this.refill();
    
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    
    // Calculate wait time for next token
    const waitTime = (1 / this.refillRate) * 1000;
    await sleep(waitTime);
    
    this.refill();
    this.tokens -= 1;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Get current token count (for monitoring)
   */
  getTokens(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Circuit breaker for handling persistent failures
 */
export class CircuitBreaker {
  private failures: number = 0;
  private lastFailure: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 60000
  ) {}

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if we should try again
      if (Date.now() - this.lastFailure >= this.resetTimeoutMs) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      logger.warn({
        failures: this.failures,
        threshold: this.failureThreshold,
      }, 'Circuit breaker opened');
    }
  }

  getState(): string {
    return this.state;
  }
}
