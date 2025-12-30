/**
 * Transaction Parser for DLN Solana Events
 * 
 * Extracts order data from:
 * 1. Instruction data (give amount via Borsh at offset 8)
 * 2. Program data logs (full order info including destination chain)
 * 3. Token balance changes (token identification)
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

// Track unknown tokens for debugging
const unknownTokens = new Map<string, number>();

// DLN Source discriminator for create_order
const CREATE_ORDER_DISCRIMINATOR = '828362be28ce4432';

// Known chain IDs
const CHAIN_IDS: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BSC',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum',
  43114: 'Avalanche',
  7565164: 'Solana',
};

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
 * Parse the second Program data log which contains full order info
 * This is the CreatedOrder event emitted by DLN
 */
function parseOrderEventFromLogs(logs: string[]): {
  orderId: string;
  takeChainId?: number;
  giveChainId?: number;
  takeTokenAddress?: string;
  giveTokenAddress?: string;
} | null {
  console.log('[PARSER DEBUG] parseOrderEventFromLogs called with', logs.length, 'logs');
  let programDataCount = 0;
  const programDataLogs: Array<{index: number, size: number, hex: string}> = [];

  for (const log of logs) {
    if (log.startsWith('Program data:')) {
      programDataCount++;

      try {
        const base64Data = log.replace('Program data:', '').trim();
        const data = Buffer.from(base64Data, 'base64');

        // Log all Program data we find
        programDataLogs.push({
          index: programDataCount,
          size: data.length,
          hex: data.slice(0, Math.min(200, data.length)).toString('hex'),
        });

        // First Program data is usually the orderId event
        if (programDataCount === 1 && data.length >= 40) {
          const orderId = data.slice(8, 40).toString('hex');
          if (orderId !== '0'.repeat(64)) {
            // Continue to find more data in subsequent logs
            continue;
          }
        }

        // Second Program data often contains the full order details
        if (programDataCount === 2 && data.length > 100) {
          // Parse the CreatedOrder event structure
          // Format varies but usually contains chain IDs at known offsets

          let offset = 8; // Skip discriminator

          // Try to find orderId first (32 bytes)
          const orderId = data.slice(offset, offset + 32).toString('hex');
          offset += 32;

          // Skip some fields to get to chain IDs
          // The structure has receiver address (32 bytes), then chain info

          // Look for chain ID patterns - Solana is 7565164 (0x736F6C in part)
          // Search for known chain ID bytes in the data
          let takeChainId: number | undefined;
          let giveChainId: number | undefined;

          // Solana chain ID: 7565164 = 0x00736F6C (little endian in 8 bytes: 6c 6f 73 00 00 00 00 00)
          const solanaChainBytes = Buffer.from([0x6c, 0x6f, 0x73, 0x00, 0x00, 0x00, 0x00, 0x00]);
          const solanaIndex = data.indexOf(solanaChainBytes);

          logger.info({
            dataLength: data.length,
            orderId: orderId.slice(0, 16),
            solanaIndex,
            searchingFrom: 40,
            searchingTo: data.length - 8,
          }, 'Searching for chain IDs in Program data log #2');

          if (solanaIndex !== -1) {
            // Found Solana chain ID - it's likely the give chain (source)
            giveChainId = 7565164;
            logger.info({ solanaIndex, giveChainId }, 'Found Solana chain ID');

            // Look for other chain IDs nearby
            // Common chains: 1 (Ethereum), 56 (BSC), 137 (Polygon), etc.
            const scannedChainIds: Array<{offset: number, value: number, inMap: boolean}> = [];
            for (let i = 40; i < data.length - 8; i += 8) {
              const possibleChainId = Number(data.readBigUInt64LE(i));
              if (possibleChainId > 0 && possibleChainId < 1000000 && possibleChainId !== 7565164) {
                const inMap = !!CHAIN_IDS[possibleChainId];
                scannedChainIds.push({ offset: i, value: possibleChainId, inMap });
                if (inMap) {
                  takeChainId = possibleChainId;
                  logger.info({ offset: i, takeChainId }, 'Found take chain ID');
                  break;
                }
              }
            }

            if (scannedChainIds.length > 0) {
              logger.info({ scannedChainIds: scannedChainIds.slice(0, 10) }, 'Chain IDs scanned');
            }
          } else {
            logger.info('Solana chain ID pattern not found in log #2');
          }

          if (orderId && orderId !== '0'.repeat(64)) {
            logger.info({
              orderId: orderId.slice(0, 16),
              giveChainId,
              takeChainId,
              success: true,
            }, 'Parsed order from logs');
            return {
              orderId,
              takeChainId,
              giveChainId,
            };
          }
        }
      } catch (err) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Error parsing Program data log');
        continue;
      }
    }
  }

  // Log summary of what we found
  if (programDataLogs.length > 0) {
    console.log('[PARSER DEBUG] Program data logs found but no valid order data:', {
      totalProgramDataLogs: programDataLogs.length,
      logs: programDataLogs.slice(0, 3), // first 3 logs only
    });
  }

  console.log('[PARSER DEBUG] parseOrderEventFromLogs returning null');
  return null;
}

