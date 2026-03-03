# Testing the QuaiVault Indexer

## Table of Contents

- [Unit Tests](#unit-tests)
- [E2E Test Suite](#e2e-test-suite)
  - [Overview](#overview)
  - [Prerequisites](#prerequisites)
  - [Configuration](#configuration)
  - [Running Tests](#running-tests)
  - [Test Coverage](#test-coverage)
  - [Architecture](#architecture)
  - [Troubleshooting](#troubleshooting)
- [Manual Testing](#manual-testing)

---

## Unit Tests

Unit tests use [Vitest](https://vitest.dev/) and run without any external dependencies (mocked RPC and DB).

```bash
# Run all unit tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage
```

**Test files** are located in `tests/` (unit) and `src/**/*.test.ts`:

| File | Coverage |
|------|----------|
| `tests/decode.test.ts` | Event & calldata decoding |
| `tests/validation.test.ts` | Address, bytes32, block number validation |
| `tests/config.test.ts` | Configuration parsing and bounds |
| `tests/retry.test.ts` | Exponential backoff utility |
| `tests/rate-limiter.test.ts` | Token bucket rate limiter |
| `tests/circuit-breaker.test.ts` | Circuit breaker state machine |
| `tests/events/vault-core.test.ts` | Core vault event handlers |
| `tests/events/factory.test.ts` | Factory event handlers |
| `tests/events/social-recovery.test.ts` | Social recovery event handlers |
| `tests/events/token-transfer.test.ts` | ERC20/ERC721/ERC1155 transfer handling |

---

## E2E Test Suite

### Overview

The E2E test suite runs real blockchain transactions against the Quai Network testnet to verify the indexer correctly captures and stores all contract events. Tests create actual wallets, propose transactions, enable modules, and verify the data appears correctly in Supabase.

**Key characteristics:**
- Tests run on **real blockchain** (Orchard testnet) — not mocked
- Transactions cost **real testnet QUAI** for gas
- Tests are **ordered** and **sequential** within a single consolidated test file
- Wallets are created fresh each run (primary + timelocked)
- Test results are logged to `tests/e2e/logs/` with timestamped filenames

### Prerequisites

Before running E2E tests, you need:

1. **Indexer running** with the dev schema:
   ```bash
   SUPABASE_SCHEMA=dev npm run dev
   ```

2. **Dev schema created** in Supabase:
   ```sql
   SELECT create_quaivault_schema('dev');
   ```

3. **Contracts deployed** to Orchard testnet:
   - QuaiVaultFactory
   - QuaiVault implementation
   - SocialRecoveryModule
   - MockModule (for Zodiac execution tests)

4. **Test wallets funded** with testnet QUAI:
   - 3 owner wallets (for multisig threshold testing)
   - 2 guardian wallets (for social recovery testing)
   - Each needs enough QUAI for multiple transactions (~0.1 QUAI recommended)

### Configuration

1. Copy the example config:
   ```bash
   cp .env.e2e.example .env.e2e
   ```

2. Fill in your values:

   ```bash
   # Quai Network (Orchard Testnet)
   QUAI_RPC_URL=https://rpc.orchard.quai.network
   QUAI_CHAIN_ID=9000

   # Test wallet private keys (NEVER use keys with real funds!)
   OWNER_PRIVATE_KEY_1=0x...
   OWNER_PRIVATE_KEY_2=0x...
   OWNER_PRIVATE_KEY_3=0x...
   GUARDIAN_PRIVATE_KEY_1=0x...
   GUARDIAN_PRIVATE_KEY_2=0x...

   # Deployed contract addresses
   QUAIVAULT_FACTORY=0x...
   QUAIVAULT_IMPLEMENTATION=0x...
   SOCIAL_RECOVERY_MODULE=0x...
   MOCK_MODULE=0x...

   # Supabase (same instance as indexer, use 'dev' schema)
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_KEY=your-service-key
   SUPABASE_SCHEMA=dev

   # Indexer health endpoint
   HEALTH_CHECK_PORT=8080

   # Timing (adjust for network conditions)
   INDEXER_POLL_INTERVAL=15000
   TX_CONFIRMATION_TIMEOUT=60000
   ```

### Running Tests

**Run all tests (recommended):**
```bash
npm run test:e2e
```
Output is displayed in the terminal and saved to a timestamped log file in `tests/e2e/logs/`.

**Run with JSON report (for CI):**
```bash
npm run test:e2e:report
```
Writes machine-readable results to `tests/e2e/logs/results.json`.

### Test Coverage

The consolidated test file (`01-full-lifecycle.e2e.test.ts`) covers 21 tests across 13 describe blocks:

| Section | Events Tested |
|---------|---------------|
| Factory & Wallet Creation | `WalletCreated` (primary + timelocked) |
| QUAI Reception | `Received` |
| Simple Quorum (no timelock) | `TransactionProposed`, `TransactionApproved`, `ThresholdReached`, `TransactionExecuted`, `ApprovalRevoked`, `TransactionCancelled`, `cancelByConsensus` |
| Timelocked Transactions | `ThresholdReached` (with `executableAfter`), timelock enforcement, self-call bypass |
| Expiration | `TransactionExpired` |
| Failed External Call | `TransactionFailed` (Option B model) |
| Owner Management | `OwnerAdded`, `OwnerRemoved`, `ThresholdChanged` |
| Module Management & Execution | `ModuleEnabled`, `ExecutionFromModuleSuccess`, `ExecutionFromModuleFailure`, `ModuleDisabled` |
| EIP-1271 Message Signing | `MessageSigned`, `MessageUnsigned` |
| Execution Delay | `MinExecutionDelayChanged` |
| Social Recovery | `RecoverySetup`, `RecoveryInitiated`, `RecoveryApproved`, `RecoveryApprovalRevoked`, `RecoveryCancelled` |
| ERC721 Transfers | Mint inflow, transfer outflow (skip if `MOCK_ERC721` not deployed) |
| ERC1155 Transfers | Mint inflow, `safeTransferFrom` outflow, batch mint fan-out (skip if `MOCK_ERC1155` not deployed) |

**Note:** `RecoveryExecuted` is tested but blocked by the 24-hour minimum recovery period. The test verifies the flow up to execution.

### Architecture

```
tests/e2e/
├── config.ts                    # Loads .env.e2e configuration
├── setup.ts                     # Global beforeAll/afterAll hooks
├── vitest.e2e.config.ts         # Vitest E2E configuration
├── logs/                        # Timestamped test output logs
├── helpers/
│   ├── blockchain.ts            # Blockchain utilities (salt mining, tx helpers)
│   ├── contracts.ts             # Contract interaction helpers (quais SDK)
│   ├── db.ts                    # Database verification helpers (Supabase queries + assertions)
│   └── indexer.ts               # Indexer health/sync polling
└── suites/
    └── 01-full-lifecycle.e2e.test.ts  # All 21 tests in one sequential file
```

**Key components:**

- **ContractHelper** (`helpers/contracts.ts`): Wraps all contract interactions with proper gas limits, salt mining for CREATE2, and retry logic for network issues.
- **DatabaseVerifier** (`helpers/db.ts`): Provides assertion helpers to verify expected data exists in Supabase tables.
- **IndexerHelper** (`helpers/indexer.ts`): Polls the indexer health endpoint and waits for expected data to appear.

### Troubleshooting

#### "Cannot connect to indexer"
```
Indexer health check failed: Cannot connect to indexer at http://localhost:8080
```
Start the indexer with: `SUPABASE_SCHEMA=dev npm run dev`

#### "At least 3 owner private keys are required"
Add all required private keys to `.env.e2e`.

#### Tests timing out
The blockchain can be slow. Adjust timing in `.env.e2e`:
```bash
TX_CONFIRMATION_TIMEOUT=120000  # Increase to 2 minutes
INDEXER_POLL_INTERVAL=10000     # Poll more frequently
```

#### Timelock/expiration tests taking long
The timelocked wallet uses a 300-second delay. The expiration test waits for real time to pass (~5-6 minutes each). This is expected behavior.

---

## Manual Testing

### Prerequisites

1. **Indexer running**: `npm run dev`
2. **Frontend running**: QuaiVault frontend at `http://localhost:5173`
3. **Pelagus wallet**: Connected to Orchard testnet (Cyprus1)
4. **Test QUAI**: Funds for gas fees

### Basic Workflow

1. **Create Wallet**: Connect Pelagus -> Create New Wallet -> Add owners -> Deploy
2. **Fund Wallet**: Send QUAI to the wallet address
3. **Propose Transaction**: New Transaction -> Enter details -> Submit
4. **Approve Transaction**: Switch to another owner -> Approve
5. **Execute Transaction**: After threshold met -> Execute

### Verify in Supabase

```sql
-- Check wallets
SELECT * FROM wallets ORDER BY created_at DESC LIMIT 5;

-- Check pending transactions
SELECT w.address, t.tx_hash, t.status, t.confirmation_count, w.threshold
FROM transactions t
JOIN wallets w ON t.wallet_address = w.address
WHERE t.status = 'pending';

-- Check deposits
SELECT * FROM deposits WHERE wallet_address = 'your-address' ORDER BY created_at DESC;

-- Check module executions (Zodiac)
SELECT * FROM module_executions WHERE wallet_address = 'your-address' ORDER BY created_at DESC;

-- Check token transfers
SELECT * FROM token_transfers WHERE wallet_address = 'your-address' ORDER BY block_number DESC;
```
