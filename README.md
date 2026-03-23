# QuaiVault Indexer

A blockchain indexing service for QuaiVault multisig wallets on Quai Network. Indexes on-chain events to Supabase for fast queries and real-time updates.

## Features

- Indexes 31 event types from QuaiVault, Factory, and module contracts (plus ERC20/ERC721/ERC1155 Transfer wildcards)
- Real-time updates via Supabase Realtime subscriptions
- Historical backfill with resume capability
- Transaction type decoding (transfer, wallet_admin, module_config, etc.)
- Social recovery module support
- ERC20/ERC721/ERC1155 token auto-discovery and transfer tracking
- EIP-1271 message signing tracking
- Health check endpoint for monitoring and orchestration
- Graceful shutdown and error recovery

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      QuaiVault Indexer                      │
├─────────────────────────────────────────────────────────────┤
│  Polling Loop → Event Decoder → Event Handlers → Supabase  │
└─────────────────────────────────────────────────────────────┘
         │                                        │
         ▼                                        ▼
┌─────────────────────┐              ┌─────────────────────────┐
│   Quai Network RPC  │              │  Supabase (PostgreSQL)  │
│   (Cyprus1 Shard)   │              │  + Realtime + RLS       │
└─────────────────────┘              └─────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Supabase project with schema deployed
- Quai Network RPC access

### Installation

```bash
npm install
```

### Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
QUAIVAULT_FACTORY_ADDRESS=0x...
QUAIVAULT_IMPLEMENTATION_ADDRESS=0x...

# Optional - Module and utility contracts (if deployed)
SOCIAL_RECOVERY_MODULE_ADDRESS=0x...
MULTISEND_CALL_ONLY_ADDRESS=0x...

# Optional - Indexer settings (use base URL without shard path)
QUAI_RPC_URL=https://rpc.orchard.quai.network
BATCH_SIZE=1000
POLL_INTERVAL=5000
START_BLOCK=0
CONFIRMATIONS=2

# Optional - Logging
LOG_LEVEL=info
LOG_TO_FILE=false
NODE_ENV=development

# Optional - Health check
HEALTH_CHECK_ENABLED=true
HEALTH_CHECK_PORT=8080
HEALTH_MAX_BLOCKS_BEHIND=100
# HEALTH_CHECK_HOST=0.0.0.0
# TRUSTED_PROXIES=10.0.0.1,10.0.0.2
```

### Database Setup

Run the schema in Supabase SQL Editor:

```bash
# Fresh setup
supabase/migrations/schema.sql

# Reset and reinitialize (WARNING: deletes all data)
supabase/reset_and_init.sql
```

### Running

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start

# Standalone backfill
BACKFILL_FROM=5000000 BACKFILL_TO=5100000 npm run backfill
```

## Project Structure

```
src/
├── index.ts                # Entry point with graceful shutdown
├── config.ts               # Environment configuration with validation
├── indexer.ts              # Core indexer with polling loop
├── backfill.ts             # Standalone historical backfill script
├── events/
│   ├── index.ts            # Event dispatcher (routes decoded events to handlers)
│   ├── factory.ts          # WalletCreated, WalletRegistered
│   ├── vault-core.ts       # Transaction*, Owner*, Threshold*, Module*, Received
│   ├── zodiac.ts           # ExecutionFromModuleSuccess/Failure
│   ├── social-recovery.ts  # Recovery* events
│   ├── message-signing.ts  # MessageSigned, MessageUnsigned
│   ├── token-transfer.ts   # ERC20/ERC721/ERC1155 Transfer events
│   └── helpers.ts          # validateEventArgs, safeParseInt, safeParseHex
├── services/
│   ├── quai.ts             # Quai RPC client with retry
│   ├── supabase.ts         # Database operations
│   ├── decoder.ts          # Event & calldata decoding
│   ├── block-processor.ts  # Block range processing with token auto-discovery
│   └── health.ts           # Health check HTTP server
├── types/
│   └── index.ts            # TypeScript interfaces
└── utils/
    ├── logger.ts           # Pino logger with rotation
    ├── retry.ts            # Exponential backoff utility
    ├── validation.ts       # Address, bytes32, block number validation
    ├── circuit-breaker.ts  # Circuit breaker for RPC fault tolerance
    ├── rate-limiter.ts     # Token bucket rate limiter for RPC calls
    ├── ip-rate-limiter.ts  # Per-IP rate limiter for health endpoint
    ├── timeout.ts          # Promise timeout wrapper
    └── modules.ts          # Module address helper
```

