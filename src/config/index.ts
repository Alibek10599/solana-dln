/**
 * Centralized Configuration Management
 *
 * Loads and validates all environment variables at startup.
 * Provides type-safe access to configuration throughout the application.
 */

import dotenv from 'dotenv';
import { PublicKey } from '@solana/web3.js';

dotenv.config();

/**
 * Require an environment variable to be set
 */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Get optional environment variable with default
 */
function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Parse integer environment variable
 */
function optionalInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${key}: ${value}`);
  }
  return parsed;
}

/**
 * Parse boolean environment variable
 */
function optionalBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;

  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;

  throw new Error(`Invalid boolean for ${key}: ${value}`);
}

/**
 * Validate Solana PublicKey
 */
function requirePublicKey(key: string): PublicKey {
  const value = requireEnv(key);
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid Solana PublicKey for ${key}: ${value}`);
  }
}

/**
 * Application Configuration
 */
export const config = {
  // Solana RPC
  solana: {
    rpcUrl: optionalEnv('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    enableBatchRequests: optionalBool('RPC_BATCH_REQUESTS', true),
    commitment: 'confirmed' as const,
    timeout: optionalInt('RPC_TIMEOUT_MS', 60000),
  },

  // DLN Program IDs
  dln: {
    sourceProgram: new PublicKey('src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4'),
    destinationProgram: new PublicKey('dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo'),
  },

  // ClickHouse Database
  clickhouse: {
    url: optionalEnv('CLICKHOUSE_URL', 'http://localhost:8123'),
    database: optionalEnv('CLICKHOUSE_DATABASE', 'dln_dashboard'),
    user: optionalEnv('CLICKHOUSE_USER', 'default'),
    password: optionalEnv('CLICKHOUSE_PASSWORD', ''),
    // Enable async inserts for better performance
    asyncInsert: optionalBool('CLICKHOUSE_ASYNC_INSERT', true),
    waitForAsyncInsert: optionalBool('CLICKHOUSE_WAIT_FOR_ASYNC_INSERT', true),
  },

  // Temporal Workflow Engine
  temporal: {
    address: optionalEnv('TEMPORAL_ADDRESS', 'localhost:7233'),
    namespace: optionalEnv('TEMPORAL_NAMESPACE', 'default'),
    taskQueue: optionalEnv('TEMPORAL_TASK_QUEUE', 'dln-collector'),
    rpcQueue: optionalEnv('TEMPORAL_RPC_QUEUE', 'dln-rpc'),
    dbQueue: optionalEnv('TEMPORAL_DB_QUEUE', 'dln-db'),
  },

  // Collection Settings
  collection: {
    targetCreatedOrders: optionalInt('TARGET_CREATED_ORDERS', 25000),
    targetFulfilledOrders: optionalInt('TARGET_FULFILLED_ORDERS', 25000),
    signaturesBatchSize: optionalInt('SIGNATURES_BATCH_SIZE', 1000),
    txBatchSize: optionalInt('TX_BATCH_SIZE', 20),
    batchDelayMs: optionalInt('BATCH_DELAY_MS', 500),
    parallel: optionalBool('COLLECTION_PARALLEL', true),
  },

  // Worker Configuration
  worker: {
    mode: optionalEnv('WORKER_MODE', 'full') as 'full' | 'rpc' | 'db' | 'workflow',
    maxWorkflowTasks: optionalInt('WORKER_MAX_WORKFLOW_TASKS', 10),
    maxActivities: optionalInt('WORKER_MAX_ACTIVITIES', 5),
    activitiesPerSecond: optionalInt('WORKER_ACTIVITIES_PER_SECOND', 5),
  },

  // Retry Configuration
  retry: {
    maxRetries: optionalInt('MAX_RETRIES', 5),
    initialDelayMs: optionalInt('INITIAL_RETRY_DELAY_MS', 1000),
    maxDelayMs: optionalInt('MAX_RETRY_DELAY_MS', 30000),
  },

  // API Server
  api: {
    port: optionalInt('API_PORT', 3001),
    corsOrigin: optionalEnv('CORS_ORIGIN', 'http://localhost:3000'),
  },

  // Logging
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info') as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    prettyPrint: optionalBool('LOG_PRETTY', process.env.NODE_ENV !== 'production'),
  },

  // Environment
  env: {
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    isDevelopment: optionalEnv('NODE_ENV', 'development') === 'development',
    isProduction: process.env.NODE_ENV === 'production',
  },
} as const;

export type Config = typeof config;

/**
 * Validate configuration at startup
 */
export function validateConfig(): void {
  // Worker mode validation
  const validWorkerModes = ['full', 'rpc', 'db', 'workflow'];
  if (!validWorkerModes.includes(config.worker.mode)) {
    throw new Error(
      `Invalid WORKER_MODE: ${config.worker.mode}. Must be one of: ${validWorkerModes.join(', ')}`
    );
  }

  // Log level validation
  const validLogLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  if (!validLogLevels.includes(config.logging.level)) {
    throw new Error(
      `Invalid LOG_LEVEL: ${config.logging.level}. Must be one of: ${validLogLevels.join(', ')}`
    );
  }

  // Validate positive integers
  if (config.collection.targetCreatedOrders <= 0) {
    throw new Error('TARGET_CREATED_ORDERS must be positive');
  }
  if (config.collection.targetFulfilledOrders <= 0) {
    throw new Error('TARGET_FULFILLED_ORDERS must be positive');
  }
}

// Validate on module load
validateConfig();
