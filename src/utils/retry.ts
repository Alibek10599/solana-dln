/**
 * Retry Utilities
 *
 * Provides robust retry logic with:
 * - Exponential backoff with full jitter
 * - Configurable retry policies
 * - Retryable error detection
 * - Logging and metrics
 */

import { createChildLogger } from './logger.js';
import { config } from '../config/index.js';

const logger = createChildLogger('retry');

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  retryableErrors?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: config.retry.maxRetries,
  initialDelayMs: config.retry.initialDelayMs,
  maxDelayMs: config.retry.maxDelayMs,
};

/**
 * Calculate exponential backoff delay with full jitter
 */
function calculateDelay(attempt: number, options: RetryOptions): number {
  const exponentialDelay = options.initialDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);
  return Math.random() * cappedDelay;
}

/**
 * Determine if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();

  // Rate limits
  if (message.includes('429') || message.includes('rate limit')) return true;

  // Network errors  
  if (message.includes('econnreset') || message.includes('etimedout')) return true;

  // Server errors
  if (message.includes('500') || message.includes('502') || message.includes('503')) return true;

  // Solana specific
  if (message.includes('blockhash not found') || message.includes('node is behind')) return true;

  // Client errors - NOT retryable
  if (message.includes('400') || message.includes('401') || message.includes('invalid')) return false;

  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  const isRetryable = opts.retryableErrors || isRetryableError;

  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        logger.info({ attempt }, 'Operation succeeded after retry');
      }
      return result;
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxRetries) {
        logger.error({ error, attempt }, 'Max retries exceeded');
        throw error;
      }

      if (!isRetryable(error)) {
        logger.error({ error }, 'Non-retryable error');
        throw error;
      }

      const delay = calculateDelay(attempt, opts);
      logger.warn({ attempt: attempt + 1, delayMs: Math.round(delay) }, 'Retrying after error');

      if (opts.onRetry) {
        opts.onRetry(error, attempt + 1);
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

export function createRetryWrapper(options: Partial<RetryOptions>) {
  return <T>(fn: () => Promise<T>) => withRetry(fn, options);
}

export const withRpcRetry = createRetryWrapper({
  maxRetries: 10,
  initialDelayMs: 500,
  maxDelayMs: 10000,
});

export const withDbRetry = createRetryWrapper({
  maxRetries: 5,
  initialDelayMs: 100,
  maxDelayMs: 5000,
});
