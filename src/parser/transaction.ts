/**
 * Transaction Parser for DLN Solana Events
 * 
 * Parses Solana transactions to extract DLN order events using
 * low-level Borsh deserialization combined with log analysis.
 */

import { 
  ParsedTransactionWithMeta, 
  PartiallyDecodedInstruction,
  ParsedInstruction,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { 
  DLN_SOURCE_PROGRAM_ID, 
  DLN_DESTINATION_PROGRAM_ID,
  KNOWN_TOKENS,
  EVM_TOKENS,
  getTokenInfo,
  SOLANA_CHAIN_ID,
} from '../constants.js';
import { 
  BorshDeserializer,
} from './borsh.js';
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
  
  const instructions = tx.transaction.message.instructions;
  const innerInstructions = tx.meta.innerInstructions || [];
  
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i];
    const programId = ix.programId.toBase58();
    
    if (programId === DLN_SOURCE_PROGRAM_ID.toBase58()) {
      const event = await parseSourceInstruction(ix, signature, slot, blockTime, logs);
      if (event) events.push(event);
    } else if (programId === DLN_DESTINATION_PROGRAM_ID.toBase58()) {
      const event = await parseDestinationInstruction(ix, signature, slot, blockTime, logs);
      if (event) events.push(event);
    }
    
    const inner = innerInstructions.find(ii => ii.index === i);
    if (inner) {
      for (const innerIx of inner.instructions) {
        const innerProgramId = innerIx.programId.toBase58();
        
        if (innerProgramId === DLN_SOURCE_PROGRAM_ID.toBase58()) {
          const event = await parseSourceInstruction(innerIx, signature, slot, blockTime, logs);
          if (event) events.push(event);
        } else if (innerProgramId === DLN_DESTINATION_PROGRAM_ID.toBase58()) {
          const event = await parseDestinationInstruction(innerIx, signature, slot, blockTime, logs);
          if (event) events.push(event);
        }
      }
    }
  }
  
  return events;
}

/**
 * Parse DLN Source instruction (order creation)
 */
async function parseSourceInstruction(
  ix: ParsedInstruction | PartiallyDecodedInstruction,
  signature: string,
  slot: number,
  blockTime: Date,
  logs: string[]
): Promise<OrderEvent | null> {
  try {
    if (!('data' in ix)) {
      return null;
    }
    
    const data = Buffer.from(bs58.decode(ix.data));
    
    if (data.length < 8) {
      return null;
    }
    
    const orderId = extractOrderIdFromLogs(logs, DLN_SOURCE_PROGRAM_ID.toBase58());
    if (!orderId) {
      logger.debug({ signature }, 'Could not extract orderId from logs');
      return null;
    }
    
    const orderData = parseCreateOrderData(data);
    if (!orderData) {
      return null;
    }
    
    const accounts = 'accounts' in ix ? ix.accounts.map(a => a.toBase58()) : [];
    const maker = accounts[0] || null;
    
    // Resolve token symbols and calculate USD
    const giveTokenInfo = resolveToken(orderData.giveTokenAddress);
    const takeTokenInfo = resolveToken(orderData.takeTokenAddress);
    
    const giveAmountUsd = calculateUsdValue(
      orderData.giveAmount,
      giveTokenInfo
    );
    const takeAmountUsd = calculateUsdValue(
      orderData.takeAmount,
      takeTokenInfo
    );
    
    return {
      order_id: orderId,
      event_type: 'created',
      signature,
      slot,
      block_time: blockTime,
      maker: maker || undefined,
      give_token_address: orderData.giveTokenAddress,
      give_token_symbol: giveTokenInfo?.symbol,
      give_amount: orderData.giveAmount,
      give_amount_usd: giveAmountUsd,
      give_chain_id: Number(orderData.giveChainId),
      take_token_address: orderData.takeTokenAddress,
      take_token_symbol: takeTokenInfo?.symbol,
      take_amount: orderData.takeAmount,
      take_amount_usd: takeAmountUsd,
      take_chain_id: Number(orderData.takeChainId),
      receiver: orderData.receiver,
    };
  } catch (error) {
    logger.debug({ error, signature }, 'Failed to parse source instruction');
    return null;
  }
}

/**
 * Parse DLN Destination instruction (order fulfillment)
 */
async function parseDestinationInstruction(
  ix: ParsedInstruction | PartiallyDecodedInstruction,
  signature: string,
  slot: number,
  blockTime: Date,
  logs: string[]
): Promise<OrderEvent | null> {
  try {
    if (!('data' in ix)) {
      return null;
    }
    
    const data = Buffer.from(bs58.decode(ix.data));
    
    if (data.length < 8) {
      return null;
    }
    
    let orderId = extractOrderIdFromLogs(logs, DLN_DESTINATION_PROGRAM_ID.toBase58());
    if (!orderId) {
      orderId = parseFulfillOrderData(data);
      if (!orderId) {
        logger.debug({ signature }, 'Could not extract orderId for fulfill');
        return null;
      }
    }
    
    const accounts = 'accounts' in ix ? ix.accounts.map(a => a.toBase58()) : [];
    const taker = accounts[0] || null;
    
    return {
      order_id: orderId,
      event_type: 'fulfilled',
      signature,
      slot,
      block_time: blockTime,
      taker: taker || undefined,
    };
  } catch (error) {
    logger.debug({ error, signature }, 'Failed to parse destination instruction');
    return null;
  }
}

