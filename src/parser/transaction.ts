/**
 * Transaction Parser for DLN Solana Events
 * 
 * Parses DLN protocol transactions to extract order creation and fulfillment events.
 * Uses a combination of:
 * 1. Borsh deserialization for instruction data (give amount)
 * 2. Program data logs for order ID and cross-chain metadata
 * 3. Token balance changes for accurate token identification
 * 
 * @module parser/transaction
 */

import {
  ParsedTransactionWithMeta,
  TokenBalance,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  DLN_SOURCE_PROGRAM_ID,
  DLN_DESTINATION_PROGRAM_ID,
  KNOWN_TOKENS,
  EVM_TOKENS,
} from '../constants.js';
import type { OrderEvent } from '../db/clickhouse.js';
import { logger } from '../utils/logger.js';
import {
  BorshDeserializer,
  CREATE_ORDER_DISCRIMINATOR,
  DISCRIMINATOR_SIZE,
  U64_SIZE,
  CHAIN_IDS,
  CHAIN_NAMES,
  isKnownChainId,
} from './borsh.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Minimum SOL transfer to consider (in lamports) - excludes dust/fees */
const MIN_SOL_TRANSFER_LAMPORTS = 10_000_000; // 0.01 SOL

/** Native SOL mint address (wrapped SOL) */
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Default decimals for unknown tokens */
const DEFAULT_TOKEN_DECIMALS = 6;

/** Stablecoin symbols that have 1:1 USD price */
const STABLECOIN_SYMBOLS = ['USDC', 'USDT', 'DAI', 'BUSD'] as const;

// =============================================================================
// TOKEN TRACKING
// =============================================================================

/** Track unknown tokens for debugging and monitoring */
const unknownTokens = new Map<string, number>();

/** Get count of unknown tokens encountered */
export function getUnknownTokens(): Map<string, number> {
  return new Map(unknownTokens);
}

// =============================================================================
// PARSING STATISTICS
// =============================================================================

interface ParseStats {
  total: number;
  success: number;
  failed: number;
  noEvents: number;
}

let parseStats: ParseStats = {
  total: 0,
  success: 0,
  failed: 0,
  noEvents: 0,
};

export function getParseStats(): ParseStats {
  return { ...parseStats };
}

export function resetParseStats(): void {
  parseStats = { total: 0, success: 0, failed: 0, noEvents: 0 };
}

// =============================================================================
// MAIN PARSING FUNCTIONS
// =============================================================================

/**
 * Parse a transaction and extract DLN order events.
 * 
 * @param tx - Parsed Solana transaction with metadata
 * @param signature - Transaction signature
 * @returns Array of order events (created or fulfilled)
 */
export async function parseTransaction(
  tx: ParsedTransactionWithMeta,
  signature: string
): Promise<OrderEvent[]> {
  const events: OrderEvent[] = [];

  // Skip failed transactions
  if (!tx.meta || tx.meta.err) {
    return events;
  }

  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();
  const slot = tx.slot;
  const logs = tx.meta.logMessages || [];

  const dlnSourceId = DLN_SOURCE_PROGRAM_ID.toBase58();
  const dlnDestId = DLN_DESTINATION_PROGRAM_ID.toBase58();

  // Process main instructions
  for (const ix of tx.transaction.message.instructions) {
    const programId = ix.programId.toBase58();

    if (programId === dlnSourceId && 'data' in ix) {
      const event = parseSourceInstruction(ix.data, tx, signature, slot, blockTime, logs);
      if (event) events.push(event);
    }

    if (programId === dlnDestId && 'data' in ix) {
      const event = parseDestinationInstruction(ix.data, tx, signature, slot, blockTime, logs);
      if (event) events.push(event);
    }
  }

  // Process inner instructions (CPI calls)
  for (const inner of tx.meta.innerInstructions || []) {
    for (const ix of inner.instructions) {
      const programId = ix.programId.toBase58();

      if (programId === dlnSourceId && 'data' in ix) {
        const event = parseSourceInstruction(ix.data, tx, signature, slot, blockTime, logs);
        if (event) events.push(event);
      }

      if (programId === dlnDestId && 'data' in ix) {
        const event = parseDestinationInstruction(ix.data, tx, signature, slot, blockTime, logs);
        if (event) events.push(event);
      }
    }
  }

  return events;
}

/**
 * Batch parse multiple transactions efficiently.
 * 
 * @param transactions - Array of transactions (null entries are skipped)
 * @param signatures - Corresponding signatures
 * @returns All parsed order events
 */