## Database Schema

### Core Tables

| Table | Description |
|-------|-------------|
| `wallets` | Deployed multisig wallet instances |
| `wallet_owners` | Wallet owner addresses with active status |
| `wallet_delegatecall_targets` | Per-wallet DelegateCall target whitelist |
| `transactions` | Proposed multisig transactions (with timelock/expiration) |
| `confirmations` | Owner approvals for transactions |
| `wallet_modules` | Enabled modules per wallet |
| `deposits` | QUAI received by wallets |
| `module_executions` | Zodiac IAvatar module execution results |
| `signed_messages` | EIP-1271 signed message hashes |
| `tokens` | Auto-discovered ERC20/ERC721/ERC1155 token metadata |
| `token_transfers` | Token transfer history for tracked wallets (including ERC1155 batch fan-out) |
| `indexer_state` | Sync progress tracking |

### Social Recovery Tables

| Table | Description |
|-------|-------------|
| `social_recovery_configs` | Guardian configurations |
| `social_recovery_guardians` | Guardian addresses |
| `social_recoveries` | Recovery requests |
| `social_recovery_approvals` | Guardian approvals |

## Indexed Events (31 + Token Transfer wildcards)

| Contract | Events |
|----------|--------|
| QuaiVaultFactory | `WalletCreated`, `WalletRegistered` |
| QuaiVault | `TransactionProposed`, `TransactionApproved`, `ApprovalRevoked`, `TransactionExecuted`, `TransactionCancelled`, `ThresholdReached`, `TransactionFailed`, `TransactionExpired`, `OwnerAdded`, `OwnerRemoved`, `ThresholdChanged`, `MinExecutionDelayChanged`, `DelegatecallTargetAdded`, `DelegatecallTargetRemoved`, `EnabledModule`, `DisabledModule`, `Received`, `ExecutionFromModuleSuccess`, `ExecutionFromModuleFailure`, `MessageSigned`, `MessageUnsigned` |
| SocialRecoveryModule | `RecoverySetup`, `RecoveryInitiated`, `RecoveryApproved`, `RecoveryApprovalRevoked`, `RecoveryExecuted`, `RecoveryCancelled`, `RecoveryInvalidated`, `RecoveryExpiredEvent`, `RecoveryConfigCleared` |
| ERC20/ERC721 | `Transfer` (wildcard scan for auto-discovered tokens) |
| ERC1155 | `TransferSingle`, `TransferBatch` (wildcard scan for auto-discovered tokens) |

## Transaction Type Decoding

The indexer decodes calldata for proposed transactions:

| Type | Description |
|------|-------------|
| `transfer` | Native QUAI transfer (no data) |
| `wallet_admin` | addOwner, removeOwner, changeThreshold, enableModule, disableModule, cancelByConsensus, setMinExecutionDelay, addDelegatecallTarget, removeDelegatecallTarget |
| `module_config` | setupRecovery, etc. |
| `recovery_setup` | Social recovery configuration |
| `message_signing` | signMessage, unsignMessage (EIP-1271) |
| `module_execution` | execTransactionFromModule (Zodiac IAvatar) |
| `batched_call` | MultiSend batched transactions |
| `erc20_transfer` | ERC20 token operations (transfer, approve, transferFrom) |
| `erc721_transfer` | ERC721 token operations (safeTransferFrom) |
| `erc1155_transfer` | ERC1155 token operations (safeTransferFrom, safeBatchTransferFrom) |
| `external_call` | Generic contract interaction |

## Environment Variables

