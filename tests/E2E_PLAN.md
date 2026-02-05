# End-to-End Testing Implementation Plan

## Overview

This document details the comprehensive E2E testing system for the QuaiVault Indexer. The system uses real private keys with testnet funds to interact with smart contracts on-chain, generating actual blockchain events to verify the indexer captures all 27 event types correctly.

**Strategy:** Run real transactions on Quai Orchard testnet → Wait for indexer to process → Verify database records match expected values.

---

## Event Coverage Matrix (27 Events)

| # | Contract | Event | Test Suite |
|---|----------|-------|------------|
| 1 | ProxyFactory | WalletCreated | `factory.e2e.test.ts` |
| 2 | ProxyFactory | WalletRegistered | `factory.e2e.test.ts` |
| 3 | QuaiVault | TransactionProposed | `transactions.e2e.test.ts` |
| 4 | QuaiVault | TransactionApproved | `transactions.e2e.test.ts` |
| 5 | QuaiVault | ApprovalRevoked | `transactions.e2e.test.ts` |
| 6 | QuaiVault | TransactionExecuted | `transactions.e2e.test.ts` |
| 7 | QuaiVault | TransactionCancelled | `transactions.e2e.test.ts` |
| 8 | QuaiVault | OwnerAdded | `owners.e2e.test.ts` |
| 9 | QuaiVault | OwnerRemoved | `owners.e2e.test.ts` |
| 10 | QuaiVault | ThresholdChanged | `owners.e2e.test.ts` |
| 11 | QuaiVault | ModuleEnabled | `modules.e2e.test.ts` |
| 12 | QuaiVault | ModuleDisabled | `modules.e2e.test.ts` |
| 13 | QuaiVault | Received | `deposits.e2e.test.ts` |
| 14 | QuaiVault | ExecutionFromModuleSuccess | `zodiac.e2e.test.ts` |
| 15 | QuaiVault | ExecutionFromModuleFailure | `zodiac.e2e.test.ts` |
| 16 | DailyLimitModule | DailyLimitSet | `daily-limit.e2e.test.ts` |
| 17 | DailyLimitModule | DailyLimitReset | `daily-limit.e2e.test.ts` |
| 18 | DailyLimitModule | DailyLimitTransactionExecuted | `daily-limit.e2e.test.ts` |
| 19 | WhitelistModule | AddressWhitelisted | `whitelist.e2e.test.ts` |
| 20 | WhitelistModule | AddressRemovedFromWhitelist | `whitelist.e2e.test.ts` |
| 21 | WhitelistModule | WhitelistTransactionExecuted | `whitelist.e2e.test.ts` |
| 22 | SocialRecoveryModule | RecoverySetup | `social-recovery.e2e.test.ts` |
| 23 | SocialRecoveryModule | RecoveryInitiated | `social-recovery.e2e.test.ts` |
| 24 | SocialRecoveryModule | RecoveryApproved | `social-recovery.e2e.test.ts` |
| 25 | SocialRecoveryModule | RecoveryApprovalRevoked | `social-recovery.e2e.test.ts` |
| 26 | SocialRecoveryModule | RecoveryExecuted | `social-recovery.e2e.test.ts` |
| 27 | SocialRecoveryModule | RecoveryCancelled | `social-recovery.e2e.test.ts` |

---

## Test Architecture

```
tests/e2e/
├── vitest.e2e.config.ts          # Vitest config for E2E (longer timeouts)
├── setup.ts                       # Global setup/teardown
├── config.ts                      # E2E test configuration
├── helpers/
│   ├── contracts.ts               # Contract interaction helpers
│   ├── db.ts                      # Database query/verification helpers
│   ├── blockchain.ts              # Transaction utilities
│   └── indexer.ts                 # Indexer sync utilities
└── suites/
    ├── factory.e2e.test.ts        # Events 1-2
    ├── transactions.e2e.test.ts   # Events 3-7
    ├── owners.e2e.test.ts         # Events 8-10
    ├── modules.e2e.test.ts        # Events 11-12
    ├── deposits.e2e.test.ts       # Event 13
    ├── zodiac.e2e.test.ts         # Events 14-15
    ├── daily-limit.e2e.test.ts    # Events 16-18
    ├── whitelist.e2e.test.ts      # Events 19-21
    └── social-recovery.e2e.test.ts # Events 22-27
```

---

## quais SDK Patterns

The quais SDK differs from ethers.js:

- **HTTP RPC**: Use `FetchRequest` for JSON-RPC calls (no JsonRpcProvider)
- **WebSocket**: Use `quais.WebSocketProvider` for subscriptions
- **Contract Interaction**: Use `quais.Contract` with ABI and signer
- **Transaction Signing**: Manual signing with private keys via quais utilities

---

## Prerequisites Before Running E2E Tests

1. **Indexer running**: Start with `SUPABASE_SCHEMA=dev npm run dev`
2. **Dev schema created**: Run `SELECT create_network_schema('dev');` in Supabase
3. **Contracts deployed**: Deploy all contracts to Orchard testnet
4. **Test wallets funded**: Each private key needs testnet QUAI for gas
5. **Environment configured**: Copy `.env.e2e.example` to `.env.e2e` and fill values

---

## Running Tests

```bash
# Run all E2E tests
npm run test:e2e

# Run in watch mode
npm run test:e2e:watch

# Run with UI
npm run test:e2e:ui

# Run with coverage
npm run test:e2e:coverage
```

---

## Verification Checklist

After implementation, verify:

- [ ] All 27 events have test coverage
- [ ] Tests pass against real testnet transactions
- [ ] Database records match expected values
- [ ] Timing/polling works reliably
- [ ] Tests are isolated and repeatable
- [ ] Coverage report shows all event handlers tested