/**
 * Parse DLN Source instruction (order creation)
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

    // Extract order ID and chain info from logs
    const orderInfo = parseOrderEventFromLogs(logs);
    const orderId = orderInfo?.orderId || extractOrderIdFromLogs(logs);

    console.log('[PARSER DEBUG] parseOrderEventFromLogs result:', {
      signature: signature.slice(0, 16),
      orderInfoFound: !!orderInfo,
      orderInfo,
      orderId: orderId?.slice(0, 16),
      giveChainIdFromInfo: orderInfo?.giveChainId,
      takeChainIdFromInfo: orderInfo?.takeChainId,
      logsCount: logs.length,
    });

    if (!orderId) {
      return null;
    }

    // Read give amount at offset 8 (u64, little-endian)
    const giveAmountRaw = buffer.readBigUInt64LE(8);

    // Scan for take_chain_id by searching for known chain IDs in the buffer
    // Known chain IDs: 1 (Ethereum), 56 (BSC), 137 (Polygon), 42161 (Arbitrum), 8453 (Base), 7565164 (Solana)
    let takeChainId: number | undefined;

    // Scan the entire buffer in 8-byte increments looking for valid chain IDs
    for (let offset = 16; offset < buffer.length - 8; offset += 8) {
      try {
        const chainIdBigInt = buffer.readBigUInt64LE(offset);
        const chainIdNum = Number(chainIdBigInt);

        // Check if this looks like a known chain ID
        if (chainIdNum > 0 && chainIdNum < 10000000) {
          if (CHAIN_IDS[chainIdNum]) {
            // Found a recognized chain ID, but make sure it's not the give chain (Solana)
            if (chainIdNum !== 7565164) {
              takeChainId = chainIdNum;
              break;
            }
          }
        }
      } catch {
        continue;
      }
    }

    // Get maker from transaction accounts
    const accounts = tx.transaction.message.accountKeys;
    const maker = accounts.find(a => a.signer)?.pubkey.toBase58() || null;

    // Get token info from balance changes
    const tokenTransfer = extractTokenTransfer(tx.meta);

    // Determine give token info
    let giveTokenSymbol: string | undefined;
    let giveTokenAddress: string | undefined;
    let giveAmountUsd: number | undefined;

    if (tokenTransfer) {
      giveTokenAddress = tokenTransfer.mint;
      const tokenInfo = resolveToken(tokenTransfer.mint);
      giveTokenSymbol = tokenInfo?.symbol;
      const decimals = tokenInfo?.decimals || 6;

      const price = tokenInfo?.estimatedPrice ||
        (giveTokenSymbol === 'USDC' || giveTokenSymbol === 'USDT' ? 1 : undefined);

      if (price) {
        const rawAmount = Number(giveAmountRaw) / Math.pow(10, decimals);
        giveAmountUsd = rawAmount * price;
      }
    }

    // Get chain IDs - give_chain is always Solana for created orders, take_chain from instruction data
    const giveChainId = 7565164; // Solana

    // Try to get take token symbol from instruction data
    // After offset 48, we have length-prefixed fields
    let takeTokenSymbol: string | undefined;

    if (buffer.length > 52) {
      // Read length prefix at offset 48
      const tokenAddrLen = buffer.readUInt32LE(48);

      if (tokenAddrLen === 20) {
        // EVM address (20 bytes)
        const evmAddr = '0x' + buffer.slice(52, 72).toString('hex');
        const tokenInfo = resolveToken(evmAddr);
        takeTokenSymbol = tokenInfo?.symbol;
      } else if (tokenAddrLen === 32) {
        // Solana address
        const solAddr = buffer.slice(52, 84).toString('hex');
        const tokenInfo = resolveToken(solAddr);
        takeTokenSymbol = tokenInfo?.symbol;
      }
    }

    console.log('[PARSER DEBUG] Final parsed order:', {
      signature: signature.slice(0, 16),
      orderId: orderId.slice(0, 16),
      giveAmount: giveAmountRaw.toString(),
      giveTokenSymbol,
      takeTokenSymbol,
      giveChainId,
      takeChainId,
      giveAmountUsd: giveAmountUsd?.toFixed(2),
    });

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
      give_chain_id: giveChainId,
      take_token_symbol: takeTokenSymbol,
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

  for (const postBal of postBalances) {
    const key = `${postBal.accountIndex}-${postBal.mint}`;
    const preBal = preBalanceMap.get(key);

    const preAmount = Number(preBal?.uiTokenAmount?.amount || '0');
    const postAmount = Number(postBal.uiTokenAmount?.amount || '0');
    const change = postAmount - preAmount;

    if (change > maxChange) {
      maxChange = change;
      result = {
        mint: postBal.mint,
        amount: change,
        owner: postBal.owner || '',
      };
    }
  }

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

  // Fallback: native SOL transfers
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
    logger.debug({ mint }, 'Unknown token mint');
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
