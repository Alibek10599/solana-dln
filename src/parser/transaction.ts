/**
 * Transaction Parser for DLN Solana Events
 * 
 * Extracts amounts from token balance changes instead of
 * parsing instruction data - this is more reliable.
 */

import { 
  ParsedTransactionWithMeta, 
  TokenBalance,
} from '@solana/web3.js';
import { 
  DLN_SOURCE_PROGRAM_ID, 
  DLN_DESTINATION_PROGRAM_ID,
  KNOWN_TOKENS,
  EVM_TOKENS,
} from '../constants.js';
import type { OrderEvent } from '../db/clickhouse.js';
import { logger } from '../utils/logger.js';

// Track unknown tokens for debugging
const unknownTokens = new Map<string, number>();

/**
 * Parse a transaction and extract DLN order events
 */
export async function parseTransaction(
  tx: ParsedTransactionWithMeta,
  signature: string
): Promise<OrderEvent[]> {
  const events: OrderEvent[] = [];
  
  if (!tx.meta || tx.meta.err) {
    return events;
  }
  
  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();
  const slot = tx.slot;
  const logs = tx.meta.logMessages || [];
  
  // Check if this transaction involves DLN programs
  const instructions = tx.transaction.message.instructions;
  const innerInstructions = tx.meta.innerInstructions || [];
  
  let isDlnSource = false;
  let isDlnDestination = false;
  
  const dlnSourceId = DLN_SOURCE_PROGRAM_ID.toBase58();
  const dlnDestId = DLN_DESTINATION_PROGRAM_ID.toBase58();
  
  // Check all instructions for DLN program involvement
  for (const ix of instructions) {
    const programId = ix.programId.toBase58();
    if (programId === dlnSourceId) isDlnSource = true;
    if (programId === dlnDestId) isDlnDestination = true;
  }
  
  // Also check inner instructions
  for (const inner of innerInstructions) {
    for (const ix of inner.instructions) {
      const programId = ix.programId.toBase58();
      if (programId === dlnSourceId) isDlnSource = true;
      if (programId === dlnDestId) isDlnDestination = true;
    }
  }
  
  // Extract order ID from logs
  const orderId = extractOrderIdFromLogs(logs);
  
  if (isDlnSource && orderId) {
    const event = parseOrderCreation(tx, signature, slot, blockTime, orderId);
    if (event) events.push(event);
  }
  
  if (isDlnDestination && orderId) {
    const event = parseOrderFulfillment(tx, signature, slot, blockTime, orderId);
    if (event) events.push(event);
  }
  
  return events;
}

/**
 * Parse order creation from transaction
 * Extracts amounts from token balance changes
 */
function parseOrderCreation(
  tx: ParsedTransactionWithMeta,
  signature: string,
  slot: number,
  blockTime: Date,
  orderId: string
): OrderEvent | null {
  const meta = tx.meta!;
  
  // Get the maker (first signer)
  const accounts = tx.transaction.message.accountKeys;
  const maker = accounts.find(a => a.signer)?.pubkey.toBase58() || null;
  
  // Extract token transfer info from balance changes
  const tokenTransfer = extractTokenTransfer(meta);
  
  if (!tokenTransfer) {
    // Fallback: return basic info without token transfer data
    return {
      order_id: orderId,
      event_type: 'created',
      signature,
      slot,
      block_time: blockTime,
      maker: maker || undefined,
    };
  }
  
  // Resolve token info
  const tokenInfo = resolveToken(tokenTransfer.mint);
  const symbol = tokenInfo?.symbol;
  const decimals = tokenInfo?.decimals || 6;
  const price = tokenInfo?.estimatedPrice || (symbol === 'USDC' || symbol === 'USDT' ? 1 : undefined);
  
  // Calculate USD value
  const rawAmount = tokenTransfer.amount / Math.pow(10, decimals);
  const amountUsd = price ? rawAmount * price : undefined;
  
  logger.info({
    signature: signature.slice(0, 16),
    orderId: orderId.slice(0, 16),
    mint: tokenTransfer.mint.slice(0, 12),
    symbol,
    rawAmount: rawAmount.toFixed(2),
    amountUsd: amountUsd?.toFixed(2),
  }, 'Parsed order creation');
  
  return {
    order_id: orderId,
    event_type: 'created',
    signature,
    slot,
    block_time: blockTime,
    maker: maker || undefined,
    give_token_address: tokenTransfer.mint,
    give_token_symbol: symbol,
    give_amount: BigInt(Math.floor(tokenTransfer.amount)),
    give_amount_usd: amountUsd,
    give_chain_id: 7565164, // Solana chain ID
  };
}

/**
 * Parse order fulfillment from transaction
 */
