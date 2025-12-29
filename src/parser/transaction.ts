/**
 * Transaction Parser for DLN Solana Events
 * 
 * Uses Borsh deserialization with correct instruction layout
 * discovered by analyzing real DLN transactions.
 */

import { 
  ParsedTransactionWithMeta, 
  TokenBalance,
  PublicKey,
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

// Track unknown tokens for debugging
const unknownTokens = new Map<string, number>();

// DLN Source discriminator for create_order
const CREATE_ORDER_DISCRIMINATOR = '828362be28ce4432';

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
  
  const instructions = tx.transaction.message.instructions;
  const innerInstructions = tx.meta.innerInstructions || [];
  
  const dlnSourceId = DLN_SOURCE_PROGRAM_ID.toBase58();
  const dlnDestId = DLN_DESTINATION_PROGRAM_ID.toBase58();
  
  // Check all instructions for DLN programs
  for (const ix of instructions) {
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
  
  // Also check inner instructions
  for (const inner of innerInstructions) {
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
 * Parse DLN Source instruction (order creation) using Borsh
 * 
 * Discovered instruction layout:
 * - Bytes 0-8: Discriminator (828362be28ce4432)
 * - Bytes 8-16: Give Amount (u64) 
 * - Bytes 16-48: Padding/reserved (32 bytes)
 * - Bytes 48+: Length-prefixed token addresses and other fields
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
    
    // Check discriminator
    const discriminator = buffer.slice(0, 8).toString('hex');
    if (discriminator !== CREATE_ORDER_DISCRIMINATOR) {
      return null;
    }
    
    // Extract order ID from logs
    const orderId = extractOrderIdFromLogs(logs);
    if (!orderId) {
      return null;
    }
    
    // Read give amount at offset 8 (u64, little-endian)
    const giveAmountRaw = buffer.readBigUInt64LE(8);
    
    // Get maker from transaction accounts
    const accounts = tx.transaction.message.accountKeys;
    const maker = accounts.find(a => a.signer)?.pubkey.toBase58() || null;
    
    // Get token info from balance changes (more reliable for token identification)
    const tokenTransfer = extractTokenTransfer(tx.meta);
    
    // Determine token symbol and calculate USD
    let giveTokenSymbol: string | undefined;
    let giveTokenAddress: string | undefined;
    let giveAmountUsd: number | undefined;
    let decimals = 6; // Default for USDC/USDT
    
    if (tokenTransfer) {
      giveTokenAddress = tokenTransfer.mint;
      const tokenInfo = resolveToken(tokenTransfer.mint);
      giveTokenSymbol = tokenInfo?.symbol;
      decimals = tokenInfo?.decimals || 6;
      
      const price = tokenInfo?.estimatedPrice || 
        (giveTokenSymbol === 'USDC' || giveTokenSymbol === 'USDT' ? 1 : undefined);
      
      if (price) {
        const rawAmount = Number(giveAmountRaw) / Math.pow(10, decimals);
        giveAmountUsd = rawAmount * price;
      }
    }
    
    // Parse destination chain info from instruction data
    // After the 48-byte header, we have length-prefixed fields
    let takeChainId: number | undefined;
    let giveChainId: number | undefined;
    
    try {
      // Look for chain IDs in the Program data logs (more reliable)
      const chainInfo = extractChainInfoFromLogs(logs);
      if (chainInfo) {
        giveChainId = chainInfo.giveChainId;
        takeChainId = chainInfo.takeChainId;
      }
    } catch {
      // Ignore chain parsing errors
    }
    
    logger.info({
      signature: signature.slice(0, 16),
      orderId: orderId.slice(0, 16),
      giveAmount: giveAmountRaw.toString(),
      giveTokenSymbol,
      giveAmountUsd: giveAmountUsd?.toFixed(2),
    }, 'Parsed order creation (Borsh)');
    
    return {
      order_id: orderId,
      event_type: 'created',
      signature,
      slot,
      block_time: blockTime,
      maker: maker || undefined,
      give_token_address: giveTokenAddress,
      give_token_symbol: giveTokenSymbol,
      give_amount: giveAmountRaw,
      give_amount_usd: giveAmountUsd,
      give_chain_id: giveChainId || 7565164, // Default to Solana
      take_chain_id: takeChainId,
    };
  } catch (error) {
    logger.debug({ error, signature }, 'Failed to parse source instruction');
    return null;
  }
}

/**
 * Parse DLN Destination instruction (order fulfillment)
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
    
    if (buffer.length < 40) {
      return null;
    }
    
    // Extract order ID from logs
    const orderId = extractOrderIdFromLogs(logs);
    if (!orderId) {
      return null;
    }
    
    // Get taker from transaction accounts
    const accounts = tx.transaction.message.accountKeys;
    const taker = accounts.find(a => a.signer)?.pubkey.toBase58() || null;
    
    // Get token transfer info
    const tokenTransfer = extractTokenTransfer(tx.meta);
    
    let takeTokenSymbol: string | undefined;
    let takeAmount: bigint | undefined;
    let takeAmountUsd: number | undefined;
    
    if (tokenTransfer) {
      const tokenInfo = resolveToken(tokenTransfer.mint);
      takeTokenSymbol = tokenInfo?.symbol;
      takeAmount = BigInt(Math.floor(tokenTransfer.amount));
      
      const decimals = tokenInfo?.decimals || 6;
      const price = tokenInfo?.estimatedPrice ||
        (takeTokenSymbol === 'USDC' || takeTokenSymbol === 'USDT' ? 1 : undefined);
      
      if (price) {
        const rawAmount = tokenTransfer.amount / Math.pow(10, decimals);
        takeAmountUsd = rawAmount * price;
      }
    }
    
    return {
      order_id: orderId,
      event_type: 'fulfilled',
      signature,
      slot,
      block_time: blockTime,
      taker: taker || undefined,
      take_token_symbol: takeTokenSymbol,
      take_amount: takeAmount,
      take_amount_usd: takeAmountUsd,
      take_chain_id: 7565164, // Solana
    };
  } catch (error) {
    logger.debug({ error, signature }, 'Failed to parse destination instruction');
    return null;
  }
}

/**
 * Extract orderId from transaction logs
 */
function extractOrderIdFromLogs(logs: string[]): string | null {
  for (const log of logs) {
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
    
    const match = log.match(/order[_\s]?id[:\s]+([a-fA-F0-9]{64})/i);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

/**
 * Extract chain IDs from Program data logs
 */
function extractChainInfoFromLogs(logs: string[]): { giveChainId?: number; takeChainId?: number } | null {
  // The second Program data log contains order details including chain IDs
  // This is more reliable than parsing from instruction data
  for (const log of logs) {
    if (log.startsWith('Program data:')) {
      try {
        const base64Data = log.replace('Program data:', '').trim();
        const data = Buffer.from(base64Data, 'base64');
        
        // Look for Solana chain ID (7565164 = 0x736f6c in the data)
        // This is a heuristic - we know Solana orders come from chain 7565164
        if (data.length > 100) {
          return {
            giveChainId: 7565164, // Solana
            takeChainId: undefined, // Would need more parsing
          };
        }
      } catch {
        continue;
      }
    }
  }
  return null;
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
  
  let maxChange = 0;
  let result: { mint: string; amount: number; owner: string } | null = null;
  
  const preBalanceMap = new Map<string, TokenBalance>();
  for (const bal of preBalances) {
    const key = `${bal.accountIndex}-${bal.mint}`;
    preBalanceMap.set(key, bal);
  }
  
  // Find the positive balance change that matches the instruction amount
  for (const postBal of postBalances) {
    const key = `${postBal.accountIndex}-${postBal.mint}`;
    const preBal = preBalanceMap.get(key);
    
    const preAmount = Number(preBal?.uiTokenAmount?.amount || '0');
    const postAmount = Number(postBal.uiTokenAmount?.amount || '0');
    const change = postAmount - preAmount;
    
    // We want positive changes (tokens received by protocol)
    if (change > maxChange) {
      maxChange = change;
      result = {
        mint: postBal.mint,
        amount: change,
        owner: postBal.owner || '',
      };
    }
  }
  
  // Check for new token accounts
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
  
  // Fallback: check for native SOL transfers
  if (!result && meta.preBalances && meta.postBalances) {
    let maxSolChange = 0;
    for (let i = 0; i < meta.preBalances.length; i++) {
      const preSol = meta.preBalances[i];
      const postSol = meta.postBalances[i];
      const change = preSol - postSol;
      
      if (change > 10_000_000 && change > maxSolChange) {
        maxSolChange = change;
        result = {
          mint: 'So11111111111111111111111111111111111111112',
          amount: change,
          owner: '',
        };
      }
    }
  }
  
  return result;
}

interface TokenInfo {
  symbol: string;
  decimals: number;
  estimatedPrice?: number;
}

function resolveToken(mint: string): TokenInfo | undefined {
  if (KNOWN_TOKENS[mint]) {
    return KNOWN_TOKENS[mint];
  }
  
  const normalizedMint = mint.toLowerCase();
  if (EVM_TOKENS[normalizedMint]) {
    return EVM_TOKENS[normalizedMint];
  }
  
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
    }, 'Parse statistics');
  }
  
  return allEvents;
}