### Required

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPABASE_URL` | - | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | - | Supabase service role key |
| `QUAIVAULT_FACTORY_ADDRESS` | - | QuaiVault factory contract address |
| `QUAIVAULT_IMPLEMENTATION_ADDRESS` | - | QuaiVault implementation address |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `QUAI_RPC_URL` | `https://rpc.quai.network` | Quai RPC endpoint (base URL, shard auto-appended) |
| `SUPABASE_SCHEMA` | `public` | Database schema (`dev`, `testnet`, `mainnet`) |
| `SOCIAL_RECOVERY_MODULE_ADDRESS` | - | SocialRecoveryModule contract address |
| `MULTISEND_CALL_ONLY_ADDRESS` | - | MultiSendCallOnly contract address (rejects nested DelegateCall sub-transactions) |
| `SEED_TOKEN_ADDRESSES` | - | Comma-separated ERC20/ERC721 addresses to track from startup |
| `CORS_ALLOWED_ORIGINS` | - | Comma-separated allowed origins for health endpoint |
| `HEALTH_CHECK_HOST` | `0.0.0.0` | Bind address for health server |
| `TRUSTED_PROXIES` | - | Comma-separated proxy IPs trusted for X-Forwarded-For |
| `BATCH_SIZE` | `1000` | Blocks per batch during backfill |
| `POLL_INTERVAL` | `5000` | Milliseconds between polls |
| `START_BLOCK` | `0` | Block to start indexing from |
| `CONFIRMATIONS` | `2` | Blocks to wait before processing |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `LOG_TO_FILE` | `false` | Enable file logging with rotation |
| `NODE_ENV` | `development` | `development` = pretty console, `production` = JSON |
| `HEALTH_CHECK_ENABLED` | `true` | Enable health check HTTP server |
| `HEALTH_CHECK_PORT` | `8080` | Health check server port |
| `HEALTH_MAX_BLOCKS_BEHIND` | `100` | Max blocks behind before unhealthy |

### Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_CALL_TIMEOUT_MS` | `30000` | Timeout for individual RPC calls |
| `CB_FAILURE_THRESHOLD` | `10` | Consecutive failures before circuit breaker opens |
| `CB_COOLDOWN_MS` | `60000` | Cooldown before retrying after circuit opens |
| `GET_LOGS_CHUNK_SIZE` | `100` | Max addresses per getLogs call |
| `RETRY_MAX_RETRIES` | `5` | Max consecutive failures before reset |
| `RETRY_BASE_DELAY_MS` | `1000` | Initial retry delay |
| `RETRY_MAX_DELAY_MS` | `60000` | Max retry delay cap |
| `RETRY_ERROR_THRESHOLD` | `3` | Failures before error log level |
| `NOT_TOKEN_CACHE_SIZE` | `100000` | Max entries in not-a-token LRU cache |
| `TIMESTAMP_CACHE_SIZE` | `1000` | Max cached block timestamps |
| `WALLET_WARNING_THRESHOLD` | `500000` | Log warning when tracked wallets exceed this |
| `RATE_LIMIT_REQUESTS` | `50` | RPC rate limit requests per window |
| `RATE_LIMIT_WINDOW_MS` | `1000` | RPC rate limit time window |
| `HEALTH_RATE_LIMIT_WINDOW_MS` | `60000` | Health endpoint rate limit window |
| `HEALTH_RATE_LIMIT_MAX` | `60` | Max health requests per window |
| `HEALTH_RATE_LIMIT_MAX_IPS` | `10000` | Max tracked IPs for health rate limiting |
| `HEALTH_RATE_LIMIT_CLEANUP_MS` | `300000` | Stale IP cleanup interval |

## Logging

- Console: Pretty-printed in development, JSON in production
- File logging: Enable with `LOG_TO_FILE=true`
  - Daily rotation + 10MB size limit
  - Separate error log file
  - Logs written to `logs/` directory

## Health Check

The indexer exposes HTTP endpoints for health monitoring:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Full health status with details |
| `GET /ready` | Kubernetes readiness probe |
| `GET /live` | Kubernetes liveness probe |

### Health Response

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "checks": {
    "quaiRpc": { "status": "pass" },
    "supabase": { "status": "pass" },
    "indexer": { "status": "pass" }
  },
  "details": {
    "currentBlock": 5500000,
    "lastIndexedBlock": 5499998,
    "blocksBehind": 0,
    "isSyncing": false,
    "skippedEvents": 0
  }
}
```

The `/health` endpoint returns:
- `200 OK` when all checks pass
- `503 Service Unavailable` when any check fails

## Monitoring

Check indexer state:

```sql
SELECT * FROM indexer_state;
```

View recent activity:

```sql
SELECT 'wallet' as type, address as id, created_at FROM wallets
UNION ALL
SELECT 'transaction', tx_hash, created_at FROM transactions
ORDER BY created_at DESC LIMIT 20;
```

## Related Documentation

- [TESTING.md](TESTING.md) - Unit and E2E testing guide
- [DEPLOYMENT.md](DEPLOYMENT.md) - VPS deployment (Docker / systemd)
- [INDEXER_FRONTEND_INTEGRATION.md](INDEXER_FRONTEND_INTEGRATION.md) - Frontend integration guide

## License

MIT
