# Testing the QuaiVault Indexer

This document describes how to verify the indexer is correctly capturing and storing blockchain events.

## Prerequisites

1. **Indexer running**: Start the indexer with `npm run dev`
2. **Frontend running**: The QuaiVault frontend at `http://localhost:5173`
3. **Pelagus wallet**: Browser extension connected to Orchard testnet (Cyprus1)
4. **Test QUAI**: Funds in your wallet for gas fees

## Testing Workflow

### 1. Wallet Creation (WalletRegistered Event)

1. Open the frontend and connect your Pelagus wallet
2. Click "Create New Wallet"
3. Add 2-3 owner addresses and set threshold to 2
4. Confirm the deployment transaction in Pelagus
5. Confirm the registration transaction in Pelagus

**Verify in Supabase:**
```sql
SELECT * FROM wallets ORDER BY created_at DESC LIMIT 1;
```

Expected: New wallet with correct owners array and threshold.

### 2. Deposit QUAI (Received Event)

1. Send QUAI to your multisig wallet address from any account
2. Wait for the transaction to confirm

**Verify in Supabase:**
```sql
SELECT * FROM deposits
WHERE wallet_address = '<your-wallet-address>'
ORDER BY created_at DESC LIMIT 1;
```

Expected: Deposit record with sender_address and amount.

### 3. Transaction Proposal (TransactionProposed Event)

1. Open your multisig wallet in the frontend
2. Click "New Transaction"
3. Enter a recipient address, amount, and optional data
4. Submit the proposal

**Verify in Supabase:**
```sql
SELECT * FROM transactions
WHERE wallet_address = '<your-wallet-address>'
ORDER BY created_at DESC LIMIT 1;
```

Expected: New transaction with `status = 'pending'` and `confirmation_count = 1`.

### 4. Transaction Approval (TransactionApproved Event)

1. Connect as a different owner (switch account in Pelagus)
2. Navigate to the pending transaction
3. Click "Approve"

**Verify in Supabase:**
```sql
SELECT * FROM confirmations
WHERE tx_hash = '<transaction-hash>';
```

Expected: New confirmation record with `is_active = true`.

### 5. Approval Revocation (ApprovalRevoked Event)

1. As an owner who approved, click "Revoke Approval"

**Verify in Supabase:**
```sql
SELECT * FROM confirmations
WHERE tx_hash = '<transaction-hash>'
  AND owner_address = '<your-address>';
```

Expected: Confirmation record updated with `is_active = false`.

### 6. Transaction Execution (TransactionExecuted Event)

1. Once threshold is met, click "Execute"
2. Confirm the transaction in Pelagus

**Verify in Supabase:**
```sql
SELECT status FROM transactions WHERE tx_hash = '<transaction-hash>';
```

Expected: `status = 'executed'`.

### 7. Transaction Cancellation (TransactionCancelled Event)

1. Create a new transaction proposal
2. As the proposer, click "Cancel"

**Verify in Supabase:**
```sql
SELECT status FROM transactions WHERE tx_hash = '<transaction-hash>';
```

Expected: `status = 'cancelled'`.

### 8. Module Enable/Disable (ModuleEnabled/ModuleDisabled Events)

1. Navigate to wallet settings
2. Enable the DailyLimitModule
3. Approve and execute the enable transaction
4. Later, disable the module via another multisig transaction

**Verify in Supabase:**
```sql
SELECT * FROM wallet_modules
WHERE wallet_address = '<your-wallet-address>';
```

Expected: Module record with `is_active` toggling based on enable/disable.

---

## Module Configuration Events

### 9. Daily Limit Module (DailyLimitSet Event)

1. Enable the DailyLimitModule on your wallet
2. Configure a daily limit (e.g., 1 QUAI)
3. Execute the configuration transaction

**Verify in Supabase:**
```sql
SELECT * FROM daily_limit_state
WHERE wallet_address = '<your-wallet-address>';
```

Expected: Record with `daily_limit` set to the configured amount.

### 10. Whitelist Module (AddressWhitelisted Event)

1. Enable the WhitelistModule on your wallet
2. Add an address to the whitelist with a limit
3. Execute the whitelist transaction

**Verify in Supabase:**
```sql
SELECT * FROM whitelist_entries
WHERE wallet_address = '<your-wallet-address>';
```

Expected: Whitelisted address with the specified limit.

---

## Social Recovery Flow

The Social Recovery Module has its own approval/execution flow separate from regular transactions.

### 11. Recovery Setup (RecoverySetup Event)

1. Enable the SocialRecoveryModule on your wallet
2. Configure guardians, threshold, and recovery period
3. Execute the setup transaction

**Verify in Supabase:**
```sql
SELECT * FROM social_recovery_configs
WHERE wallet_address = '<your-wallet-address>';
```

Expected: Config with guardians array, threshold, and recovery_period.

### 12. Initiate Recovery (RecoveryInitiated Event)

1. As a guardian, initiate a recovery with new owners
2. Specify the new owners and new threshold

**Verify in Supabase:**
```sql
SELECT * FROM social_recoveries
WHERE wallet_address = '<your-wallet-address>'
ORDER BY created_at DESC LIMIT 1;
```

Expected: Recovery record with `status = 'pending'`, new_owners, new_threshold.

### 13. Approve Recovery (RecoveryApproved Event)

1. As another guardian, approve the pending recovery

