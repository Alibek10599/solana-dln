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

### Option 1: Docker (Recommended)

```bash
# Clone and enter directory
cd dln-solana-dashboard

# Create .env file with your Solana RPC URL
echo "SOLANA_RPC_URL=https://api.mainnet-beta.solana.com" > .env

# Start everything (automatically runs migrations)
make up
# Or: docker-compose up -d && sleep 5 && docker-compose exec api node dist/db/migrate.js

# Start collection workflow
make collect
# Or: docker-compose exec worker node dist/temporal/client.js start

# Watch progress
make watch
# Or: docker-compose exec worker node dist/temporal/client.js watch
```

**Services:**
| Service | URL | Description |
|---------|-----|-------------|
| Dashboard | http://localhost:3000 | React frontend |
| API | http://localhost:3001 | Backend API |
| Temporal UI | http://localhost:8233 | Workflow monitoring |
| ClickHouse | http://localhost:8123 | Database |

### Option 2: Local Development

#### Prerequisites

- Node.js 18+
- Docker (for ClickHouse and Temporal)
- Solana RPC endpoint (public or Helius/QuickNode)

### 1. Start Infrastructure

```bash
# Start ClickHouse, Temporal, and database
make dev
# Or: docker-compose up -d clickhouse temporal temporal-db temporal-ui
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
# Note: 'make up' runs this automatically, but for local dev you need to run it manually
```

### 5. Start Services

```bash
# Terminal 1: Start API server
npm run api

# Terminal 2: Start Temporal worker
npm run worker

# Terminal 3: Start dashboard
npm run dashboard
```

### 6. Start Collection

Use Makefile commands to manage the Temporal workflow:

```bash
make collect  # Start collection workflow
make watch    # Watch progress
make status   # Check status
```

The collection workflow will:
- Fetch transaction signatures from DlnSource and DlnDestination programs
- Parse transactions using low-level Borsh deserialization
- Deduplicate events before insertion
- Store in ClickHouse with progress checkpointing
- Resume automatically if interrupted

**Access the services:**
- Dashboard: http://localhost:3000
- API: http://localhost:3001
- Temporal UI: http://localhost:8233

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
# Start infrastructure
make dev

# Run API with hot reload
npx tsx watch src/api/server.ts

# Run Temporal worker with hot reload
npx tsx watch src/temporal/worker.ts

# Run dashboard dev server
npm run dashboard
```

## Temporal Workflow Collection

For production systems, the project includes a **Temporal-based collector** with:

- **Child Workflows** - Parallel collection of created/fulfilled orders
- **Separate Task Queues** - RPC activities vs DB activities for optimal resource usage
- **Connection Pooling** - Reuses Solana connections across activities
- **Error Classification** - Retryable vs non-retryable errors
- **Durable Execution** - Survives crashes and restarts
- **Queryable State** - Check progress anytime via queries
- **Pause/Resume** - Control collection via signals

### Temporal Quick Start (Docker)

```bash
# Start all services (includes migrations)
make up

# Start collection workflow
make collect

# Watch progress
make watch

# View in Temporal UI
open http://localhost:8233
```

### Temporal Commands

| Command | Description |
|---------|-------------|
| `make collect` | Start collection workflow |
| `make status` | Check collection status |
| `make watch` | Watch progress (auto-refresh) |
| `make pause` | Pause collection |
| `make resume` | Resume collection |
| `make cancel` | Cancel collection |

**For local development:**
```bash
make dev          # Start infrastructure only
npm run worker    # Start Temporal worker locally
make collect      # Start collection workflow
```

### Temporal Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           TEMPORAL SERVER                                     │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                    collectAllOrdersWorkflow (Parent)                     │ │
│  │                              │                                           │ │
│  │              ┌───────────────┴───────────────┐                          │ │
│  │              ▼                               ▼                          │ │
│  │  ┌─────────────────────────┐   ┌─────────────────────────┐              │ │
│  │  │ collectOrdersWorkflow   │   │ collectOrdersWorkflow   │              │ │
│  │  │ (Child: created)        │   │ (Child: fulfilled)      │              │ │
│  │  │                         │   │                         │   PARALLEL!  │ │
│  │  │ ┌─────┐ ┌─────┐ ┌─────┐│   │ ┌─────┐ ┌─────┐ ┌─────┐│              │ │
│  │  │ │fetch│→│parse│→│store││   │ │fetch│→│parse│→│store││              │ │
│  │  │ └─────┘ └─────┘ └─────┘│   │ └─────┘ └─────┘ └─────┘│              │ │
│  │  └───────────┬─────────────┘   └───────────┬─────────────┘              │ │
│  │              │                             │                            │ │
│  │              └──────────────┬──────────────┘                            │ │
│  │                             ▼                                           │ │
│  │                      continueAsNew                                      │ │
│  │                  (every 50 iterations)                                  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                         TASK QUEUES                                      │ │
│  │                                                                          │ │
│  │   dln-collector          dln-rpc              dln-db                    │ │
│  │   (workflows)            (RPC activities)     (DB activities)           │ │
│  │        │                      │                    │                    │ │
│  │        │    Rate Limited      │    High Throughput │                    │ │
│  │        │    10 req/s          │                    │                    │ │
│  └────────┼──────────────────────┼────────────────────┼────────────────────┘ │
│           │                      │                    │                      │
└───────────┼──────────────────────┼────────────────────┼──────────────────────┘
            ▼                      ▼                    ▼
    ┌──────────────┐       ┌──────────────┐     ┌──────────────┐
    │   Worker 1   │       │   Worker 2   │     │   Worker 3   │
    │  (full mode) │       │  (rpc mode)  │     │  (db mode)   │
    │              │       │              │     │              │
    │ All queues   │       │ RPC only     │     │ DB only      │
    └──────────────┘       └──────────────┘     └──────────────┘
```

