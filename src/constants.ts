import { PublicKey } from '@solana/web3.js';

/**
 * DLN Program Addresses on Solana Mainnet
 * Source: https://docs.debridge.com/dln-details/overview/deployed-contracts
 */
export const DLN_SOURCE_PROGRAM_ID = new PublicKey('src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4');
export const DLN_DESTINATION_PROGRAM_ID = new PublicKey('dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo');

/**
 * Known token mints for price resolution
 */
export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; coingeckoId?: string; estimatedPrice?: number }> = {
  // Native Solana tokens
  'So11111111111111111111111111111111111111112': { symbol: 'SOL', decimals: 9, coingeckoId: 'solana', estimatedPrice: 180 },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', estimatedPrice: 1 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether', estimatedPrice: 1 },
  'EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCCb39Xo6rZNH': { symbol: 'ETH', decimals: 8, coingeckoId: 'ethereum', estimatedPrice: 3300 },
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': { symbol: 'WBTC', decimals: 8, coingeckoId: 'wrapped-bitcoin', estimatedPrice: 95000 },

  // DLN External Token Representations (most common from database)
  // These are DLN's representations of tokens from other chains
  '2M59vuWgsiuHAqQVB6KvuXuaBCJR8138gMAm4uCuR6Du': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', estimatedPrice: 1 },
  '2M59vwAZjmxdjuFoHN4LPF6V884pXaVd4tFAPfNHcbhH': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether', estimatedPrice: 1 },
  '2M59vwKQJKZmd3tzArBHGeyBpXNkrxVuJ4nbSzyvLSLf': { symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum', estimatedPrice: 3300 },
  '2M59vwmBk7XwzDiNXD8m2aMYLdC8asEZ78mcVkTJJxVu': { symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum', estimatedPrice: 3300 },
  '2M59vvrxfJjQvkVrRcaukiLMDLyAVkVStsdo3TzncnFR': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', estimatedPrice: 1 },
  '2M59vw3yujSFV1eVfmv5Af3UCe1FbkSAYpwaB15ZRghu': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', estimatedPrice: 1 },
  '2M59vv8eoRXMEVD8Wmb9RtvYdgx3WvgmNU9dvcHk55bm': { symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum', estimatedPrice: 3300 },
  '2M59vv9Ub5R2Upy8RdJanjAjy1NAysXCViLtRTzNDBwD': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', estimatedPrice: 1 },
  '2M59vvcYYyHFQYh6oLvg2z8q1aqoa1LrNLQZqU4ZKPoD': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether', estimatedPrice: 1 },
  '2M59vvbm5H6PgSnLrJ4enUh2dkwQRPPYnXYcduwW348X': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', estimatedPrice: 1 },
  '2M59vvazzYMLDTQ8baypEm43JvVgWwYWEUHWkYHWfRaf': { symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum', estimatedPrice: 3300 },
  '2M59vuaiieUr7KrPTJkcMSB1jVcB8FRLZ1jRYLNzvAeb': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', estimatedPrice: 1 },
  '2M59vw23JFxr587GK7gjf7mnWF98NHq1t1Uy2zEdx9vf': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', estimatedPrice: 1 },
};

/**
 * Anchor instruction discriminators (first 8 bytes)
 * These are SHA256 hashes of "global:<instruction_name>" truncated to 8 bytes
 */
export const INSTRUCTION_DISCRIMINATORS = {
  // DlnSource instructions
  createOrder: Buffer.from([141, 54, 37, 207, 237, 210, 250, 215]),        // create_order
  createOrderWithNonce: Buffer.from([61, 130, 195, 186, 174, 205, 163, 36]), // create_order_with_nonce
  
  // DlnDestination instructions  
  fulfillOrder: Buffer.from([159, 47, 252, 60, 19, 242, 115, 14]),          // fulfill_order
  fulfillPreswap: Buffer.from([227, 130, 162, 226, 137, 166, 232, 27]),     // fulfill_order_via_preswap (rough estimate)
};

/**
 * Chain IDs used by DLN
 */
export const CHAIN_IDS: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BSC',
  100: 'Gnosis',
  137: 'Polygon',
  250: 'Fantom',
  8453: 'Base',
  42161: 'Arbitrum',
  43114: 'Avalanche',
  7565164: 'Solana',  // DLN uses this ID for Solana
};

/**
 * Solana chain ID in DLN format
 */
export const SOLANA_CHAIN_ID = 7565164n;