function parseOrderFulfillment(
  tx: ParsedTransactionWithMeta,
  signature: string,
  slot: number,
  blockTime: Date,
  orderId: string
): OrderEvent | null {
  const meta = tx.meta!;
  
  // Get the taker (first signer)
  const accounts = tx.transaction.message.accountKeys;
  const taker = accounts.find(a => a.signer)?.pubkey.toBase58() || null;
  
  // Extract token transfer info
  const tokenTransfer = extractTokenTransfer(meta);
  
  let symbol: string | undefined;
  let amountUsd: number | undefined;
  let amount: bigint | undefined;
  
  if (tokenTransfer) {
    const tokenInfo = resolveToken(tokenTransfer.mint);
    symbol = tokenInfo?.symbol;
    const decimals = tokenInfo?.decimals || 6;
    const price = tokenInfo?.estimatedPrice || (symbol === 'USDC' || symbol === 'USDT' ? 1 : undefined);
    
    const rawAmount = tokenTransfer.amount / Math.pow(10, decimals);
    amountUsd = price ? rawAmount * price : undefined;
    amount = BigInt(Math.floor(tokenTransfer.amount));
  }
  
  return {
    order_id: orderId,
    event_type: 'fulfilled',
    signature,
    slot,
    block_time: blockTime,
    taker: taker || undefined,
    take_token_symbol: symbol,
    take_amount: amount,
    take_amount_usd: amountUsd,
    take_chain_id: 7565164, // Solana chain ID
  };
}

/**
 * Extract token transfer amount from balance changes
 */
function extractTokenTransfer(meta: ParsedTransactionWithMeta['meta']): {
  mint: string;
  amount: number;
  owner: string;
} | null {
  if (!meta) return null;
  
  const preBalances = meta.preTokenBalances || [];
  const postBalances = meta.postTokenBalances || [];
  
  // Find the largest balance change
  let maxChange = 0;
  let result: { mint: string; amount: number; owner: string } | null = null;
  
  // Create a map of pre-balances
  const preBalanceMap = new Map<string, TokenBalance>();
  for (const bal of preBalances) {
    const key = `${bal.accountIndex}-${bal.mint}`;
    preBalanceMap.set(key, bal);
  }
  
  // Compare with post-balances to find changes
  for (const postBal of postBalances) {
    const key = `${postBal.accountIndex}-${postBal.mint}`;
    const preBal = preBalanceMap.get(key);
    
    const preAmount = Number(preBal?.uiTokenAmount?.amount || '0');
    const postAmount = Number(postBal.uiTokenAmount?.amount || '0');
    const change = Math.abs(postAmount - preAmount);
    
    if (change > maxChange && change > 0) {
      maxChange = change;
      result = {
        mint: postBal.mint,
        amount: change,
        owner: postBal.owner || '',
      };
    }
  }
  
  // Check for new token accounts (where preBal doesn't exist)
  for (const postBal of postBalances) {
    const key = `${postBal.accountIndex}-${postBal.mint}`;
    if (!preBalanceMap.has(key)) {
      const amount = Number(postBal.uiTokenAmount?.amount || '0');
      if (amount > maxChange) {
        maxChange = amount;
        result = {
          mint: postBal.mint,
          amount,
          owner: postBal.owner || '',
        };
      }
    }
  }
  
  return result;
}

/**
 * Extract orderId from transaction logs
 */
function extractOrderIdFromLogs(logs: string[]): string | null {
  for (const log of logs) {
    // Look for Program data logs (Anchor events)
    if (log.startsWith('Program data:')) {
      try {
        const base64Data = log.replace('Program data:', '').trim();
        const eventData = Buffer.from(base64Data, 'base64');
        
        // Anchor events have 8-byte discriminator + data
        if (eventData.length >= 40) {
          const orderId = eventData.slice(8, 40).toString('hex');
          if (orderId !== '0'.repeat(64)) {
            return orderId;
          }
        }
      } catch {
        continue;
      }
    }
    
    // Also check for direct log matches
    const match = log.match(/order[_\s]?id[:\s]+([a-fA-F0-9]{64})/i);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

interface TokenInfo {
  symbol: string;
  decimals: number;
  estimatedPrice?: number;
}

/**
 * Resolve token info from mint address
 */
function resolveToken(mint: string): TokenInfo | undefined {
  if (KNOWN_TOKENS[mint]) {
    return KNOWN_TOKENS[mint];
  }
  
  const normalizedMint = mint.toLowerCase();
  if (EVM_TOKENS[normalizedMint]) {
    return EVM_TOKENS[normalizedMint];
  }
  
  // Track unknown tokens
  const count = unknownTokens.get(mint) || 0;
  unknownTokens.set(mint, count + 1);
  
  if (count === 0) {
    logger.info({ mint }, 'Unknown token mint');
  }
  
  return undefined;
}

// Parsing statistics
let parseStats = {
  total: 0,
  success: 0,
  failed: 0,
  noEvents: 0,
};

export function getParseStats() {
  return { ...parseStats };
}

export function resetParseStats() {
  parseStats = { total: 0, success: 0, failed: 0, noEvents: 0 };
}

export function getUnknownTokens(): Map<string, number> {
  return new Map(unknownTokens);
}

/**
 * Batch parse multiple transactions
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
        signature: sig 
      }, 'Failed to parse transaction');
    }
  }
  
  if (parseStats.total % 500 === 0) {
    logger.info({
      total: parseStats.total,
      success: parseStats.success,
      failed: parseStats.failed,
      noEvents: parseStats.noEvents,
      successRate: `${((parseStats.success / parseStats.total) * 100).toFixed(1)}%`,
      unknownTokenCount: unknownTokens.size,
    }, 'Parse statistics');
  }
  
  return allEvents;
}