export async function parseTransactions(
  transactions: (ParsedTransactionWithMeta | null)[],
  signatures: string[]
): Promise<OrderEvent[]> {
  const allEvents: OrderEvent[] = [];

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const sig = signatures[i];

    if (!tx) continue;

    parseStats.total++;

    try {
      const events = await parseTransaction(tx, sig);
      if (events.length > 0) {
        parseStats.success++;
        allEvents.push(...events);
      } else {
        parseStats.noEvents++;
      }
    } catch (error) {
      parseStats.failed++;
      logger.warn({
        error: error instanceof Error ? error.message : String(error),
        signature: sig.slice(0, 20),
      }, 'Failed to parse transaction');
    }
  }

  // Log stats periodically
  if (parseStats.total % 500 === 0 && parseStats.total > 0) {
    const successRate = ((parseStats.success / parseStats.total) * 100).toFixed(1);
    logger.info({
      total: parseStats.total,
      success: parseStats.success,
      failed: parseStats.failed,
      noEvents: parseStats.noEvents,
      successRate: `${successRate}%`,
      unknownTokenCount: unknownTokens.size,
    }, 'Parse statistics');
  }

  return allEvents;
}

// =============================================================================
// INSTRUCTION PARSERS
// =============================================================================

/**
 * Parse DLN Source instruction (order creation).
 * Uses Borsh deserialization for instruction data.
 */
function parseSourceInstruction(
  data: string,
  tx: ParsedTransactionWithMeta,
  signature: string,
  slot: number,
  blockTime: Date,
  logs: string[]
): OrderEvent | null {
  try {
    const buffer = Buffer.from(bs58.decode(data));
    const reader = new BorshDeserializer(buffer);

    // Validate discriminator
    if (!reader.checkDiscriminator(CREATE_ORDER_DISCRIMINATOR)) {
      return null;
    }
    reader.skip(DISCRIMINATOR_SIZE);

    // Read give amount using Borsh
    const giveAmountRaw = reader.readU64();

    // Extract order ID from logs
    const orderId = extractOrderIdFromLogs(logs);
    if (!orderId) {
      logger.debug({ signature: signature.slice(0, 16) }, 'No order ID found in logs');
      return null;
    }

    // Get maker address (first signer)
    const maker = findFirstSigner(tx);

    // Get token info from balance changes (most reliable source)
    const tokenTransfer = extractTokenTransfer(tx.meta);

    // Resolve token information
    const tokenInfo = tokenTransfer ? resolveToken(tokenTransfer.mint) : null;
    const giveTokenSymbol = tokenInfo?.symbol;
    const giveTokenAddress = tokenTransfer?.mint;
    const decimals = tokenInfo?.decimals ?? DEFAULT_TOKEN_DECIMALS;

    // Calculate USD value
    const giveAmountUsd = calculateUsdValue(giveAmountRaw, decimals, tokenInfo);

    // Extract cross-chain metadata from logs
    const crossChainInfo = extractCrossChainInfoFromLogs(logs);
    const takeChainId = crossChainInfo?.takeChainId;
    const takeTokenSymbol = crossChainInfo?.takeTokenSymbol;

    logger.info({
      signature: signature.slice(0, 16),
      orderId: orderId.slice(0, 16),
      giveAmount: giveAmountRaw.toString(),
      giveTokenSymbol,
      takeChainId,
      takeTokenSymbol,
      giveAmountUsd: giveAmountUsd?.toFixed(2),
    }, 'Parsed order creation');

    return {
      order_id: orderId,
      event_type: 'created',
      signature,
      slot,
      block_time: blockTime,
      maker: maker ?? undefined,
      give_token_address: giveTokenAddress,
      give_token_symbol: giveTokenSymbol,
      give_amount: giveAmountRaw,
      give_amount_usd: giveAmountUsd,
      give_chain_id: CHAIN_IDS.SOLANA,
      take_token_symbol: takeTokenSymbol,
      take_chain_id: takeChainId,
    };
  } catch (error) {
    logger.debug({
      error: error instanceof Error ? error.message : String(error),
      signature: signature.slice(0, 16),
    }, 'Failed to parse source instruction');
    return null;
  }
}

/**
 * Parse DLN Destination instruction (order fulfillment).
 */
