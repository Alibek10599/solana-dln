import { PublicKey } from '@solana/web3.js';

/**
 * DLN Program Addresses on Solana Mainnet
 * Source: https://docs.debridge.com/dln-details/overview/deployed-contracts
 */
export const DLN_SOURCE_PROGRAM_ID = new PublicKey('src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4');
export const DLN_DESTINATION_PROGRAM_ID = new PublicKey('dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo');

/**
 * Token info structure
 */
interface TokenInfo {
  symbol: string;
  decimals: number;
  coingeckoId?: string;
  estimatedPrice?: number;
}

/**
 * Known token mints for price resolution
 * Includes native Solana tokens and DLN external token representations
 */
export const KNOWN_TOKENS: Record<string, TokenInfo> = {
  // ==========================================================================
  // Native Solana SPL Tokens
  // ==========================================================================
  'So11111111111111111111111111111111111111112': { symbol: 'SOL', decimals: 9, coingeckoId: 'solana', estimatedPrice: 190 },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', estimatedPrice: 1 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether', estimatedPrice: 1 },
  'EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCCb39Xo6rZNH': { symbol: 'ETH', decimals: 8, coingeckoId: 'ethereum', estimatedPrice: 3400 },
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': { symbol: 'WBTC', decimals: 8, coingeckoId: 'wrapped-bitcoin', estimatedPrice: 95000 },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { symbol: 'mSOL', decimals: 9, coingeckoId: 'msol', estimatedPrice: 210 },
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': { symbol: 'stSOL', decimals: 9, coingeckoId: 'lido-staked-sol', estimatedPrice: 200 },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK', decimals: 5, coingeckoId: 'bonk', estimatedPrice: 0.00003 },

  // ==========================================================================
  // DLN External Token Representations (deAssets)
  // These are DLN's representations of tokens from other chains on Solana
  // Format: 2M59... addresses are DLN-wrapped versions
  // ==========================================================================
  
  // USDC from various chains
  '2M59vuWgsiuHAqQVB6KvuXuaBCJR8138gMAm4uCuR6Du': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '2M59vvrxfJjQvkVrRcaukiLMDLyAVkVStsdo3TzncnFR': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '2M59vw3yujSFV1eVfmv5Af3UCe1FbkSAYpwaB15ZRghu': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '2M59vv9Ub5R2Upy8RdJanjAjy1NAysXCViLtRTzNDBwD': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '2M59vvbm5H6PgSnLrJ4enUh2dkwQRPPYnXYcduwW348X': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '2M59vuaiieUr7KrPTJkcMSB1jVcB8FRLZ1jRYLNzvAeb': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '2M59vw23JFxr587GK7gjf7mnWF98NHq1t1Uy2zEdx9vf': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  
  // USDT from various chains
  '2M59vwAZjmxdjuFoHN4LPF6V884pXaVd4tFAPfNHcbhH': { symbol: 'USDT', decimals: 6, estimatedPrice: 1 },
  '2M59vvcYYyHFQYh6oLvg2z8q1aqoa1LrNLQZqU4ZKPoD': { symbol: 'USDT', decimals: 6, estimatedPrice: 1 },
  
  // ETH from various chains (note: 18 decimals for EVM ETH)
  '2M59vwKQJKZmd3tzArBHGeyBpXNkrxVuJ4nbSzyvLSLf': { symbol: 'ETH', decimals: 18, estimatedPrice: 3400 },
  '2M59vwmBk7XwzDiNXD8m2aMYLdC8asEZ78mcVkTJJxVu': { symbol: 'ETH', decimals: 18, estimatedPrice: 3400 },
  '2M59vv8eoRXMEVD8Wmb9RtvYdgx3WvgmNU9dvcHk55bm': { symbol: 'ETH', decimals: 18, estimatedPrice: 3400 },
  '2M59vvazzYMLDTQ8baypEm43JvVgWwYWEUHWkYHWfRaf': { symbol: 'ETH', decimals: 18, estimatedPrice: 3400 },
};

/**
 * EVM Token addresses (0x format) - for cross-chain orders
 * These are the original token addresses on EVM chains
 * Note: Some addresses are shared across chains (e.g., 0x420... is WETH on both Base and Optimism)
 */
export const EVM_TOKENS: Record<string, TokenInfo> = {
  // Native ETH (zero address)
  '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18, estimatedPrice: 3400 },
  
  // Ethereum Mainnet
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, estimatedPrice: 1 },
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, estimatedPrice: 3400 },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8, estimatedPrice: 95000 },
  
  // Arbitrum
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', decimals: 6, estimatedPrice: 1 },
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6, estimatedPrice: 1 },
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18, estimatedPrice: 3400 },
  
  // Base & Optimism (shared WETH address)
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, estimatedPrice: 3400 },
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 }, // Base USDC
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 }, // Optimism USDC
  '0x7f5c764cbc14f9669b88837ca1490cca17c31607': { symbol: 'USDC.e', decimals: 6, estimatedPrice: 1 }, // Optimism USDC.e
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6, estimatedPrice: 1 }, // Optimism USDT
  
  // Polygon
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC.e', decimals: 6, estimatedPrice: 1 },
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6, estimatedPrice: 1 },
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18, estimatedPrice: 3400 },
  
  // BSC
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18, estimatedPrice: 1 },
  '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18, estimatedPrice: 1 },
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': { symbol: 'ETH', decimals: 18, estimatedPrice: 3400 },
  
  // Avalanche
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { symbol: 'USDC', decimals: 6, estimatedPrice: 1 },
  '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': { symbol: 'USDT', decimals: 6, estimatedPrice: 1 },
  '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab': { symbol: 'WETH.e', decimals: 18, estimatedPrice: 3400 },
};

/**
 * Get token info from any address format
 */
export function getTokenInfo(address: string): TokenInfo | undefined {
  // Check Solana tokens first
  if (KNOWN_TOKENS[address]) {
    return KNOWN_TOKENS[address];
  }
  
  // Check EVM tokens (normalize to lowercase for comparison)
  const normalizedAddress = address.toLowerCase();
  if (EVM_TOKENS[normalizedAddress]) {
    return EVM_TOKENS[normalizedAddress];
  }
  
  return undefined;
}

/**
 * Detect token symbol from address pattern (fallback)
 */
export function detectTokenSymbol(address: string): string | undefined {
  const info = getTokenInfo(address);
  if (info) return info.symbol;
  
  return undefined;
}

/**
 * Anchor instruction discriminators (first 8 bytes)
 * These are SHA256 hashes of "global:<instruction_name>" truncated to 8 bytes
 */
export const INSTRUCTION_DISCRIMINATORS = {
  createOrder: Buffer.from([141, 54, 37, 207, 237, 210, 250, 215]),
  createOrderWithNonce: Buffer.from([61, 130, 195, 186, 174, 205, 163, 36]),
  fulfillOrder: Buffer.from([159, 47, 252, 60, 19, 242, 115, 14]),
  fulfillPreswap: Buffer.from([227, 130, 162, 226, 137, 166, 232, 27]),
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
  7565164: 'Solana',
};

/**
 * Solana chain ID in DLN format
 */
export const SOLANA_CHAIN_ID = 7565164n;
