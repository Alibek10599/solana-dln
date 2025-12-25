# DLN Solana Dashboard

A dashboard for tracking DLN (deBridge Liquidity Network) order events on Solana. Collects and displays OrderCreated and OrderFulfilled events with daily USD volume analytics.

## Features

- **Low-level Borsh parsing** - Custom implementation of Borsh deserialization for DLN instruction data (no high-level libraries)
- **ClickHouse storage** - Optimized for time-series analytics with materialized views for fast aggregations
- **Real-time dashboard** - React dashboard with daily volume charts, top tokens, and recent orders
- **Resumable collection** - Progress tracking allows resuming from last checkpoint
- **50K+ orders target** - Collects at least 25K created and 25K fulfilled orders

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌────────────────┐
│  Solana RPC     │────▶│  Collector   │────▶│   ClickHouse   │
│  (Mainnet)      │     │  (Node.js)   │     │   Database     │
└─────────────────┘     └──────────────┘     └───────┬────────┘
                                                      │
                        ┌──────────────┐              │
                        │  API Server  │◀─────────────┘
                        │  (Express)   │
                        └──────┬───────┘
                               │
                        ┌──────▼───────┐
                        │  Dashboard   │
                        │  (React)     │
                        └──────────────┘
```

## Tech Stack

### Backend
- **Node.js + TypeScript** - Runtime and language
- **Custom Borsh Parser** - Low-level deserialization of Solana instructions
- **@solana/web3.js** - Solana RPC client
- **ClickHouse** - Analytics database for time-series data
- **Express** - API server

### Frontend  
- **React 18** - UI framework
- **Recharts** - Charts and visualizations
- **Tailwind CSS** - Styling
- **Vite** - Build tool

## DLN Program Addresses (Solana Mainnet)

| Program | Address | Purpose |
|---------|---------|---------|
| DlnSource | `src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4` | Order creation |
| DlnDestination | `dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo` | Order fulfillment |

## Quick Start

### Prerequisites

- Node.js 18+
- Docker (for ClickHouse)
- Solana RPC endpoint (public or Helius/QuickNode for better rate limits)

### 1. Start ClickHouse

```bash
docker-compose up -d
```

### 2. Install Dependencies

```bash
npm install
cd dashboard && npm install && cd ..
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Solana RPC URL
```

### 4. Initialize Database

```bash
npm run migrate
```

### 5. Collect Data

```bash
npm run collect
```

This will:
- Fetch transaction signatures from DlnSource and DlnDestination programs
- Parse transactions using low-level Borsh deserialization
- Extract OrderCreated and OrderFulfilled events
- Store in ClickHouse with progress checkpointing

### 6. Start API Server

```bash
npm run api
```

### 7. Start Dashboard

```bash
npm run dashboard
```

Open http://localhost:3000 in your browser.

## Project Structure

```
dln-solana-dashboard/
├── src/
│   ├── api/
│   │   └── server.ts        # Express API server
│   ├── collector/
│   │   └── index.ts         # Data collection script
│   ├── db/
│   │   ├── clickhouse.ts    # ClickHouse client & queries
│   │   └── migrate.ts       # Schema migration
│   ├── parser/
│   │   ├── borsh.ts         # Low-level Borsh deserializer ⭐
│   │   └── transaction.ts   # Transaction parsing logic
│   ├── types/
│   │   └── index.ts         # TypeScript types
│   ├── utils/
│   │   └── logger.ts        # Logging utility
│   └── constants.ts         # DLN addresses & config
├── dashboard/
│   └── src/
│       ├── components/      # React components
│       ├── hooks/           # Custom hooks
│       └── types/           # Frontend types
├── docker-compose.yml       # ClickHouse setup
└── package.json
```

## Low-Level Borsh Implementation

The project implements a custom Borsh deserializer (`src/parser/borsh.ts`) that:

1. **BorshDeserializer class** - Reads primitive types (u8, u16, u32, u64, u128, u256) in little-endian format
2. **Option<T> parsing** - Handles Rust's Option type (1-byte discriminator + optional value)
3. **Vec<u8> parsing** - Variable-length byte arrays with u32 length prefix
4. **DLN Order struct** - Parses the full order structure including token amounts and chain IDs

Example from the code:

```typescript
export class BorshDeserializer {
  readU64(): bigint {
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readU256(): bigint {
    const low = this.readU128();
    const high = this.readU128();
    return low + (high << 128n);
  }

  readOption<T>(reader: () => T): T | null {
    const isSome = this.readU8();
    if (isSome === 0) return null;
    return reader();
  }
}
```

## ClickHouse Schema

### Orders Table
```sql
CREATE TABLE orders (
  order_id String,
  event_type Enum8('created' = 1, 'fulfilled' = 2),
  signature String,
  slot UInt64,
  block_time DateTime,
  -- Order fields...
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(block_time)
ORDER BY (block_time, order_id, event_type)
```

### Materialized Views
- `daily_volumes_mv` - Pre-aggregated daily volumes
- `token_stats_mv` - Token-wise statistics

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/dashboard` | Full dashboard data in one call |
| `GET /api/stats` | Total counts and volumes |
| `GET /api/daily-volumes?days=30` | Daily volume time series |
| `GET /api/top-tokens?limit=10` | Top tokens by volume |
| `GET /api/recent-orders?limit=50` | Recent order events |
| `GET /api/collection-progress` | Collection progress status |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SOLANA_RPC_URL` | public mainnet | Solana RPC endpoint |
| `CLICKHOUSE_URL` | http://localhost:8123 | ClickHouse HTTP URL |
| `CLICKHOUSE_DATABASE` | dln_dashboard | Database name |
| `API_PORT` | 3001 | API server port |
| `TARGET_CREATED_ORDERS` | 25000 | Target created orders to collect |
| `TARGET_FULFILLED_ORDERS` | 25000 | Target fulfilled orders to collect |
| `SIGNATURES_BATCH_SIZE` | 1000 | Batch size for signature fetching |
| `TX_BATCH_SIZE` | 50 | Batch size for transaction fetching |
| `BATCH_DELAY_MS` | 200 | Delay between batches (rate limiting) |

## Development

```bash
# Run collector with hot reload
npx tsx watch src/collector/index.ts

# Run API with hot reload
npx tsx watch src/api/server.ts

# Run dashboard dev server
cd dashboard && npm run dev
```

## Notes

- **Rate Limiting**: Public Solana RPC has aggressive rate limits. For production, use Helius, QuickNode, or similar providers.
- **USD Values**: Currently only calculates USD for known stablecoins (USDC, USDT). Full implementation would require price feed integration.
- **Order ID Extraction**: Extracts from transaction logs (Anchor events) or instruction data.

## License

MIT