### Activity Configuration

| Activity | Queue | Timeout | Max Retries | Backoff |
|----------|-------|---------|-------------|----------|
| `fetchSignaturesBatch` | dln-rpc | 3 min | 10 | 2s → 60s |
| `fetchAndParseTransactions` | dln-rpc | 10 min | 5 | 5s → 2min |
| `storeEvents` | dln-db | 1 min | 5 | 500ms → 10s |
| `getProgress` | dln-db | 1 min | 5 | 500ms → 10s |
| `initializeDatabase` | dln-db | 1 min | 3 | default |

### Scaling with Temporal

**Development (single machine):**
```bash
# Docker: Start with all services
make up

# Local: Start infrastructure + worker
make dev
npm run worker
```

**Production (Docker with scaled workers):**
```bash
# Start with scaled workers and monitoring
make up-scaled

# This automatically starts:
# - 1x Full worker (workflows + all activities)
# - 2x RPC workers (rate-limited Solana operations)
# - 2x DB workers (high-throughput database operations)
# - Prometheus + Grafana for monitoring
```

**Production (multiple machines):**
```bash
# Machine 1: Main worker
WORKER_MODE=full npm run worker

# Machine 2-N: RPC workers (rate limited)
WORKER_MODE=rpc WORKER_ACTIVITIES_PER_SECOND=10 npm run worker

# Machine N+1: DB worker (high throughput)
WORKER_MODE=db WORKER_MAX_ACTIVITIES=20 npm run worker
```

### Worker Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `WORKER_MODE` | full | Worker mode: full, rpc, db, workflow |
| `WORKER_MAX_WORKFLOW_TASKS` | 10 | Max concurrent workflow tasks |
| `WORKER_MAX_ACTIVITIES` | 5 | Max concurrent activities |
| `WORKER_ACTIVITIES_PER_SECOND` | 10 | Rate limit for RPC activities |

## Comparison: Simple vs Temporal Collector

| Feature | Simple Collector | Temporal Collector |
|---------|------------------|-------------------|
| Setup complexity | Low | Medium |
| Crash recovery | Manual restart | Automatic |
| Progress visibility | Logs only | UI + Queries |
| Pause/Resume | No | Yes |
| Retry logic | Application code | Declarative policies |
| Horizontal scaling | Manual | Built-in |
| History/Audit | None | Full history |
| Best for | Development, small jobs | Production, large jobs |

## Docker Commands

### Using docker-compose

```bash
# Build all images
docker-compose build

# Start all services
docker-compose up -d

# Start infrastructure only (for local development)
docker-compose up -d clickhouse temporal temporal-db temporal-ui

# View logs
docker-compose logs -f api worker

# Stop all services
docker-compose down

# Clean up (remove volumes)
docker-compose down -v
```

### Using Makefile

```bash
# Start everything
make up

# Start infrastructure only
make dev

# View logs
make logs

# Start collection
make collect

# Watch progress
make watch

# Scale RPC workers
make scale-rpc N=3

# Clean up
make clean
```

### Scaling Workers

```bash
# Start with scaled profile (includes worker-rpc and worker-db)
docker-compose --profile scaled up -d

# Scale specific worker type
docker-compose --profile scaled up -d --scale worker-rpc=3

# Or use Makefile (includes monitoring)
make up-scaled
make scale-rpc N=3
```

### Monitoring

The project includes Prometheus and Grafana for monitoring:

```bash
# Start monitoring stack only
make monitoring

# Or include monitoring with scaled workers
make up-scaled

# Access monitoring services
# Prometheus: http://localhost:9090
# Grafana: http://localhost:3002 (admin/admin)
```

**What's monitored:**
- RPC connection pool health and circuit breaker status
- API request rates and response times
- Worker activity execution metrics
- ClickHouse query performance
- Collection progress and throughput

## Project Structure

```
dln-solana-dashboard/
├── src/
│   ├── api/
│   │   └── server.ts          # Express API server
│   ├── collector/
│   │   └── index.ts           # Simple collector (non-Temporal)
│   ├── temporal/
│   │   ├── activities.ts      # Temporal activities
│   │   ├── workflows.ts       # Temporal workflows
│   │   ├── worker.ts          # Temporal worker
│   │   └── client.ts          # CLI client
│   ├── db/
│   │   ├── clickhouse.ts      # Database client
│   │   └── migrate.ts         # Schema migration
│   ├── parser/
│   │   ├── borsh.ts           # Low-level Borsh deserializer ⭐
│   │   └── transaction.ts     # Transaction parsing
│   └── utils/
│       ├── logger.ts          # Logging
│       └── retry.ts           # Retry utilities
├── dashboard/
│   ├── src/
│   │   ├── components/        # React components
│   │   ├── hooks/             # Custom hooks
│   │   └── types/             # TypeScript types
│   ├── Dockerfile             # Frontend Docker image
│   └── nginx.conf             # Nginx configuration
├── Dockerfile                 # Backend Docker image
├── docker-compose.yml         # Full stack deployment
├── Makefile                   # Convenience commands
└── package.json
```

## License

MIT