/**
 * Extract orderId from transaction logs
 */
function extractOrderIdFromLogs(logs: string[], programId: string): string | null {
  let inTargetProgram = false;
  
  for (const log of logs) {
    if (log.includes(`Program ${programId} invoke`)) {
      inTargetProgram = true;
    } else if (log.includes('Program log:') && inTargetProgram) {
      const match = log.match(/order[_\s]?id[:\s]+([a-fA-F0-9]{64})/i);
      if (match) {
        return match[1].toLowerCase();
      }
    } else if (log.startsWith('Program data:') && inTargetProgram) {
      try {
        const base64Data = log.replace('Program data:', '').trim();
        const eventData = Buffer.from(base64Data, 'base64');
        
        if (eventData.length >= 40) {
          const orderId = eventData.slice(8, 40).toString('hex');
          if (orderId !== '0'.repeat(64)) {
            return orderId;
          }
        }
      } catch {
        continue;
      }
    } else if (log.includes(`Program ${programId} success`) || 
               log.includes(`Program ${programId} failed`)) {
      inTargetProgram = false;
    }
  }
  
  return null;
}

interface CreateOrderData {
  giveTokenAddress: string;
  giveAmount: bigint;
  giveChainId: bigint;
  takeTokenAddress: string;
  takeAmount: bigint;
  takeChainId: bigint;
  receiver: string;
}

function parseCreateOrderData(data: Buffer): CreateOrderData | null {
  try {
    const reader = new BorshDeserializer(data);
    
    reader.skip(8); // discriminator
    reader.readU64(); // maker nonce
    reader.skip(32); // maker address
    
    const giveTokenBytes = reader.readBytes(32);
    const giveTokenAddress = tryParseAddress(giveTokenBytes);
    const giveAmount = reader.readU64();
    const giveChainId = reader.readU256();
    
    const takeTokenBytes = reader.readBytes(32);
    const takeTokenAddress = tryParseAddress(takeTokenBytes);
    const takeAmount = reader.readU64();
    const takeChainId = reader.readU256();
    
    const receiverBytes = reader.readBytes(32);
    const receiver = tryParseAddress(receiverBytes);
    
    return {
      giveTokenAddress,
      giveAmount,
      giveChainId,
      takeTokenAddress,
      takeAmount,
      takeChainId,
      receiver,
    };
  } catch (error) {
    logger.debug({ error }, 'Failed to parse create order data');
    return null;
  }
}

function parseFulfillOrderData(data: Buffer): string | null {
  try {
    const reader = new BorshDeserializer(data);
    reader.skip(8);
    const orderId = reader.readBytes(32).toString('hex');
    if (orderId !== '0'.repeat(64)) {
      return orderId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to parse address bytes as Solana base58 or EVM hex
 */
function tryParseAddress(bytes: Buffer): string {
  try {
    const pubkey = new PublicKey(bytes);
    return pubkey.toBase58();
  } catch {
    return '0x' + bytes.toString('hex');
  }
}

interface TokenInfo {
  symbol: string;
  decimals: number;
  estimatedPrice?: number;
}

/**
 * Resolve token info from address (Solana or EVM)
 */
function resolveToken(address: string): TokenInfo | undefined {
  // Check Solana tokens
  if (KNOWN_TOKENS[address]) {
    return KNOWN_TOKENS[address];
  }
  
  // Check EVM tokens (normalize to lowercase)
  const normalizedAddress = address.toLowerCase();
  if (EVM_TOKENS[normalizedAddress]) {
    return EVM_TOKENS[normalizedAddress];
  }
  
  // Track unknown tokens for debugging
  const count = unknownTokens.get(address) || 0;
  unknownTokens.set(address, count + 1);
  
  // Log periodically
  if (count === 0 || count % 100 === 0) {
    logger.debug({ address, count }, 'Unknown token address');
  }
  
  return undefined;
}

/**
 * Calculate USD value using token info
 */
function calculateUsdValue(
  amount: bigint,
  tokenInfo?: TokenInfo
): number | undefined {
  if (!tokenInfo) {
    return undefined;
  }

  const decimals = tokenInfo.decimals;
  const rawAmount = Number(amount) / Math.pow(10, decimals);

  if (tokenInfo.estimatedPrice !== undefined) {
    return rawAmount * tokenInfo.estimatedPrice;
  }

  // Fallback for stablecoins
  if (tokenInfo.symbol === 'USDC' || tokenInfo.symbol === 'USDT' || tokenInfo.symbol === 'DAI') {
    return rawAmount;
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
  
  if (parseStats.total % 1000 === 0) {
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
