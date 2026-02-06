# Testing the QuaiVault Indexer

This document describes how to run the automated E2E test suite and manually verify indexer functionality.

## Table of Contents

- [E2E Test Suite](#e2e-test-suite)
  - [Overview](#overview)
  - [Prerequisites](#prerequisites)
  - [Configuration](#configuration)
  - [Running Tests](#running-tests)
  - [Test Suites](#test-suites)
  - [Architecture](#architecture)
  - [Troubleshooting](#troubleshooting)
- [Manual Testing](#manual-testing)
- [Event Coverage](#event-coverage)

---

## E2E Test Suite

### Overview

The E2E test suite runs real blockchain transactions against the Quai Network testnet to verify the indexer correctly captures and stores all contract events. Tests create actual wallets, propose transactions, enable modules, and verify the data appears correctly in Supabase.

**Key characteristics:**
- Tests run on **real blockchain** (Orchard testnet) - not mocked
- Transactions cost **real testnet QUAI** for gas
- Tests are **ordered** and **sequential** (01 -> 09)
- A shared test wallet is created once and reused across suites
- Test results are logged to `tests/e2e/logs/`

### Prerequisites

Before running E2E tests, you need:

1. **Indexer running** with the dev schema:
   ```bash
   SUPABASE_SCHEMA=dev npm run dev
   ```

2. **Dev schema created** in Supabase:
   ```sql
   SELECT create_network_schema('dev');
   ```

3. **Contracts deployed** to Orchard testnet:
   - QuaiVaultFactory
   - QuaiVault implementation
   - Optional: DailyLimitModule, WhitelistModule, SocialRecoveryModule, MockModule

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
   QUAI_WS_URL=wss://rpc.orchard.quai.network
   QUAI_CHAIN_ID=9000

   # Test wallet private keys (NEVER use keys with real funds!)
   OWNER_PRIVATE_KEY_1=0x...
   OWNER_PRIVATE_KEY_2=0x...
   OWNER_PRIVATE_KEY_3=0x...
   GUARDIAN_PRIVATE_KEY_1=0x...
   GUARDIAN_PRIVATE_KEY_2=0x...

   # Deployed contract addresses
   QUAIVAULT_FACTORY_ADDRESS=0x...
   QUAIVAULT_IMPLEMENTATION_ADDRESS=0x...

   # Optional modules (tests skip if not configured)
   DAILY_LIMIT_MODULE_ADDRESS=0x...
   WHITELIST_MODULE_ADDRESS=0x...
   SOCIAL_RECOVERY_MODULE_ADDRESS=0x...
   MOCK_MODULE=0x...  # For Zodiac execution tests

   # Supabase (same instance as indexer, use 'dev' schema)
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_KEY=your-service-key
   SUPABASE_SCHEMA=dev

   # Indexer health endpoint
   HEALTH_CHECK_PORT=8080

   # Timing (adjust for network conditions)
   INDEXER_POLL_INTERVAL=15000   # Poll every 15s
   TX_CONFIRMATION_TIMEOUT=60000  # Wait up to 60s for indexing
   ```

### Running Tests

**Run all tests:**
```bash
npm run test:e2e
```

**Run tests with live output (recommended for debugging):**
```bash
npm run test:e2e 2>&1 | tee tests/e2e/logs/run.log
```

**Run tests in background:**
```bash
npm run test:e2e:bg
# Check progress:
tail -f tests/e2e/logs/run.log
```

**Run tests with UI:**
```bash
npm run test:e2e:ui
```

**Run tests in watch mode:**
```bash
npm run test:e2e:watch
```

**Test output:**
- Console: Verbose test progress
- `tests/e2e/logs/run.log`: Full output
- `tests/e2e/logs/results.json`: JSON results for CI/analysis

### Test Suites

Tests run in order from 01 to 09. Each suite depends on previous suites completing successfully.

#### 01-factory.e2e.test.ts - Wallet Creation
Creates the shared test wallet used by all subsequent tests.

**Events tested:**
- `WalletCreated` - Factory deployment event

**What it does:**
1. Mines a salt for CREATE2 deployment (required for shard-specific address prefix)
2. Deploys a new QuaiVault via the factory
3. Verifies wallet appears in `wallets` table
4. Verifies all 3 owners appear in `wallet_owners` table

#### 02-deposits.e2e.test.ts - Deposit Tracking
Tests QUAI deposits to the multisig wallet.

**Events tested:**
- `Received` - Native QUAI deposit event

**What it does:**
1. Sends QUAI from owner[0] to the wallet
2. Verifies deposit appears in `deposits` table
3. Sends QUAI from owner[1] to test multiple deposits

#### 03-transactions.e2e.test.ts - Transaction Lifecycle
Tests the full transaction proposal/approval/execution flow.

**Events tested:**
- `TransactionProposed` - New transaction submitted
- `TransactionApproved` - Owner approval
- `ApprovalRevoked` - Owner revokes their approval
- `TransactionExecuted` - Transaction executed after threshold met
- `TransactionCancelled` - Proposer cancels transaction

**What it does:**
1. Proposes a transaction (sends small amount to owner[2])
2. First owner approves (confirmation_count = 1)
3. Second owner approves (confirmation_count = 2, threshold met)
4. Second owner revokes approval (confirmation_count = 1)
5. Second owner re-approves
6. Executes the transaction (status = 'executed')
7. Creates new transaction and cancels it (status = 'cancelled')

#### 04-owners.e2e.test.ts - Owner Management
Tests adding/removing owners and changing threshold.

**Events tested:**
- `OwnerAdded` - New owner added to wallet
- `OwnerRemoved` - Owner removed from wallet
- `ThresholdChanged` - Signature threshold changed

**What it does:**
1. Adds guardian[0] as a new owner (requires multisig approval)
2. Removes guardian[0] from owners
3. Changes threshold from 2 to 1 (or vice versa)

#### 05-modules.e2e.test.ts - Module Enable/Disable
Tests enabling and disabling modules on the wallet.

**Events tested:**
- `ModuleEnabled` - Module enabled on wallet
- `ModuleDisabled` - Module disabled on wallet

**What it does:**
1. Enables a module (DailyLimit, Whitelist, or sentinel address)
2. Disables the module (requires knowing previous module in linked list)

#### 06-daily-limit.e2e.test.ts - Daily Limit Module
Tests the DailyLimitModule functionality.

**Skipped if:** `DAILY_LIMIT_MODULE_ADDRESS` not configured

**Events tested:**
- `DailyLimitSet` - Daily limit configured
- `DailyLimitTransactionExecuted` - Transfer within limit executed
- `DailyLimitReset` - Daily limit counter reset (time-based)

**What it does:**
1. Enables DailyLimitModule if not already enabled
2. Sets a daily limit (e.g., 0.005 QUAI)
3. Executes a transfer within the limit
4. Verifies `spent_today` tracking

#### 07-whitelist.e2e.test.ts - Whitelist Module
Tests the WhitelistModule functionality.

**Skipped if:** `WHITELIST_MODULE_ADDRESS` not configured

**Events tested:**
- `AddressWhitelisted` - Address added to whitelist
- `WhitelistTransactionExecuted` - Transfer to whitelisted address
- `AddressRemovedFromWhitelist` - Address removed from whitelist

**What it does:**
1. Enables WhitelistModule if not already enabled
2. Whitelists guardian[0] with a spending limit
3. Executes a transfer to the whitelisted address
4. Removes address from whitelist

#### 08-zodiac.e2e.test.ts - Zodiac IAvatar Events
Tests module execution tracking via Zodiac interface.

**Events tested:**
- `ExecutionFromModuleSuccess` - Module successfully executed an operation
- `ExecutionFromModuleFailure` - Module execution failed

**What it does:**
1. Uses MockModule (if configured) for direct execution testing
2. Falls back to DailyLimit/Whitelist module operations
3. Verifies executions appear in `module_executions` table

#### 09-social-recovery.e2e.test.ts - Social Recovery Module
Tests the full social recovery flow.

**Skipped if:** `SOCIAL_RECOVERY_MODULE_ADDRESS` not configured

**Note:** This suite deploys its **own wallet** to avoid breaking other tests (recovery changes owners).

**Events tested:**
- `RecoverySetup` - Guardians and threshold configured
- `RecoveryInitiated` - Guardian starts recovery process
- `RecoveryApproved` - Guardian approves recovery
- `RecoveryApprovalRevoked` - Guardian revokes approval
- `RecoveryCancelled` - Owner cancels recovery
- `RecoveryExecuted` - Recovery completed (blocked by 24h period in tests)

**What it does:**
1. Deploys a fresh wallet for recovery testing
2. Enables SocialRecoveryModule
3. Sets up 2 guardians with threshold of 2
4. Initiates recovery to change owners
5. Both guardians approve
6. Tests revocation flow
7. Cancels recovery as owner
8. Verifies execution is blocked by recovery period (24h minimum)

### Architecture

```
tests/e2e/
├── config.ts           # Loads .env.e2e configuration
├── setup.ts            # Global beforeAll/afterAll hooks
├── sequencer.ts        # Ensures tests run in numeric order
├── shared-state.ts     # Wallet address shared between suites
├── vitest.e2e.config.ts # Vitest configuration
├── logs/               # Test output logs
├── helpers/
│   ├── blockchain.ts   # Blockchain utilities
│   ├── contracts.ts    # Contract interaction helpers
│   ├── db.ts          # Database verification helpers
│   ├── indexer.ts     # Indexer health/sync helpers
│   └── logger.ts      # Test logging
└── suites/
    ├── 01-factory.e2e.test.ts
    ├── 02-deposits.e2e.test.ts
    ├── ...
    └── 09-social-recovery.e2e.test.ts
```

**Key components:**

- **ContractHelper** (`helpers/contracts.ts`): Wraps all contract interactions with proper gas limits, salt mining for CREATE2, and retry logic for network issues.

- **DatabaseVerifier** (`helpers/db.ts`): Provides assertion helpers to verify expected data exists in Supabase tables.

- **IndexerHelper** (`helpers/indexer.ts`): Polls the indexer health endpoint and waits for expected data to appear.

- **SharedState** (`shared-state.ts`): Maintains the test wallet address and module state across test files using `globalThis`.

### Troubleshooting

#### "Cannot connect to indexer"
```
❌ Indexer health check failed:
Cannot connect to indexer at http://localhost:8080
```

**Solution:** Start the indexer with:
```bash
SUPABASE_SCHEMA=dev npm run dev
```

#### "At least 3 owner private keys are required"
```
E2E Configuration Errors:
  - At least 3 owner private keys are required
```

**Solution:** Add all required private keys to `.env.e2e`.

#### Tests timing out
The blockchain can be slow. Adjust timing in `.env.e2e`:
```bash
TX_CONFIRMATION_TIMEOUT=120000  # Increase to 2 minutes
INDEXER_POLL_INTERVAL=10000     # Poll more frequently
```

#### "Test wallet not created yet"
```
Error: Test wallet not created yet. Make sure factory tests run first
```

**Solution:** Tests must run in order. Don't run individual suites without running 01-factory first.

#### Module tests skipped
```
⚠️ DailyLimitModule not configured - tests will be skipped
```

**Solution:** Add the module address to `.env.e2e`, or accept that module tests will be skipped.

#### Transaction failures / "Access list creation failed"
Network congestion can cause transient failures. The test suite has retry logic, but you may need to re-run tests.

---

## Manual Testing

For manual testing with the frontend, see the workflow below.

### Prerequisites

1. **Indexer running**: `npm run dev`
2. **Frontend running**: QuaiVault frontend at `http://localhost:5173`
3. **Pelagus wallet**: Connected to Orchard testnet (Cyprus1)
4. **Test QUAI**: Funds for gas fees

### Basic Workflow

1. **Create Wallet**: Connect Pelagus → Create New Wallet → Add owners → Deploy
2. **Fund Wallet**: Send QUAI to the wallet address
3. **Propose Transaction**: New Transaction → Enter details → Submit
4. **Approve Transaction**: Switch to another owner → Approve
5. **Execute Transaction**: After threshold met → Execute

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
```

---

## Event Coverage

The indexer tracks 27 distinct events across 5 contract sources:

| Source | Event | Database Table | E2E Test |
|--------|-------|----------------|----------|
| QuaiVaultFactory | WalletCreated | wallets, wallet_owners | 01-factory |
| QuaiVault | TransactionProposed | transactions | 03-transactions |
| QuaiVault | TransactionApproved | confirmations | 03-transactions |
| QuaiVault | ApprovalRevoked | confirmations | 03-transactions |
| QuaiVault | TransactionExecuted | transactions | 03-transactions |
| QuaiVault | TransactionCancelled | transactions | 03-transactions |
| QuaiVault | OwnerAdded | wallet_owners | 04-owners |
| QuaiVault | OwnerRemoved | wallet_owners | 04-owners |
| QuaiVault | ThresholdChanged | wallets | 04-owners |
| QuaiVault | ModuleEnabled | wallet_modules | 05-modules |
| QuaiVault | ModuleDisabled | wallet_modules | 05-modules |
| QuaiVault | Received | deposits | 02-deposits |
| QuaiVault | ExecutionFromModuleSuccess | module_executions | 08-zodiac |
| QuaiVault | ExecutionFromModuleFailure | module_executions | 08-zodiac |
| DailyLimitModule | DailyLimitSet | daily_limit_state | 06-daily-limit |
| DailyLimitModule | DailyLimitReset | daily_limit_state | 06-daily-limit |
| DailyLimitModule | TransactionExecuted | module_transactions | 06-daily-limit |
| WhitelistModule | AddressWhitelisted | whitelist_entries | 07-whitelist |
| WhitelistModule | AddressRemovedFromWhitelist | whitelist_entries | 07-whitelist |
| WhitelistModule | WhitelistTransactionExecuted | module_transactions | 07-whitelist |
| SocialRecoveryModule | RecoverySetup | social_recovery_configs, social_recovery_guardians | 09-social-recovery |
| SocialRecoveryModule | RecoveryInitiated | social_recoveries | 09-social-recovery |
| SocialRecoveryModule | RecoveryApproved | social_recovery_approvals | 09-social-recovery |
| SocialRecoveryModule | RecoveryApprovalRevoked | social_recovery_approvals | 09-social-recovery |
| SocialRecoveryModule | RecoveryExecuted | social_recoveries | 09-social-recovery* |
| SocialRecoveryModule | RecoveryCancelled | social_recoveries | 09-social-recovery |

\* RecoveryExecuted is tested but blocked by the 24-hour recovery period requirement.
