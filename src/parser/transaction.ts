/**
 * Transaction Parser for DLN Solana Events
 * 
 * Parses Solana transactions to extract DLN order events using
 * low-level Borsh deserialization combined with log analysis.
 */

import { 
  Connection, 
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
  SOLANA_CHAIN_ID,
} from '../constants.js';
import { 
  BorshDeserializer,
  hexToBase58,
} from './borsh.js';
import type { OrderEvent } from '../db/clickhouse.js';
import { logger } from '../utils/logger.js';

/**
 * Parse a transaction and extract DLN order events
 */
export async function parseTransaction(
  tx: ParsedTransactionWithMeta,
  signature: string
): Promise<OrderEvent[]> {
  const events: OrderEvent[] = [];
  
  if (!tx.meta || tx.meta.err) {
    // Skip failed transactions
    return events;
  }
  
  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();
  const slot = tx.slot;
  const logs = tx.meta.logMessages || [];
  
  // Get all instructions including inner instructions
  const instructions = tx.transaction.message.instructions;
  const innerInstructions = tx.meta.innerInstructions || [];
  
  // Process main instructions
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i];
    const programId = ix.programId.toBase58();
    
    // Check if this is a DLN instruction
    if (programId === DLN_SOURCE_PROGRAM_ID.toBase58()) {
      const event = await parseSourceInstruction(ix, signature, slot, blockTime, logs);
      if (event) events.push(event);
    } else if (programId === DLN_DESTINATION_PROGRAM_ID.toBase58()) {
      const event = await parseDestinationInstruction(ix, signature, slot, blockTime, logs);
      if (event) events.push(event);
    }
    
    // Also check inner instructions for this index
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
    // Check if it's a partially decoded instruction (has data)
    if (!('data' in ix)) {
      return null;
    }
    
    const data = Buffer.from(bs58.decode(ix.data));
    
    // Need at least 8 bytes for discriminator
    if (data.length < 8) {
      return null;
    }
    
    // Extract orderId from logs (most reliable method)
    const orderId = extractOrderIdFromLogs(logs, DLN_SOURCE_PROGRAM_ID.toBase58());
    if (!orderId) {
      logger.debug({ signature }, 'Could not extract orderId from logs');
      return null;
    }
    
    // Parse order data from instruction
    const orderData = parseCreateOrderData(data);
    if (!orderData) {
      return null;
    }
    
    // Get account addresses
    const accounts = 'accounts' in ix ? ix.accounts.map(a => a.toBase58()) : [];
    const maker = accounts[0] || null; // First account is usually the maker/signer
    
    // Resolve token symbols
    const giveTokenSymbol = resolveTokenSymbol(orderData.giveTokenAddress);
    const takeTokenSymbol = resolveTokenSymbol(orderData.takeTokenAddress);
    
    // Calculate USD values (simplified - using known stablecoin values)
    const giveAmountUsd = calculateUsdValue(
      orderData.giveTokenAddress,
      orderData.giveAmount,
      giveTokenSymbol
    );
    const takeAmountUsd = calculateUsdValue(
      orderData.takeTokenAddress,
      orderData.takeAmount,
      takeTokenSymbol
    );
    
    return {
      order_id: orderId,
      event_type: 'created',
      signature,
      slot,
      block_time: blockTime,
      maker: maker || undefined,
      give_token_address: orderData.giveTokenAddress,
      give_token_symbol: giveTokenSymbol,
      give_amount: orderData.giveAmount,
      give_amount_usd: giveAmountUsd,
      give_chain_id: Number(orderData.giveChainId),
      take_token_address: orderData.takeTokenAddress,
      take_token_symbol: takeTokenSymbol,
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
    
    // Extract orderId from logs
    const orderId = extractOrderIdFromLogs(logs, DLN_DESTINATION_PROGRAM_ID.toBase58());
    if (!orderId) {
      // Try parsing from instruction data
      const parsedOrderId = parseFulfillOrderData(data);
      if (!parsedOrderId) {
        logger.debug({ signature }, 'Could not extract orderId for fulfill');
        return null;
      }
    }
    
    // Get account addresses
    const accounts = 'accounts' in ix ? ix.accounts.map(a => a.toBase58()) : [];
    const taker = accounts[0] || null; // First account is usually the taker/signer
    
    // For fulfilled orders, we get limited data from the destination chain instruction
    // The main info we need is orderId and taker
    
    return {
      order_id: orderId || parseFulfillOrderData(data) || '',
      event_type: 'fulfilled',
      signature,
      slot,
      block_time: blockTime,
      taker: taker || undefined,
      // USD values would need to be calculated from transfer instructions
      // or cross-referenced with the created order
    };
  } catch (error) {
    logger.debug({ error, signature }, 'Failed to parse destination instruction');
    return null;
  }
}

