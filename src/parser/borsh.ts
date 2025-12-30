/**
 * Borsh Deserializer for DLN Solana Instructions
 * 
 * This module provides low-level Borsh deserialization for DLN protocol
 * instruction data. Borsh (Binary Object Representation Serializer for Hashing)
 * is the serialization format used by Solana programs.
 * 
 * Reference: https://borsh.io/
 * DLN Docs: https://docs.debridge.finance/
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** Discriminator for DLN Source create_order instruction */
export const CREATE_ORDER_DISCRIMINATOR = '828362be28ce4432';

/** Discriminator for DLN Destination fulfill_order instruction */
export const FULFILL_ORDER_DISCRIMINATOR = 'TODO'; // Need to capture from real tx

/** Size of instruction discriminator in bytes */
export const DISCRIMINATOR_SIZE = 8;

/** Size of u64 in bytes */
export const U64_SIZE = 8;

/** Size of u256 in bytes */
export const U256_SIZE = 32;

/** Size of Solana public key in bytes */
export const PUBKEY_SIZE = 32;

/** Size of EVM address in bytes */
export const EVM_ADDRESS_SIZE = 20;

/** Size of length prefix (u32) in bytes */
export const LENGTH_PREFIX_SIZE = 4;

/** Known chain IDs in the DLN ecosystem */
export const CHAIN_IDS = {
  ETHEREUM: 1,
  OPTIMISM: 10,
  BSC: 56,
  GNOSIS: 100,
  POLYGON: 137,
  FANTOM: 250,
  BASE: 8453,
  ARBITRUM: 42161,
  AVALANCHE: 43114,
  SOLANA: 7565164,
} as const;

/** Chain ID to human-readable name mapping */
export const CHAIN_NAMES: Record<number, string> = {
  [CHAIN_IDS.ETHEREUM]: 'Ethereum',
  [CHAIN_IDS.OPTIMISM]: 'Optimism',
  [CHAIN_IDS.BSC]: 'BSC',
  [CHAIN_IDS.GNOSIS]: 'Gnosis',
  [CHAIN_IDS.POLYGON]: 'Polygon',
  [CHAIN_IDS.FANTOM]: 'Fantom',
  [CHAIN_IDS.BASE]: 'Base',
  [CHAIN_IDS.ARBITRUM]: 'Arbitrum',
  [CHAIN_IDS.AVALANCHE]: 'Avalanche',
  [CHAIN_IDS.SOLANA]: 'Solana',
};

// =============================================================================
// BORSH DESERIALIZER CLASS
// =============================================================================

/**
 * Low-level Borsh deserializer with offset tracking.
 * Reads primitive types from a buffer in little-endian format.
 */
export class BorshDeserializer {
  private readonly buffer: Buffer;
  private offset: number;

  constructor(data: Buffer | Uint8Array) {
    this.buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.offset = 0;
  }

  /** Get remaining bytes in buffer */
  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  /** Get current read position */
  get position(): number {
    return this.offset;
  }

  /** Get total buffer length */
  get length(): number {
    return this.buffer.length;
  }

  /**
   * Ensure we have enough bytes to read
   * @throws Error if not enough bytes remaining
   */
  private ensureBytes(count: number): void {
    if (this.offset + count > this.buffer.length) {
      throw new BorshDeserializationError(
        `Buffer overflow: need ${count} bytes at offset ${this.offset}, ` +
        `but only ${this.remaining} remaining`
      );
    }
  }