function parseDestinationInstruction(
  data: string,
  tx: ParsedTransactionWithMeta,
  signature: string,
  slot: number,
  blockTime: Date,
  logs: string[]
): OrderEvent | null {
  try {
    const buffer = Buffer.from(bs58.decode(data));

    // Need minimum data length
    if (buffer.length < DISCRIMINATOR_SIZE + 32) {
      return null;
    }

    // Extract order ID from logs
    const orderId = extractOrderIdFromLogs(logs);
    if (!orderId) {
      return null;
    }

    // Get taker address (first signer)
    const taker = findFirstSigner(tx);

    // Get token transfer info
    const tokenTransfer = extractTokenTransfer(tx.meta);

    let takeTokenSymbol: string | undefined;
    let takeAmount: bigint | undefined;
    let takeAmountUsd: number | undefined;

    if (tokenTransfer) {
      const tokenInfo = resolveToken(tokenTransfer.mint);
      takeTokenSymbol = tokenInfo?.symbol;
      takeAmount = BigInt(Math.floor(tokenTransfer.amount));

      const decimals = tokenInfo?.decimals ?? DEFAULT_TOKEN_DECIMALS;
      takeAmountUsd = calculateUsdValue(takeAmount, decimals, tokenInfo);
    }

    logger.info({
      signature: signature.slice(0, 16),
      orderId: orderId.slice(0, 16),
      takeAmount: takeAmount?.toString(),
      takeTokenSymbol,
      takeAmountUsd: takeAmountUsd?.toFixed(2),
    }, 'Parsed order fulfillment');

    return {
      order_id: orderId,
      event_type: 'fulfilled',
      signature,
      slot,
      block_time: blockTime,
      taker: taker ?? undefined,
      take_token_symbol: takeTokenSymbol,
      take_amount: takeAmount,
      take_amount_usd: takeAmountUsd,
      take_chain_id: CHAIN_IDS.SOLANA,
    };
  } catch (error) {
    logger.debug({
      error: error instanceof Error ? error.message : String(error),
      signature: signature.slice(0, 16),
    }, 'Failed to parse destination instruction');
    return null;
  }
}

// =============================================================================
// LOG PARSING HELPERS
// =============================================================================

/**
 * Extract order ID from transaction logs.
 * DLN emits order ID in Anchor event format: 8-byte discriminator + 32-byte orderId.
 */
