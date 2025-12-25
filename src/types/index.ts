/**
 * Types for DLN Order Events
 * Based on DLN Solana smart contract structure
 */

export interface OrderId {
  raw: Buffer;  // 32 bytes
  hex: string;
}

/**
 * Token offer/request in an order
 */
export interface TokenAmount {
  tokenAddress: Buffer;   // 32 bytes - token mint address on the chain
  amount: bigint;         // u64 - raw amount in smallest units
  chainId: bigint;        // u256 - chain ID
}

/**
 * Parsed OrderCreated event data
 */
export interface OrderCreatedEvent {
  orderId: string;
  signature: string;
  slot: number;
  blockTime: number;
  
  // Order details
  maker: string;                    // Order creator address
  giveTokenAddress: string;         // Token being given (on source chain)
  giveAmount: bigint;               // Amount being given
  giveChainId: bigint;              // Source chain ID
  
  takeTokenAddress: string;         // Token being received (on dest chain)
  takeAmount: bigint;               // Amount to receive
  takeChainId: bigint;              // Destination chain ID
  
  receiver: string;                 // Receiver address on destination chain
  
  // Optional affiliate info
  affiliateFee?: bigint;
  affiliateRecipient?: string;
  
  // Metadata
  nonce?: bigint;
  
  // USD values (calculated)
  giveAmountUsd?: number;
  takeAmountUsd?: number;
}

/**
 * Parsed OrderFulfilled event data
 */
export interface OrderFulfilledEvent {
  orderId: string;
  signature: string;
  slot: number;
  blockTime: number;
  
  // Fulfillment details
  taker: string;                    // Address that fulfilled the order
  takeTokenAddress: string;         // Token delivered
  takeAmount: bigint;               // Amount delivered
  
  // USD values (calculated)
  takeAmountUsd?: number;
}

/**
 * Combined order view for dashboard
 */
export interface Order {
  orderId: string;
  
  // Creation info
  createdAt?: number;
  createdSlot?: number;
  createdSignature?: string;
  maker?: string;
  giveTokenAddress?: string;
  giveAmount?: string;  // String for JSON serialization of bigint
  giveChainId?: number;
  giveAmountUsd?: number;
  
  takeTokenAddress?: string;
  takeAmount?: string;
  takeChainId?: number;
  takeAmountUsd?: number;
  receiver?: string;
  
  // Fulfillment info
  fulfilledAt?: number;
  fulfilledSlot?: number;
  fulfilledSignature?: string;
  taker?: string;
  
  // Status
  status: 'created' | 'fulfilled' | 'cancelled';
}

/**
 * Daily volume statistics
 */
export interface DailyVolume {
  date: string;  // YYYY-MM-DD
  
  // Created orders
  createdCount: number;
  createdVolumeUsd: number;
  
  // Fulfilled orders
  fulfilledCount: number;
  fulfilledVolumeUsd: number;
}

/**
 * Dashboard statistics
 */
export interface DashboardStats {
  totalOrdersCreated: number;
  totalOrdersFulfilled: number;
  totalVolumeCreatedUsd: number;
  totalVolumeFulfilledUsd: number;
  dailyVolumes: DailyVolume[];
  topTokens: { symbol: string; volume: number; count: number }[];
  recentOrders: Order[];
}

/**
 * Transaction parse result
 */
export interface ParsedTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  instructions: ParsedInstruction[];
  logs: string[];
}

export interface ParsedInstruction {
  programId: string;
  name: string;
  data: Record<string, unknown>;
  accounts: string[];
}

/**
 * Collection progress
 */
export interface CollectionProgress {
  totalCreated: number;
  totalFulfilled: number;
  lastCreatedSignature?: string;
  lastFulfilledSignature?: string;
  lastUpdated: number;
}
