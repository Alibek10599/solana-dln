# DLN Solana Dashboard

A dashboard for tracking DLN (deBridge Liquidity Network) order events on Solana. Collects and displays OrderCreated and OrderFulfilled events with daily USD volume analytics.

## Features

- **Low-level Borsh parsing** - Custom implementation of Borsh deserialization for DLN instruction data (impressive approach, no high-level libraries)
- **ClickHouse storage** - Optimized for time-series analytics with ReplacingMergeTree for automatic deduplication
- **Robust data collection** - Exponential backoff, rate limiting, circuit breaker, and deduplication
- **Resumable collection** - Progress checkpointing allows resuming from last position
- **Real-time dashboard** - React dashboard with daily volume charts, top tokens, and recent orders
- **50K+ orders target** - Collects at least 25K created and 25K fulfilled orders

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌────────────────┐
│  Solana RPC     │────▶│  Collector   │────▶│   ClickHouse   │
│  (Mainnet)      │     │  (Node.js)   │     │   Database     │
└─────────────────┘     └──────────────┘     └───────┬────────┘
        │                      │                      │
        │              ┌───────┴───────┐              │
        │              │  Retry Logic  │              │
        │              │  Rate Limiter │              │
        │              │  Circuit Brkr │              │
        │              └───────────────┘              │
        │                                             │
        │               ┌──────────────┐              │
        └──────────────▶│  API Server  │◀─────────────┘
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
- **ClickHouse** - Analytics database with ReplacingMergeTree for deduplication
- **Express** - API server

### Reliability Features
- **Exponential Backoff** - Retries with increasing delays and jitter
- **Rate Limiter** - Token bucket algorithm to prevent RPC throttling
- **Circuit Breaker** - Fails fast when RPC is consistently unavailable
- **Deduplication** - Both application-level checks and DB-level (ReplacingMergeTree)

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
# Edit .env with your Solana RPC URL and rate limit settings
```

**Important:** For collecting 50K+ orders, a premium RPC provider is recommended:
- **Public RPC**: ~2-5 req/s (will take several hours)
- **Helius free tier**: ~10 req/s
- **Premium RPC**: 50-100+ req/s

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
- Deduplicate events before insertion
- Store in ClickHouse with progress checkpointing
- Resume automatically if interrupted

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
│   │   └── server.ts          # Express API server
│   ├── collector/
│   │   └── index.ts           # Data collection with retry/rate limiting
│   ├── db/
│   │   ├── clickhouse.ts      # ClickHouse client with deduplication
│   │   └── migrate.ts         # Schema migration
│   ├── parser/
│   │   ├── borsh.ts           # Low-level Borsh deserializer ⭐
│   │   └── transaction.ts     # Transaction parsing logic
│   ├── types/
│   │   └── index.ts           # TypeScript types
│   ├── utils/
│   │   ├── logger.ts          # Logging utility
│   │   └── retry.ts           # Retry, rate limiter, circuit breaker ⭐
│   └── constants.ts           # DLN addresses & config
├── dashboard/
│   └── src/
│       ├── components/        # React components
│       ├── hooks/             # Custom hooks
│       └── types/             # Frontend types
├── docker-compose.yml         # ClickHouse setup
└── package.json
```

## Reliability Features

### Retry with Exponential Backoff

```typescript
// Automatically retries with increasing delays
const result = await withRetry(
  () => connection.getParsedTransactions(signatures),
  {
    maxRetries: 5,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    jitterFactor: 0.3,  // Prevents thundering herd
  }
);
```

### Rate Limiter (Token Bucket)

```typescript
// Limits requests to prevent RPC throttling
const rateLimiter = new RateLimiter(5, 2);  // 5 burst, 2 req/s sustained
await rateLimiter.acquire();  // Waits if necessary
```

### Circuit Breaker

```typescript
// Fails fast when RPC is consistently unavailable
const circuitBreaker = new CircuitBreaker(10, 60000);  // 10 failures, 60s timeout

const result = await circuitBreaker.execute(async () => {
  return await fetchData();  // Opens circuit after 10 consecutive failures
});
```

### Deduplication

1. **Application-level**: Checks existing signatures before insert
2. **Database-level**: ReplacingMergeTree merges duplicates by `(signature, event_type)`

```sql
ENGINE = ReplacingMergeTree(_version)
ORDER BY (signature, event_type)  -- Unique constraint
```

## Low-Level Borsh Implementation

The project implements a custom Borsh deserializer (`src/parser/borsh.ts`) that:

1. **BorshDeserializer class** - Reads primitive types (u8, u16, u32, u64, u128, u256) in little-endian format
2. **Option<T> parsing** - Handles Rust's Option type (1-byte discriminator + optional value)
3. **Vec<u8> parsing** - Variable-length byte arrays with u32 length prefix
4. **DLN Order struct** - Parses the full order structure including token amounts and chain IDs

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

### Orders Table (with deduplication)
```sql
CREATE TABLE orders (
  order_id String,
  event_type Enum8('created' = 1, 'fulfilled' = 2),
  signature String,
  slot UInt64,
  block_time DateTime,
  -- ... other fields
  _version UInt64 DEFAULT toUnixTimestamp(now())
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(block_time)
ORDER BY (signature, event_type)  -- Deduplication key
```

### Materialized Views
- `daily_volumes_mv` - Pre-aggregated daily volumes (SummingMergeTree)
- `token_stats_mv` - Token-wise statistics

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/dashboard` | Full dashboard data in one call |
| `GET /api/stats` | Total counts and volumes (deduplicated) |
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
| `TARGET_CREATED_ORDERS` | 25000 | Target created orders |
| `TARGET_FULFILLED_ORDERS` | 25000 | Target fulfilled orders |
| `SIGNATURES_BATCH_SIZE` | 1000 | Signatures per RPC call |
| `TX_BATCH_SIZE` | 20 | Transactions per RPC call |
| `BATCH_DELAY_MS` | 500 | Delay between batches |
| `RATE_LIMIT_RPS` | 2 | Max requests per second |
| `LOG_LEVEL` | info | Logging verbosity |

### Recommended Settings by RPC Provider

| Provider | `TX_BATCH_SIZE` | `RATE_LIMIT_RPS` | Est. Time for 50K |
|----------|-----------------|------------------|-------------------|
| Public RPC | 20 | 2 | 4-6 hours |
| Helius Free | 30 | 10 | 1-2 hours |
| Helius Paid | 50 | 50 | 15-30 min |
| Triton/Premium | 100 | 100 | 10-15 min |

## Development

```bash
# Run collector with hot reload
npx tsx watch src/collector/index.ts

# Run API with hot reload
npx tsx watch src/api/server.ts

# Run dashboard dev server
cd dashboard && npm run dev
```

## Scaling Considerations

For a production system processing millions of orders:

1. **Use Temporal** - For durable workflows with automatic retry and state persistence
2. **Horizontal scaling** - Multiple collector workers with different signature ranges
3. **Streaming** - Use Geyser plugins or Yellowstone gRPC for real-time updates
4. **ClickHouse cluster** - For higher insert throughput and query performance

## License

MIT