  /** Read unsigned 8-bit integer */
  readU8(): number {
    this.ensureBytes(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  /** Read unsigned 16-bit integer (little-endian) */
  readU16(): number {
    this.ensureBytes(2);
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  /** Read unsigned 32-bit integer (little-endian) */
  readU32(): number {
    this.ensureBytes(LENGTH_PREFIX_SIZE);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += LENGTH_PREFIX_SIZE;
    return value;
  }

  /** Read unsigned 64-bit integer (little-endian) */
  readU64(): bigint {
    this.ensureBytes(U64_SIZE);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += U64_SIZE;
    return value;
  }

  /** Read unsigned 128-bit integer (little-endian) */
  readU128(): bigint {
    this.ensureBytes(16);
    const low = this.buffer.readBigUInt64LE(this.offset);
    const high = this.buffer.readBigUInt64LE(this.offset + U64_SIZE);
    this.offset += 16;
    return low + (high << 64n);
  }

  /** Read unsigned 256-bit integer (little-endian) - used for chain IDs */
  readU256(): bigint {
    this.ensureBytes(U256_SIZE);
    // Read as 4 u64 values
    let value = 0n;
    for (let i = 0; i < 4; i++) {
      const part = this.buffer.readBigUInt64LE(this.offset + i * U64_SIZE);
      value += part << BigInt(i * 64);
    }
    this.offset += U256_SIZE;
    return value;
  }

  /** Read fixed-size byte array */
  readBytes(length: number): Buffer {
    this.ensureBytes(length);
    const bytes = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  /** Read bytes as hex string */
  readBytesAsHex(length: number): string {
    return this.readBytes(length).toString('hex');
  }

  /** Read Borsh Option<T> - returns null if None */
  readOption<T>(reader: () => T): T | null {
    const isSome = this.readU8();
    if (isSome === 0) {
      return null;
    }
    return reader();
  }

  /** Read length-prefixed byte array (Vec<u8>) */
  readVec(): Buffer {
    const length = this.readU32();
    return this.readBytes(length);
  }

  /** Read length-prefixed string */
  readString(): string {
    return this.readVec().toString('utf8');
  }

  /** Read boolean */
  readBool(): boolean {
    return this.readU8() !== 0;
  }

  /** Skip bytes without reading */
  skip(length: number): void {
    this.ensureBytes(length);
    this.offset += length;
  }

  /** Peek at bytes without advancing position */
  peek(length: number): Buffer {
    this.ensureBytes(length);
    return this.buffer.slice(this.offset, this.offset + length);
  }

  /** Check if discriminator matches */
  checkDiscriminator(expected: string): boolean {
    const actual = this.peek(DISCRIMINATOR_SIZE).toString('hex');
    return actual === expected;
  }

  /** Read and validate discriminator */
  readDiscriminator(expected?: string): string {
    const discriminator = this.readBytesAsHex(DISCRIMINATOR_SIZE);
    if (expected && discriminator !== expected) {
      throw new BorshDeserializationError(
        `Invalid discriminator: expected ${expected}, got ${discriminator}`
      );
    }
    return discriminator;
  }
}

// =============================================================================
// ERROR TYPES
// =============================================================================

/** Custom error for Borsh deserialization failures */
export class BorshDeserializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BorshDeserializationError';
  }
}

// =============================================================================
// DLN DATA STRUCTURES
// =============================================================================

/**
 * Parsed token amount with chain information.
 * Represents either give (source) or take (destination) side of an order.
 */
export interface TokenAmount {
  /** Token address (hex string, 20 bytes for EVM, 32 bytes for Solana) */
  tokenAddress: string;
  /** Raw token amount (before decimals) */
  amount: bigint;
  /** Chain ID where the token exists */
  chainId: bigint;
}

/**
 * Parsed DLN create_order instruction data.
 */
export interface CreateOrderData {
  /** Instruction discriminator (8 bytes hex) */
  discriminator: string;
  /** Amount being sent (give amount) */
  giveAmount: bigint;
  /** 32-byte field after amount (purpose unclear, possibly maker nonce or flags) */
  makerSrcField: string;
  /** Source token information */
  giveToken: TokenAmount | null;
  /** Destination token information */
  takeToken: TokenAmount | null;
  /** Receiver address on destination chain */
  receiverDst: string | null;
  /** Order authority address */
  orderAuthorityDst: string | null;
  /** Allowed taker (optional) */
  allowedTakerDst: string | null;
  /** Raw instruction data for debugging */
  rawDataHex: string;
}

// =============================================================================
// INSTRUCTION OFFSETS (discovered through analysis)
// =============================================================================

/**
 * Byte offsets for create_order instruction fields.
 * These were determined by analyzing real transaction data.
 */
const CREATE_ORDER_OFFSETS = {
  /** Discriminator starts at byte 0 */
  DISCRIMINATOR: 0,
  /** Give amount (u64) starts at byte 8 */
  GIVE_AMOUNT: DISCRIMINATOR_SIZE,
  /** 32-byte maker field starts at byte 16 */
  MAKER_SRC_FIELD: DISCRIMINATOR_SIZE + U64_SIZE,
  /** First length-prefixed field (give token address) starts at byte 48 */
  FIRST_LENGTH_PREFIX: DISCRIMINATOR_SIZE + U64_SIZE + PUBKEY_SIZE,
} as const;

// =============================================================================
// PARSING FUNCTIONS
// =============================================================================

/**
 * Parse a create_order instruction from DLN Source program.
 * 
 * Instruction layout (discovered through analysis):
 * - Bytes 0-8: Discriminator
 * - Bytes 8-16: Give Amount (u64)
 * - Bytes 16-48: Maker source field (32 bytes)
 * - Bytes 48+: Length-prefixed fields (token addresses, chain IDs, etc.)
 * 
 * @param data Raw instruction data as Buffer
 * @returns Parsed instruction data or null if parsing fails
 */
export function parseCreateOrderInstruction(data: Buffer): CreateOrderData | null {
  try {
    const reader = new BorshDeserializer(data);
    
    // Validate minimum length
    if (data.length < CREATE_ORDER_OFFSETS.FIRST_LENGTH_PREFIX) {
      return null;
    }

    // Read discriminator
    const discriminator = reader.readDiscriminator();
    if (discriminator !== CREATE_ORDER_DISCRIMINATOR) {
      return null;
    }

    // Read give amount (u64)
    const giveAmount = reader.readU64();

    // Read 32-byte maker field
    const makerSrcField = reader.readBytesAsHex(PUBKEY_SIZE);

    // Parse length-prefixed fields
    const giveToken = tryParseTokenAmount(reader);
    const takeToken = tryParseTokenAmount(reader);
    const receiverDst = tryReadLengthPrefixedAddress(reader);
    const orderAuthorityDst = tryReadLengthPrefixedAddress(reader);
    const allowedTakerDst = tryReadOptionalAddress(reader);

    return {
      discriminator,
      giveAmount,
      makerSrcField,
      giveToken,
      takeToken,
      receiverDst,
      orderAuthorityDst,
      allowedTakerDst,
      rawDataHex: data.toString('hex'),
    };
  } catch (error) {
    // Log error for debugging but don't throw
    if (process.env.DEBUG_BORSH) {
      console.error('[Borsh] Failed to parse create_order:', error);
    }
    return null;
  }
}

/**
 * Try to parse a TokenAmount structure (address + amount + chainId).
 * Returns null if parsing fails.
 */
function tryParseTokenAmount(reader: BorshDeserializer): TokenAmount | null {
  try {
    if (reader.remaining < LENGTH_PREFIX_SIZE) {
      return null;
    }

    // Read length prefix
    const addressLength = reader.readU32();
    
    // Validate address length (20 for EVM, 32 for Solana)
    if (addressLength !== EVM_ADDRESS_SIZE && addressLength !== PUBKEY_SIZE) {
      // Invalid length, might be a different field structure
      return null;
    }

    // Read token address
    const tokenAddress = reader.readBytesAsHex(addressLength);

    // After address, there should be more data for amount and chainId
    // But the structure is complex - let's just get the address for now
    // Chain ID appears to be embedded in a larger structure
    
    // Skip to find chain ID - it's usually after some padding
    // For now, return partial data
    return {
      tokenAddress: addressLength === EVM_ADDRESS_SIZE ? `0x${tokenAddress}` : tokenAddress,
      amount: 0n, // Would need more analysis to extract
      chainId: 0n, // Would need more analysis to extract
    };
  } catch {
    return null;
  }
}

/**
 * Try to read a length-prefixed address.
 */
function tryReadLengthPrefixedAddress(reader: BorshDeserializer): string | null {
  try {
    if (reader.remaining < LENGTH_PREFIX_SIZE) {
      return null;
    }

    const length = reader.readU32();
    
    if (length !== EVM_ADDRESS_SIZE && length !== PUBKEY_SIZE) {
      return null;
    }

    if (reader.remaining < length) {
      return null;
    }

    const address = reader.readBytesAsHex(length);
    return length === EVM_ADDRESS_SIZE ? `0x${address}` : address;
  } catch {
    return null;
  }
}

/**
 * Try to read an optional address (Option<Address>).
 */
function tryReadOptionalAddress(reader: BorshDeserializer): string | null {
  try {
    if (reader.remaining < 1) {
      return null;
    }

    const isSome = reader.readU8();
    if (isSome === 0) {
      return null;
    }

    return tryReadLengthPrefixedAddress(reader);
  } catch {
    return null;
  }
}

/**
 * Extract chain ID from a known position in the instruction data.
 * Based on analysis, chain IDs appear at specific offsets.
 */
export function extractChainIdFromBuffer(data: Buffer, searchStartOffset: number = 48): number | null {
  // Look for known chain IDs in the data
  for (let offset = searchStartOffset; offset < data.length - U64_SIZE; offset++) {
    try {
      const value = Number(data.readBigUInt64LE(offset));
      
      // Check if it's a known chain ID
      if (CHAIN_NAMES[value]) {
        return value;
      }
    } catch {
      continue;
    }
  }
  
  return null;
}

/**
 * Check if instruction data is a create_order instruction.
 */
export function isCreateOrderInstruction(data: Buffer): boolean {
  if (data.length < DISCRIMINATOR_SIZE) {
    return false;
  }
  return data.slice(0, DISCRIMINATOR_SIZE).toString('hex') === CREATE_ORDER_DISCRIMINATOR;
}

/**
 * Get human-readable chain name from chain ID.
 */
export function getChainName(chainId: number | bigint): string {
  const id = typeof chainId === 'bigint' ? Number(chainId) : chainId;
  return CHAIN_NAMES[id] || `Chain ${id}`;
}

/**
 * Check if a chain ID is valid/known.
 */
export function isKnownChainId(chainId: number | bigint): boolean {
  const id = typeof chainId === 'bigint' ? Number(chainId) : chainId;
  return id in CHAIN_NAMES;
}