function extractOrderIdFromLogs(logs: string[]): string | null {
  const ANCHOR_DISCRIMINATOR_SIZE = 8;
  const ORDER_ID_SIZE = 32;
  const MIN_EVENT_SIZE = ANCHOR_DISCRIMINATOR_SIZE + ORDER_ID_SIZE;

  for (const log of logs) {
    if (!log.startsWith('Program data:')) {
      continue;
    }

    try {
      const base64Data = log.replace('Program data:', '').trim();
      const eventData = Buffer.from(base64Data, 'base64');

      if (eventData.length >= MIN_EVENT_SIZE) {
        const orderId = eventData
          .slice(ANCHOR_DISCRIMINATOR_SIZE, ANCHOR_DISCRIMINATOR_SIZE + ORDER_ID_SIZE)
          .toString('hex');

        // Validate it's not all zeros
        if (orderId !== '0'.repeat(64)) {
          return orderId;
        }
      }
    } catch {
      continue;
    }
  }

  // Fallback: look for order_id in log messages
  for (const log of logs) {
    const match = log.match(/order[_\s]?id[:\s]+([a-fA-F0-9]{64})/i);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return null;
}

/**
 * Extract cross-chain information from Program data logs.
 * The second Program data log typically contains full order details.
 */
function extractCrossChainInfoFromLogs(logs: string[]): {
  takeChainId?: number;
  takeTokenSymbol?: string;
  giveChainId?: number;
} | null {
  let programDataIndex = 0;

  for (const log of logs) {
    if (!log.startsWith('Program data:')) {
      continue;
    }

    programDataIndex++;

    // Skip first log (contains orderId), analyze second log for order details
    if (programDataIndex < 2) {
      continue;
    }

    try {
      const base64Data = log.replace('Program data:', '').trim();
      const data = Buffer.from(base64Data, 'base64');

      // Look for known chain IDs in the data
      const chainId = findChainIdInBuffer(data);
      if (chainId && chainId !== CHAIN_IDS.SOLANA) {
        return {
          takeChainId: chainId,
          giveChainId: CHAIN_IDS.SOLANA,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Search for a known chain ID in a buffer.
 */
function findChainIdInBuffer(data: Buffer): number | null {
  // Scan through buffer looking for valid chain IDs
  for (let offset = 0; offset < data.length - U64_SIZE; offset++) {
    try {
      const value = Number(data.readBigUInt64LE(offset));

      // Check if it's a known chain ID (excluding Solana - we're looking for destination)
      if (isKnownChainId(value) && value !== CHAIN_IDS.SOLANA) {
        return value;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// =============================================================================
// TOKEN BALANCE HELPERS
// =============================================================================

/**
 * Extract the primary token transfer from balance changes.
 * Identifies the largest balance change as the main transfer.
 */
function extractTokenTransfer(meta: ParsedTransactionWithMeta['meta']): {
  mint: string;
  amount: number;
  owner: string;
} | null {
  if (!meta) return null;

  const preBalances = meta.preTokenBalances ?? [];
  const postBalances = meta.postTokenBalances ?? [];

  // Build pre-balance lookup map
  const preBalanceMap = new Map<string, TokenBalance>();
  for (const bal of preBalances) {
    const key = `${bal.accountIndex}-${bal.mint}`;
    preBalanceMap.set(key, bal);
  }

  let maxChange = 0;
  let result: { mint: string; amount: number; owner: string } | null = null;

  // Find largest positive balance change
  for (const postBal of postBalances) {
    const key = `${postBal.accountIndex}-${postBal.mint}`;
    const preBal = preBalanceMap.get(key);

    const preAmount = Number(preBal?.uiTokenAmount?.amount ?? '0');
    const postAmount = Number(postBal.uiTokenAmount?.amount ?? '0');
    const change = postAmount - preAmount;

    if (change > maxChange) {
      maxChange = change;
      result = {
        mint: postBal.mint,
        amount: change,
        owner: postBal.owner ?? '',
      };
    }
  }

  // Check for new token accounts (not in pre-balances)
  for (const postBal of postBalances) {
    const key = `${postBal.accountIndex}-${postBal.mint}`;
    if (!preBalanceMap.has(key)) {
      const amount = Number(postBal.uiTokenAmount?.amount ?? '0');
      if (amount > maxChange) {
        maxChange = amount;
        result = {
          mint: postBal.mint,
          amount,
          owner: postBal.owner ?? '',
        };
      }
    }
  }

  // Fallback: check for native SOL transfers
  if (!result && meta.preBalances && meta.postBalances) {
    let maxSolChange = 0;

    for (let i = 0; i < meta.preBalances.length; i++) {
      const preSol = meta.preBalances[i];
      const postSol = meta.postBalances[i];
      const change = preSol - postSol;

      // Only consider significant outflows (excludes rent/fees)
      if (change > MIN_SOL_TRANSFER_LAMPORTS && change > maxSolChange) {
        maxSolChange = change;
        result = {
          mint: NATIVE_SOL_MINT,
          amount: change,
          owner: '',
        };
      }
    }
  }

  return result;
}

// =============================================================================
// TOKEN RESOLUTION
// =============================================================================

interface TokenInfo {
  symbol: string;
  decimals: number;
  estimatedPrice?: number;
}

/**
 * Resolve token information from mint address.
 * Checks both Solana and EVM token registries.
 */
function resolveToken(mint: string): TokenInfo | undefined {
  // Check Solana tokens
  if (KNOWN_TOKENS[mint]) {
    return KNOWN_TOKENS[mint];
  }

  // Check EVM tokens (normalized to lowercase)
  const normalizedMint = mint.toLowerCase();
  if (EVM_TOKENS[normalizedMint]) {
    return EVM_TOKENS[normalizedMint];
  }

  // Track unknown token
  const count = unknownTokens.get(mint) ?? 0;
  unknownTokens.set(mint, count + 1);

  // Log first occurrence only
  if (count === 0) {
    logger.debug({ mint }, 'Unknown token mint');
  }

  return undefined;
}

/**
 * Calculate USD value for a token amount.
 */
function calculateUsdValue(
  amount: bigint,
  decimals: number,
  tokenInfo?: TokenInfo
): number | undefined {
  if (!tokenInfo) {
    return undefined;
  }

  // Use explicit price or 1.0 for stablecoins
  const price = tokenInfo.estimatedPrice ??
    (isStablecoin(tokenInfo.symbol) ? 1 : undefined);

  if (price === undefined) {
    return undefined;
  }

  const rawAmount = Number(amount) / Math.pow(10, decimals);
  return rawAmount * price;
}

/**
 * Check if a token symbol represents a stablecoin.
 */
function isStablecoin(symbol: string): boolean {
  return STABLECOIN_SYMBOLS.includes(symbol as typeof STABLECOIN_SYMBOLS[number]);
}

// =============================================================================
// UTILITY HELPERS
// =============================================================================

/**
 * Find the first signer in a transaction (typically maker/taker).
 */
function findFirstSigner(tx: ParsedTransactionWithMeta): string | null {
  const accounts = tx.transaction.message.accountKeys;
  const signer = accounts.find(a => a.signer);
  return signer?.pubkey.toBase58() ?? null;
}