**Verify in Supabase:**
```sql
SELECT * FROM social_recovery_approvals
WHERE recovery_hash = '<recovery-hash>';
```

Expected: Approval records for each guardian who approved.

### 14. Revoke Recovery Approval (RecoveryApprovalRevoked Event)

1. As a guardian who approved, revoke your approval

**Verify in Supabase:**
```sql
SELECT * FROM social_recovery_approvals
WHERE recovery_hash = '<recovery-hash>'
  AND guardian_address = '<your-address>';
```

Expected: Approval record with `is_active = false`.

### 15. Execute Recovery (RecoveryExecuted Event)

1. After the recovery period has elapsed and threshold is met
2. Execute the recovery

**Verify in Supabase:**
```sql
SELECT status FROM social_recoveries WHERE recovery_hash = '<recovery-hash>';
```

Expected: `status = 'executed'`.

Also verify the wallet owners were updated:
```sql
SELECT owner_address FROM wallet_owners
WHERE wallet_address = '<wallet-address>' AND is_active = true;
```

### 16. Cancel Recovery (RecoveryCancelled Event)

1. As a wallet owner, cancel a pending recovery

**Verify in Supabase:**
```sql
SELECT status FROM social_recoveries WHERE recovery_hash = '<recovery-hash>';
```

Expected: `status = 'cancelled'`.

---

## Monitoring the Indexer

Watch the indexer logs during testing:

```bash
npm run dev
```

You should see log entries like:
```
INFO: Processing block 5322500
INFO: Found 2 events in block 5322500
INFO: Indexed WalletRegistered event
INFO: Indexed TransactionProposed event
```

## Verifying Real-time Updates

The indexer processes blocks in real-time. Events should appear in Supabase within 10-15 seconds of the transaction being confirmed on-chain.

## Troubleshooting

### Events not appearing

1. Check indexer logs for errors
2. Verify the wallet is registered with the ProxyFactory
3. Confirm the transaction was successful on-chain (check block explorer)

### Duplicate key errors

This is normal if reprocessing blocks. The indexer uses upserts to handle this gracefully.

### Connection issues

1. Verify RPC_URL is correct in `.env`
2. Check Supabase connection settings
3. Ensure the indexer has network access

## Database Queries for Verification

### Check all indexed wallets
```sql
SELECT address, threshold, owner_count, created_at
FROM wallets
ORDER BY created_at DESC;
```

### Check pending transactions
```sql
SELECT w.address, t.tx_hash, t.status, t.confirmation_count, w.threshold
FROM transactions t
JOIN wallets w ON t.wallet_address = w.address
WHERE t.status = 'pending';
```

### Check recent activity
```sql
SELECT
  'wallet' as type, address as id, created_at
FROM wallets
UNION ALL
SELECT
  'transaction' as type, tx_hash as id, created_at
FROM transactions
ORDER BY created_at DESC
LIMIT 20;
```

### Check deposits
```sql
SELECT * FROM deposits
WHERE wallet_address = '<your-wallet-address>'
ORDER BY created_at DESC;
```

### Check module transactions (Daily Limit / Whitelist)
```sql
SELECT * FROM module_transactions
WHERE wallet_address = '<your-wallet-address>'
ORDER BY created_at DESC;
```

### Check recovery status
```sql
SELECT r.*,
  (SELECT COUNT(*) FROM social_recovery_approvals ra
   WHERE ra.recovery_hash = r.recovery_hash AND ra.is_active = true) as current_approvals
FROM social_recoveries r
WHERE r.wallet_address = '<your-wallet-address>';
```

---

## Summary of Indexed Events

| Source | Event | Database Table |
|--------|-------|----------------|
| ProxyFactory | WalletCreated | wallets, wallet_owners |
| ProxyFactory | WalletRegistered | wallets, wallet_owners |
| QuaiVault | TransactionProposed | transactions |
| QuaiVault | TransactionApproved | confirmations |
| QuaiVault | ApprovalRevoked | confirmations |
| QuaiVault | TransactionExecuted | transactions |
| QuaiVault | TransactionCancelled | transactions |
| QuaiVault | OwnerAdded | wallet_owners |
| QuaiVault | OwnerRemoved | wallet_owners |
| QuaiVault | ThresholdChanged | wallets |
| QuaiVault | ModuleEnabled | wallet_modules |
| QuaiVault | ModuleDisabled | wallet_modules |
| QuaiVault | Received | deposits |
| QuaiVault | ExecutionFromModuleSuccess | module_executions |
| QuaiVault | ExecutionFromModuleFailure | module_executions |
| DailyLimitModule | DailyLimitSet | daily_limit_state |
| DailyLimitModule | DailyLimitReset | daily_limit_state |
| DailyLimitModule | TransactionExecuted | module_transactions |
| WhitelistModule | AddressWhitelisted | whitelist_entries |
| WhitelistModule | AddressRemovedFromWhitelist | whitelist_entries |
| WhitelistModule | WhitelistTransactionExecuted | module_transactions |
| SocialRecoveryModule | RecoverySetup | social_recovery_configs, social_recovery_guardians |
| SocialRecoveryModule | RecoveryInitiated | social_recoveries |
| SocialRecoveryModule | RecoveryApproved | social_recovery_approvals |
| SocialRecoveryModule | RecoveryApprovalRevoked | social_recovery_approvals |
| SocialRecoveryModule | RecoveryExecuted | social_recoveries |
| SocialRecoveryModule | RecoveryCancelled | social_recoveries |