/**
 * Extract orderId from transaction logs
 * 
 * DLN programs emit events using Anchor's emit! macro.
 * The event data is base64-encoded in "Program data:" log lines.
 */
function extractOrderIdFromLogs(logs: string[], programId: string): string | null {
  let inTargetProgram = false;
  
  for (const log of logs) {
    // Track which program is currently executing
    if (log.includes(`Program ${programId} invoke`)) {
      inTargetProgram = true;
    } else if (log.includes('Program log:') && inTargetProgram) {
      // Some programs log orderId directly
      const match = log.match(/order[_\s]?id[:\s]+([a-fA-F0-9]{64})/i);
      if (match) {
        return match[1].toLowerCase();
      }
    } else if (log.startsWith('Program data:') && inTargetProgram) {
      try {
        const base64Data = log.replace('Program data:', '').trim();
        const eventData = Buffer.from(base64Data, 'base64');
        
        // Anchor events: 8-byte discriminator + event data
        // OrderCreated/OrderFulfilled events have orderId as first 32 bytes after discriminator
        if (eventData.length >= 40) {
          const orderId = eventData.slice(8, 40).toString('hex');
          // Validate it looks like a valid orderId (not all zeros)
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

/**
 * Parse create_order instruction data
 */
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
    
    // Skip 8-byte discriminator
    reader.skip(8);
    
    // Skip maker nonce (u64)
    reader.readU64();
    
    // Skip maker address (32 bytes)
    reader.skip(32);
    
    // Give token
    const giveTokenBytes = reader.readBytes(32);
    const giveTokenAddress = tryParseAddress(giveTokenBytes);
    const giveAmount = reader.readU64();
    const giveChainId = reader.readU256();
    
    // Take token
    const takeTokenBytes = reader.readBytes(32);
    const takeTokenAddress = tryParseAddress(takeTokenBytes);
    const takeAmount = reader.readU64();
    const takeChainId = reader.readU256();
    
    // Receiver
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

/**
 * Parse fulfill_order instruction data to extract orderId
 */
function parseFulfillOrderData(data: Buffer): string | null {
  try {
    const reader = new BorshDeserializer(data);
    
    // Skip 8-byte discriminator
    reader.skip(8);
    
    // orderId is next 32 bytes
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
  // Check if it's a Solana address (all 32 bytes used)
  try {
    const pubkey = new PublicKey(bytes);
    return pubkey.toBase58();
  } catch {
    // Return as hex for EVM addresses or other chain addresses
    return '0x' + bytes.toString('hex');
  }
}

/**
 * Resolve token symbol from address
 */
function resolveTokenSymbol(address: string): string | undefined {
  // Check known tokens
  if (KNOWN_TOKENS[address]) {
    return KNOWN_TOKENS[address].symbol;
  }
  
  // Check if it looks like a stablecoin address
  // (This is a heuristic - in production you'd use an API)
  return undefined;
}

/**
 * Calculate USD value (simplified)
 * 
 * In production, you'd use price feeds (CoinGecko, Jupiter, etc.)
 * For now, we assume stablecoins = $1 and use rough estimates
 */
function calculateUsdValue(
  tokenAddress: string,
  amount: bigint,
  symbol?: string
): number | undefined {
  const tokenInfo = KNOWN_TOKENS[tokenAddress];
  
  if (!tokenInfo) {
    // Unknown token - can't calculate USD value without price feed
    return undefined;
  }
  
  const decimals = tokenInfo.decimals;
  const rawAmount = Number(amount) / Math.pow(10, decimals);
  
  // For stablecoins, 1:1 USD
  if (symbol === 'USDC' || symbol === 'USDT') {
    return rawAmount;
  }
  
  // For other tokens, we'd need a price feed
  // For demo purposes, skip USD calculation for non-stables
  return undefined;
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
    
    try {
      const events = await parseTransaction(tx, sig);
      allEvents.push(...events);
    } catch (error) {
      logger.debug({ error, signature: sig }, 'Failed to parse transaction');
    }
  }
  
  return allEvents;
}
