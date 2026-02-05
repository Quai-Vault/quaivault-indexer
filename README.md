# QuaiVault Indexer

A blockchain indexing service for QuaiVault multisig wallets on Quai Network. Indexes on-chain events to Supabase for fast queries and real-time updates.

## Features

- Indexes 27 event types from QuaiVault, ProxyFactory, and module contracts (including Zodiac IAvatar events)
- Real-time updates via Supabase Realtime subscriptions
- Historical backfill with resume capability
- Transaction type decoding (transfer, wallet_admin, module_config, etc.)
- Social recovery, daily limit, and whitelist module support
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
PROXY_FACTORY_ADDRESS=0x...
QUAIVAULT_IMPLEMENTATION_ADDRESS=0x...

# Optional - Module and utility contracts (if deployed)
DAILY_LIMIT_MODULE_ADDRESS=0x...
WHITELIST_MODULE_ADDRESS=0x...
SOCIAL_RECOVERY_MODULE_ADDRESS=0x...
MULTISEND_ADDRESS=0x...

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
HEALTH_CHECK_PORT=3000
HEALTH_MAX_BLOCKS_BEHIND=100
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
├── index.ts              # Entry point with graceful shutdown
├── config.ts             # Environment configuration with validation
├── indexer.ts            # Core indexer with polling loop
├── backfill.ts           # Standalone historical backfill script
├── events/
│   └── index.ts          # Event handlers (27 events)
├── services/
│   ├── quai.ts           # Quai RPC client with retry
│   ├── supabase.ts       # Database operations
│   ├── decoder.ts        # Event & calldata decoding
│   └── health.ts         # Health check HTTP server
├── types/
│   └── index.ts          # TypeScript interfaces
└── utils/
    ├── logger.ts         # Pino logger with rotation
    ├── retry.ts          # Exponential backoff utility
    └── modules.ts        # Module address helper
```

## Database Schema

### Core Tables

| Table | Description |
|-------|-------------|
| `wallets` | Deployed multisig wallet instances |
| `wallet_owners` | Wallet owner addresses with active status |
| `transactions` | Proposed multisig transactions |
| `confirmations` | Owner approvals for transactions |
| `wallet_modules` | Enabled modules per wallet |
| `deposits` | QUAI received by wallets |
| `indexer_state` | Sync progress tracking |

### Module Tables

| Table | Description |
|-------|-------------|
| `daily_limit_state` | Daily spending limits |
| `whitelist_entries` | Whitelisted addresses |
| `module_transactions` | Module-executed transfers |
| `module_executions` | Zodiac IAvatar module execution results |
| `social_recovery_configs` | Guardian configurations |
| `social_recovery_guardians` | Guardian addresses |
| `social_recoveries` | Recovery requests |
| `social_recovery_approvals` | Guardian approvals |

## Indexed Events

| Contract | Events |
|----------|--------|
| ProxyFactory | `WalletCreated`, `WalletRegistered` |
| QuaiVault | `TransactionProposed`, `TransactionApproved`, `ApprovalRevoked`, `TransactionExecuted`, `TransactionCancelled`, `OwnerAdded`, `OwnerRemoved`, `ThresholdChanged`, `ModuleEnabled`, `ModuleDisabled`, `Received`, `ExecutionFromModuleSuccess`, `ExecutionFromModuleFailure` |
| SocialRecoveryModule | `RecoverySetup`, `RecoveryInitiated`, `RecoveryApproved`, `RecoveryApprovalRevoked`, `RecoveryExecuted`, `RecoveryCancelled` |
| DailyLimitModule | `DailyLimitSet`, `DailyLimitReset`, `TransactionExecuted` |
| WhitelistModule | `AddressWhitelisted`, `AddressRemovedFromWhitelist`, `WhitelistTransactionExecuted` |

## Transaction Type Decoding

The indexer decodes calldata for proposed transactions:

| Type | Description |
|------|-------------|
| `transfer` | Native QUAI transfer (no data) |
| `wallet_admin` | addOwner, removeOwner, changeThreshold, enableModule, disableModule |
| `module_config` | setDailyLimit, addToWhitelist, setupRecovery, etc. |
| `recovery_setup` | Social recovery configuration |
| `module_execution` | execTransactionFromModule (Zodiac IAvatar) |
| `batched_call` | MultiSend batched transactions |
| `external_call` | Generic contract interaction |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | - | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | - | Supabase service role key |
| `PROXY_FACTORY_ADDRESS` | Yes | - | ProxyFactory contract address |
| `QUAIVAULT_IMPLEMENTATION_ADDRESS` | Yes | - | QuaiVault implementation address |
| `QUAI_RPC_URL` | No | `https://rpc.quai.network` | Quai RPC endpoint (base URL, shard auto-appended) |
| `BATCH_SIZE` | No | `1000` | Blocks per batch during backfill |
| `POLL_INTERVAL` | No | `5000` | Milliseconds between polls |
| `START_BLOCK` | No | `0` | Block to start indexing from |
| `CONFIRMATIONS` | No | `2` | Blocks to wait before processing |
| `LOG_LEVEL` | No | `info` | Logging level |
| `LOG_TO_FILE` | No | `false` | Enable file logging with rotation |
| `HEALTH_CHECK_ENABLED` | No | `true` | Enable health check HTTP server |
| `HEALTH_CHECK_PORT` | No | `3000` | Health check server port |
| `HEALTH_MAX_BLOCKS_BEHIND` | No | `100` | Max blocks behind before unhealthy |

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
    "trackedWallets": 42
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

- [TESTING.md](TESTING.md) - Manual testing procedures
- [INDEXER_FRONTEND_INTEGRATION.md](INDEXER_FRONTEND_INTEGRATION.md) - Frontend integration guide

## License

MIT
