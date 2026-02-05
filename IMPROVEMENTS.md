# Improvements Log

This document tracks improvements identified and implemented during the audit (January 2026).

## Implemented Improvements

All items from the initial audit have been implemented.

### 1. Block Timestamp for Recovery Execution Time ✅

**Location:** [src/events/index.ts](src/events/index.ts) - `handleRecoveryInitiated`

**Change:** Added `getBlockTimestamp` method to QuaiService and updated `handleRecoveryInitiated` to fetch the actual block timestamp from the RPC for accurate execution time calculation. Falls back to `Date.now()` if the RPC call fails.

**Files Modified:**
- `src/services/quai.ts` - Added `getBlockTimestamp()` method
- `src/events/index.ts` - Updated `handleRecoveryInitiated()` to use block timestamp

---

### 2. Defensive Check for `decodeAddressArray` ✅

**Location:** [src/events/index.ts](src/events/index.ts) - `decodeAddressArray`

**Change:** Added comprehensive validation:
- Checks for null/undefined input
- Validates `0x` prefix
- Validates minimum data length (130 chars)
- Sanity check on array length (0-1000)
- Validates sufficient data for all addresses

**Files Modified:**
- `src/events/index.ts` - Updated `decodeAddressArray()` with validation

---

### 3. BigInt Underflow Guard in Daily Limit Calculation ✅

**Location:** [src/services/supabase.ts](src/services/supabase.ts) - `updateDailyLimitSpent`

**Change:** Added guard to prevent negative spent values when `remaining > dailyLimit` (can occur if limit was increased mid-day):
```typescript
const spent = remaining > dailyLimit ? '0' : (dailyLimit - remaining).toString();
```

**Files Modified:**
- `src/services/supabase.ts` - Updated `updateDailyLimitSpent()`

---

### 4. Chunked `getLogs` Calls for Scalability ✅

**Location:** [src/indexer.ts](src/indexer.ts) and [src/backfill.ts](src/backfill.ts)

**Change:** Added `GET_LOGS_ADDRESS_CHUNK_SIZE = 100` constant and chunking logic to split wallet addresses into batches when calling `getLogs`. This prevents RPC provider limits from being exceeded when tracking many wallets.

**Files Modified:**
- `src/indexer.ts` - Added chunking in `indexBlockRange()`
- `src/backfill.ts` - Added chunking in backfill loop

---

### 5. Paginated `getAllWalletAddresses` Query ✅

**Location:** [src/services/supabase.ts](src/services/supabase.ts) - `getAllWalletAddresses`

**Change:** Implemented pagination with `PAGE_SIZE = 1000` using Supabase's `.range()` method. Fetches addresses in batches until all are retrieved, preventing memory issues with large wallet counts.

**Files Modified:**
- `src/services/supabase.ts` - Updated `getAllWalletAddresses()` with pagination

---

### 6. Batch Inserts for Wallet Owners ✅

**Location:** [src/services/supabase.ts](src/services/supabase.ts) - `addOwnersBatch`

**Change:** Added `addOwnersBatch()` method that inserts multiple wallet owners in a single database call instead of N individual inserts via `Promise.all()`. Reduces database roundtrips during wallet creation.

**Files Modified:**
- `src/services/supabase.ts` - Added `addOwnersBatch()` method
- `src/events/index.ts` - Updated `handleWalletCreated()` and `handleWalletRegistered()` to use batch insert

---

### 7. Batch Inserts for Guardians ✅

**Location:** [src/services/supabase.ts](src/services/supabase.ts) - `upsertRecoveryConfig`

**Change:** Refactored guardian inserts to use a single batch INSERT instead of `Promise.all()` with individual inserts. Reduces database roundtrips during recovery setup.

**Files Modified:**
- `src/services/supabase.ts` - Updated `upsertRecoveryConfig()` to batch insert guardians

---

### 8. RLS for indexer_state Table ✅

**Location:** [supabase/migrations/schema.sql](supabase/migrations/schema.sql)

**Change:** Added Row Level Security to `indexer_state` table for defense-in-depth consistency with other tables. Includes public read policy and service write policy.

**Files Modified:**
- `supabase/migrations/schema.sql` - Added RLS enable and policies for indexer_state

---

### 9. Database Reset Detection in Poll Loop ✅

**Location:** [src/indexer.ts](src/indexer.ts) - `poll`

**Change:** Modified the `poll()` method to detect when the gap between `lastIndexedBlock` and the current safe block exceeds `batchSize`. When a large gap is detected (e.g., after a database reset), it:
1. Logs the condition with details
2. Reloads tracked wallets (which may have been cleared)
3. Triggers the `backfill()` method instead of `indexBlockRange()` directly

This prevents the "filter range must be less than or equal to 10000" RPC error that occurred when the database was reset while the indexer was running.

**Files Modified:**
- `src/indexer.ts` - Updated `poll()` with gap detection and backfill trigger

---

## Audit Information

- **Audit Date:** February 1, 2026
- **Audited By:** Internal review with Claude
- **Implementation Date:** February 1, 2026
- **Overall Status:** All improvements implemented
- **Critical Issues Found:** 0
- **Items Implemented:** 9
