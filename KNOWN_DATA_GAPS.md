# Known Data Gaps

Two classes of state where indexed data diverges from the chain. Both are reproducible on
mainnet today. Neither is a bug in event handling — the events are processed correctly.
Both come from the same structural cause:

> **The indexer is event-driven, but some contract state is a function of wall-clock time or
> of a counter the indexer does not track. No event fires when that state changes, so the
> database never learns about it.**

Any consumer reading `transactions.confirmation_count`, `transactions.status`,
`social_recoveries.status`, or `confirmations.is_active` directly is affected.

All figures below were measured against the live `mainnet` and `testnet` schemas on
2026-07-27 and cross-checked against mainnet chain state via `hasApproved()`, `isOwner()`,
`ownerVersions()` and `expiredTxs()`. Re-run `npm run verify:gaps` for current numbers.

| # | Gap | Affected columns | Severity | Live on mainnet |
|---|---|---|---|---|
| 1 | Approvals from removed owners stay active | `confirmations.is_active`, `transactions.confirmation_count` | **High** — can signal a transaction is executable when it is not | Yes — 3 stale rows, 2 on pending txs |
| 2 | Expired records stay `pending` | `transactions.status`, `social_recoveries.status` | **High** — two mainnet transactions read as executable today | Yes — 1 recovery, 3 transactions |
| 3 | `recovery_status` enum missing two labels | `social_recoveries.status` | **High** — recovery expiry/invalidation events silently fail to index | Yes — all three schemas |

> **Status: resolved and applied to production on 2026-07-27.** Gap 3 is fixed by migration
> `000`, Gap 2 by the `*_effective` views (`001`), and Gap 1 by the `removeOwner` handler
> plus `002` (columns) and `003` (backfill). All four migrations are applied to `mainnet`,
> `testnet` and `dev`, and both Railway indexers run the updated handler.
>
> Verified against mainnet chain state after the backfill: the three previously-stale
> confirmations now report `confirmation_count = 0`, matching `hasApproved()` for every
> current owner. Run `npm run verify:gaps` to re-check any deployment.

---

## Gap 1 — Approvals from removed owners are still counted

### What the contract does

`QuaiVault` invalidates a departing owner's in-flight approvals using an **epoch counter**,
not by iterating transactions.

`_removeOwner` bumps the owner's version (`contracts/QuaiVault.sol:761-784`):

```solidity
isOwner[owner] = false;
// H-2: Increment owner version to atomically invalidate all in-flight approvals from
// this address. O(1) — no loop over active transactions needed.
unchecked { ownerVersions[owner]++; }
```

An approval only counts while its stored epoch matches the owner's current version
(`contracts/QuaiVault.sol:676-680`):

```solidity
function _approvalValid(bytes32 txHash, address owner) internal view returns (bool) {
    unchecked {
        return _approvalEpochs[txHash][owner] == ownerVersions[owner] + 1;
    }
}
```

So a single `OwnerRemoved` silently invalidates **every** approval that address ever made,
across all pending transactions, in O(1). `_countValidApprovals` and the public
`hasApproved()` both respect this.

**Critically: the invalidation is permanent.** If the same address is re-added as an owner,
`ownerVersions` is *not* decremented, so the old approvals stay invalid and the owner must
approve again under the new epoch.

### What the indexer does

`SupabaseService.removeOwner` (`src/services/supabase.ts:277-301`) updates `wallet_owners`
and nothing else:

```ts
.from('wallet_owners')
.update({
  is_active: false,
  removed_at_block: removedAtBlock,
  removed_at_tx: normalizedTx,
})
```

The `confirmations` table is never touched. And `update_confirmation_count`
(`supabase/migrations/schema.sql:624-641`) counts active confirmations with **no join to
`wallet_owners`**:

```sql
UPDATE %I.transactions SET
    confirmation_count = (
        SELECT COUNT(*) FROM %I.confirmations
        WHERE wallet_address = NEW.wallet_address
        AND tx_hash = NEW.tx_hash
        AND is_active = TRUE
    ), ...
```

`confirmations.is_active` is set `false` only by an explicit `ApprovalRevoked` event.
Owner removal produces no such event, so the row stays active forever.

### Live reproduction (mainnet)

Vault `0x00432fa4a3e6eb3ebcee26ad34a8d80118cb4cfd`, address
`0x004c0d1b601fdbddc1fe125cd39c19b8dbeaa8c0`. This address was added and removed three
times in quick succession:

| added_at_block | removed_at_block |
|---|---|
| 8162894 | 8162903 |
| 8162910 | 8162933 |
| 8162947 | 8162965 |

It approved transaction
`0x58de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54` at block **8162917** —
inside the second ownership window — and was removed at 8162933.

Current state:

```
INDEXER  confirmation_count : 1
INDEXER  active confs       : ['0x004c0d1b601fdbddc1fe125cd39c19b8dbeaa8c0']

CHAIN    isOwner(0x004c0d1b…)     : false
CHAIN    hasApproved(tx, 0x004c…) : false
CHAIN    valid approvals          : 0 of 3 current owners
```

The indexer says 1 approval. The chain says 0.

### Current scale

Sampling every active confirmation on both schemas:

| Schema | Active confirmations | From non-owners | On `pending` transactions |
|---|---|---|---|
| `mainnet` | 237 | **3** | 2 |
| `testnet` | 248 | 0 | 0 |

All three mainnet cases involve the same address, `0x004c0d1b…`. The two on pending
transactions:

| Vault | Tx | Indexer count | Chain valid | Threshold |
|---|---|---|---|---|
| `0x0028fcb418…` | `0x9ec3600b94…` | 1 | 0 | 2 |
| `0x006edb9480…` | `0x1c7d01f3e3…` | 1 | 0 | 2 |

**To be precise about severity:** the over-count is real (1 vs 0) but in both cases it does
not reach the threshold, so neither currently reports a false "ready" *via this gap*. Gap 2
does produce live false-positives on mainnet today — see below.

The false-positive occurs whenever a ghost approval is the one that would tip
`confirmation_count` to `threshold` — e.g. a 2-of-3 vault where one approver is removed
after a second owner has approved. That is an ordinary owner-rotation sequence, not an
exotic one, and the two rows above are one approval away from it.

### Impact

A consumer computing "is this executable?" from `confirmation_count >= threshold` gets false
positives whenever a stale approval crosses the threshold:

- **UI**: shows a transaction as ready; the user pays gas and the call reverts with
  `NotEnoughApprovals()`.
- **Automation / bots**: a retry loop that can never succeed, burning gas each attempt.
- **Monitoring**: quorum dashboards overstate approval progress.

The error is always in the unsafe direction — it over-reports, never under-reports — and it
persists for as long as the affected transactions stay open.

### Recommended fix

Deactivate the affected confirmations in the `OwnerRemoved` handler. Because epoch
invalidation is permanent, deactivation is permanent too — which makes this a simple,
correct, one-way update.

Add a column so a removal-driven invalidation stays distinguishable from a genuine
`ApprovalRevoked` (they mean different things to auditors and to the UI):

```sql
ALTER TABLE <schema>.confirmations
  ADD COLUMN IF NOT EXISTS invalidated_at_block BIGINT,
  ADD COLUMN IF NOT EXISTS invalidated_reason TEXT;  -- e.g. 'owner_removed'
```

> ⚠️ **Re-running `schema.sql` will not do this.** Every table in
> `create_quaivault_schema` is `CREATE TABLE IF NOT EXISTS`, so re-running it on an existing
> schema picks up new views, functions, indexes, triggers and policies but silently skips
> column additions. The `ALTER` has to ship as its own migration — which is why
> `supabase/migrations/002_confirmation_invalidation.sql` exists. (Re-running the schema
> function is otherwise safe: every policy and trigger is `DROP ... IF EXISTS` then
> `CREATE`.)

Also add an index — the invalidation `UPDATE` filters by owner, and both existing
`confirmations` indexes are keyed on `(wallet_address, tx_hash)`:

```sql
CREATE INDEX IF NOT EXISTS idx_confirmations_wallet_owner_active
  ON <schema>.confirmations(wallet_address, owner_address)
  WHERE is_active = TRUE;
```

Then, in `SupabaseService.removeOwner`, after updating `wallet_owners`:

```ts
// The vault invalidates every in-flight approval from this address by bumping
// ownerVersions (QuaiVault._removeOwner). Mirror that here, or confirmation_count
// over-reports for as long as those transactions stay open.
const { error: confError } = await this.client
  .from('confirmations')
  .update({
    is_active: false,
    invalidated_at_block: removedAtBlock,
    invalidated_reason: 'owner_removed',
  })
  .eq('wallet_address', normalizedWallet)
  .eq('owner_address', normalizedOwner)
  .eq('is_active', true);
if (confError) this.fail('removeOwner.invalidateConfirmations', confError);
```

Restricting to open transactions is optional — updating terminal ones is harmless and
avoids a join — but if you prefer to scope it, filter on the transaction status.

The existing `AFTER INSERT OR UPDATE` trigger on `confirmations` recomputes
`confirmation_count` automatically, so no additional work is needed there.

#### ⚠️ Do not "fix" this with a view that joins `wallet_owners`

The obvious alternative — count confirmations `JOIN wallet_owners ON … WHERE is_active` —
is **wrong**, and the reproduction above is exactly the case that breaks it. When a removed
owner is re-added, `wallet_owners.is_active` flips back to `true`, and the view would
resurrect their pre-removal approvals. The contract does the opposite: the epoch has moved
on and those approvals are dead forever.

Deactivating in the event handler (and never reactivating on re-add) matches the contract.

#### ⚠️ Do not apply the same fix to `social_recovery_approvals`

The symmetry is tempting and it is wrong. `SocialRecoveryModule` has **no epoch counter** —
grep it for `Version` or `epoch` and you get zero hits. `approveRecovery` checks
`isGuardian` only at approval time, and `executeRecovery` gates on the stored
`recovery.approvalCount` without ever revalidating guardianship. A removed guardian's
approval therefore *still counts on chain*. The indexer already agrees with the chain here;
"fixing" it would introduce the divergence, not remove it.

There is also no `removeGuardian` to hook: the guardian set is replaced wholesale by
`setupRecovery`. A regression test in
`tests/services/owner-removal-invalidation.test.ts` asserts `removeOwner` writes to exactly
`wallet_owners` and `confirmations`, so this stays locked in.

#### Alternative: mirror epochs exactly

For a fully faithful model, track the counter the contract tracks:

```sql
CREATE TABLE <schema>.owner_versions (
    wallet_address TEXT NOT NULL,
    owner_address  TEXT NOT NULL,
    version        BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (wallet_address, owner_address)
);
```

Increment on every `OwnerRemoved`; store `epoch` on each confirmation row at insert time;
treat an approval as valid iff `epoch = version + 1`. This is a larger change and the
handler fix above is behaviourally equivalent, but it is worth considering if you ever need
to reconstruct historical approval validity at an arbitrary block.

### Backfill

Existing rows need correcting. A confirmation is invalid if the address was removed at any
point *after* making it — so match each confirmation to the **earliest removal at or after
its block**. Taking the earliest matters: an address with several remove/re-add cycles has
multiple qualifying `wallet_owners` rows, and a naive join would record whichever one the
planner happened to pick, giving a misleading `invalidated_at_block`.

```sql
UPDATE <schema>.confirmations c
SET is_active = FALSE,
    invalidated_at_block = r.removed_at_block,
    invalidated_reason = 'owner_removed'
FROM (
    SELECT c2.wallet_address,
           c2.owner_address,
           c2.tx_hash,
           c2.confirmed_at_block,
           MIN(wo.removed_at_block) AS removed_at_block
    FROM <schema>.confirmations c2
    JOIN <schema>.wallet_owners wo
      ON wo.wallet_address = c2.wallet_address
     AND wo.owner_address  = c2.owner_address
    WHERE c2.is_active = TRUE
      AND wo.is_active = FALSE
      AND wo.removed_at_block IS NOT NULL
      AND wo.removed_at_block >= c2.confirmed_at_block
    GROUP BY c2.wallet_address, c2.owner_address, c2.tx_hash, c2.confirmed_at_block
) r
WHERE c.wallet_address     = r.wallet_address
  AND c.owner_address      = r.owner_address
  AND c.tx_hash            = r.tx_hash
  AND c.confirmed_at_block = r.confirmed_at_block
  AND c.is_active = TRUE;
```

Note this correctly leaves alone any approval made *after* a re-add: such a confirmation has
no removal row at or after its block unless the owner was removed again, which is exactly
when it should be invalidated.

The `AFTER INSERT OR UPDATE` trigger fires on this statement, so `confirmation_count` is
recomputed automatically. Confirm with the queries in [Verifying](#verifying).

Run it against `mainnet` and `testnet`. As measured, `mainnet` has 3 rows to correct and
`testnet` has none. Packaged as
`supabase/migrations/003_backfill_stale_confirmations.sql`, which loops over every indexer
schema, refuses to run if migration `002` has not been applied, and reports the row count
per schema. It is idempotent — the `is_active = TRUE` predicate means a second run matches
nothing, so `invalidated_at_block` is never overwritten.

**The `MIN()` is load-bearing, and the live data proves it.** All three mainnet rows have
*two* qualifying `wallet_owners` removal rows, because that address went through three
add/remove cycles. Without the aggregate, the planner picks one arbitrarily and
`invalidated_at_block` becomes misleading.

A dry-run against live data confirmed the backfill's target set is exactly the set the
[Verifying](#verifying) query flags — no misses, no over-reach — and that the resulting
`confirmation_count` (1 → 0 on each) matches `hasApproved()` on chain for all three.

---

## Gap 2 — Expired transactions and recoveries stay `pending`

### What the contracts do

Expiry is a **timestamp comparison**, not a state transition. A transaction past its
`expiration` is already unexecutable — `_executeTransaction` reverts with
`TransactionIsExpired()` — but nothing has changed on chain.

`expireTransaction` (`contracts/QuaiVault.sol:900-913`) and
`expireRecovery` (`contracts/modules/SocialRecoveryModule.sol:540+`) are **permissionless
cleanup calls that somebody has to make**. They exist to reclaim storage and emit a
tombstone event. Frequently nobody bothers.

### What the indexer does

`handleTransactionExpired` (`src/events/vault-core.ts:331-345`) only runs when the
`TransactionExpired` event fires:

```ts
await supabase.updateTransactionStatus(event.address, txHash, 'expired', {
  cancelled_at_block: event.blockNumber,
  cancelled_at_tx: event.transactionHash,
  is_expired: true,
});
```

`updateRecoveryStatus` (`src/services/supabase.ts:701-730`) is the same shape for
`RecoveryExpiredEvent`.

There is no periodic sweep, no scheduled job, and no time-based predicate anywhere in
`src/` or `supabase/migrations/schema.sql`. So if nobody calls the cleanup function, the row
keeps `status = 'pending'` indefinitely, however long past its deadline.

### Live reproduction (mainnet, as of writing)

```sql
-- recoveries past their deadline but still 'pending'
SELECT wallet_address, recovery_hash, status, approval_count,
       required_threshold, expiration
FROM mainnet.social_recoveries
WHERE status = 'pending' AND expiration < extract(epoch from now());
```

→ 1 row: vault `0x006edb94806ec870e3e5d884649c7589aa432950`, recovery
`0xef907596e6…`, `status = 'pending'`, `approval_count = 2`, `required_threshold = 2`,
`expiration = 1779911765` (in the past). The chain reports this recovery as expired and
unexecutable; the database presents it as a fully-approved pending recovery.

```sql
-- transactions past their deadline but still 'pending'
SELECT wallet_address, tx_hash, status, confirmation_count, expiration
FROM mainnet.transactions
WHERE status = 'pending' AND expiration > 0
  AND expiration < extract(epoch from now());
```

→ 3 rows, each with `confirmation_count = 2` and an `expiration` in the past.

Note `expiration = 0` means *no expiry* and must be excluded from any such predicate.

### Impact

This was originally rated below Gap 1 on the reasoning that an expired transaction cannot
execute, so nothing unsafe happens on chain. That understates it. **Two of the three
mainnet rows have `confirmation_count = threshold = 2` while still reading
`status = 'pending'`**, verified against chain on 2026-07-27:

| Vault | Tx | Indexer | Chain |
|---|---|---|---|
| `0x0028fcb418…` | `0x3292cc0485…` | `pending`, 2 of 2 | 2 valid approvals, expired 63 days ago |
| `0x006edb9480…` | `0xf88b70eb93…` | `pending`, 2 of 2 | 2 valid approvals, expired 63 days ago |

A consumer computing `status === 'pending' && confirmation_count >= threshold` renders an
Execute button for both today. The user pays gas and the call reverts
`TransactionIsExpired()`. That is the same user-visible failure Gap 1 is rated High for —
just a different revert — and unlike Gap 1 it is live rather than hypothetical. Both gaps
are High.

`expiredTxs()` returns `false` for all three, confirming nobody has called
`expireTransaction`, so no event will fire on its own and the rows will not self-correct.

Beyond the false-positive, the data is misleading in the ordinary ways:

- Pending-transaction lists never drain; dead items accumulate at the top of the queue.
- "Awaiting your approval" notifications fire for transactions that can never execute.
- A fully-approved expired recovery reads as an active security event, which is alarming
  and wrong.
- Analytics conflate expired with genuinely-pending.

### Recommended fix

A **view** is preferable to a sweep job: always correct, no scheduler, no drift, no
backfill. Add to `create_quaivault_schema(network_name)`:

```sql
EXECUTE format('
    CREATE OR REPLACE VIEW %I.transactions_effective AS
    SELECT t.*,
           CASE
             WHEN t.status = ''pending''
              AND t.expiration > 0
              AND t.expiration < extract(epoch from now())
             THEN ''expired''
             ELSE t.status
           END AS effective_status
    FROM %I.transactions t
', schema_name, schema_name);

EXECUTE format('
    CREATE OR REPLACE VIEW %I.social_recoveries_effective AS
    SELECT r.*,
           CASE
             WHEN r.status = ''pending''
              AND r.expiration IS NOT NULL
              AND r.expiration > 0
              AND r.expiration < extract(epoch from now())
             THEN ''expired''
             ELSE r.status
           END AS effective_status
    FROM %I.social_recoveries r
', schema_name, schema_name);
```

Three mechanics matter when applying this:

- **Placement is load-bearing.** `create_quaivault_schema` runs top-to-bottom, and
  `GRANT SELECT ON ALL TABLES IN SCHEMA` does cover views — but only ones that exist when it
  runs. The view creation must go *before* the grant block, or carry its own explicit
  `GRANT`. Migration `001` grants explicitly because `DROP VIEW` discards grants.
- **`DROP VIEW` + `CREATE VIEW`, not `CREATE OR REPLACE`.** `SELECT t.*` freezes the base
  table's column list at creation time, and replacing a view cannot reorder or retype its
  output columns. Any later `ALTER TABLE ... ADD COLUMN` on `transactions` would make
  `CREATE OR REPLACE` fail. Use plain `DROP` (RESTRICT) so it errors rather than silently
  removing dependents.
- **`security_invoker`.** The base tables have RLS enabled. Without
  `ALTER VIEW ... SET (security_invoker = true)` the views run as their owner and Supabase's
  linter flags them as SECURITY DEFINER views. Behaviour is identical either way here, since
  the read policy is `USING (true)`. The option is PG15+, so migration `001` guards it on
  `current_setting('server_version_num')`.

Cast the CASE result to the status enum (`::public.transaction_status`,
`::public.recovery_status`) rather than leaving it as text — both enums already contain
`expired`, so the cast is free and keeps the view's column type identical to the table's.

Keep the event handlers as they are: when `expireTransaction` / `expireRecovery` *is*
eventually called, the stored `status` becomes `expired` with the real block and tx hash,
which is the authoritative on-chain record. The view covers the interval before that.

If you would rather not add views, a sweep is acceptable but needs a scheduler and will
always lag by its interval:

```sql
UPDATE <schema>.transactions
SET status = 'expired', is_expired = TRUE, updated_at = NOW()
WHERE status = 'pending' AND expiration > 0
  AND expiration < extract(epoch from now());
```

Note this loses the distinction between "expired by the clock" and "formally closed on
chain" unless you leave `cancelled_at_block` null for the former.

---

## Gap 3 — `public.recovery_status` is missing `invalidated` and `expired`

Found while applying the Gap 2 views: creating a view that casts to
`'expired'::public.recovery_status` failed with
`22P02: invalid input value for enum recovery_status`.

Unlike Gaps 1 and 2, this is not a modelling mismatch with the contract. It is a plain
schema-drift bug, and it predates this document.

### Cause

`schema.sql` declares the type with five labels:

```sql
CREATE TYPE public.recovery_status AS ENUM
  ('pending', 'executed', 'cancelled', 'invalidated', 'expired');
```

but the statement is guarded by `IF NOT EXISTS`. The live type was created by an earlier
schema version with only the first three, and re-running `schema.sql` never repaired it —
the guarded `CREATE` is skipped and, unlike `transaction_status` and `transaction_type`,
`recovery_status` had no `ALTER TYPE … ADD VALUE` catch-up block.

An audit of every enum on 2026-07-27 found this is the only one affected:

| Enum | mainnet | testnet | dev |
|---|---|---|---|
| `transaction_status` | complete | complete | complete |
| `transaction_type` | complete | complete | complete |
| `token_standard` | complete | complete | complete |
| `transfer_direction` | complete | complete | complete |
| `recovery_status` | **missing `invalidated`, `expired`** | same | same |

### Impact

Two handlers write labels the database will not accept:

| Code | Writes | Result |
|---|---|---|
| `src/events/social-recovery.ts:212` | `'expired'` (`RecoveryExpiredEvent`) | `22P02`, event skipped |
| `src/events/social-recovery.ts:192` | `'invalidated'` | `22P02`, event skipped |

`processBlockRange` catches per-event errors and skips the event
(`'Failed to process event, skipping'`), so this fails **silently** and is never retried.

**This makes Gap 2's recovery half worse than described above.** Gap 2 says an un-cleaned
recovery stays `pending` because nobody calls `expireRecovery`. The truth is that even when
somebody *does* call it, the indexer cannot record the result — the write is rejected and
the row stays `pending` regardless. The `social_recoveries_effective` view papers over the
display problem; migration `000` fixes the underlying write.

### Fix

`supabase/migrations/000_recovery_status_enum.sql` adds both labels, following the same
pattern the other enums already use. `schema.sql` gains the equivalent catch-up blocks so
future deployments self-heal.

Because a new enum value cannot be used in the transaction that adds it, `000` must be run
alone and allowed to commit before `001`. Both `001` and `create_quaivault_schema` now
precondition-check the label and raise an actionable error rather than a bare `22P02`.

---

## Guidance for consumers

All three gaps are fixed, so the columns are now trustworthy for display. Two habits are
still worth keeping.

**Read status from the `*_effective` views, not the base tables.** The base
`transactions.status` and `social_recoveries.status` intentionally remain `pending` past a
deadline until somebody calls the permissionless `expireTransaction` / `expireRecovery` and
the tombstone event is indexed. That is the correct record of *on-chain* state, but it is
not what a user should see:

```sql
SELECT tx_hash, effective_status FROM <schema>.transactions_effective
WHERE wallet_address = $1 AND effective_status = 'pending';
```

Equivalently, derive it client-side:

```ts
if (status === 'pending' && expiration > 0 && now > expiration) status = 'expired';
```

**Anything that gates a signature must still re-read the chain.** `confirmation_count` is
now correct, but it is a cache: it can lag the chain head by a block or more, and an
approval or removal landing in that window is invisible. Before prompting a user to sign, or
before an automated execute, call `hasApproved(txHash, owner)` per current owner — that is
authoritative in every case, including remove-then-re-add.

`@quaivault/sdk` follows both rules: it derives effective status itself (so it stays correct
against an indexer that has not yet been migrated), intersects confirmations with the live
owner set as defence in depth, and re-validates on chain before every write. Those
workarounds are now redundant with a migrated indexer but remain as belt-and-braces — and
they are what keeps the SDK correct when pointed at a self-hosted indexer that lacks these
migrations.

---

## Verifying

After the Gap 1 fix, this should return zero rows on every schema:

```sql
-- active confirmations from addresses that are no longer owners
SELECT c.wallet_address, c.tx_hash, c.owner_address
FROM <schema>.confirmations c
WHERE c.is_active = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM <schema>.wallet_owners wo
    WHERE wo.wallet_address = c.wallet_address
      AND wo.owner_address  = c.owner_address
      AND wo.is_active = TRUE
  );
```

And this should show no drift between the stored count and the owner-aware count:

```sql
SELECT t.wallet_address, t.tx_hash, t.confirmation_count AS stored,
       COUNT(c.*) FILTER (WHERE c.is_active) AS recomputed
FROM <schema>.transactions t
LEFT JOIN <schema>.confirmations c
  ON c.wallet_address = t.wallet_address AND c.tx_hash = t.tx_hash
WHERE t.status = 'pending'
GROUP BY t.wallet_address, t.tx_hash, t.confirmation_count
HAVING t.confirmation_count <> COUNT(c.*) FILTER (WHERE c.is_active);
```

For Gap 2, the two reproduction queries above should return zero rows once the views are in
use (or after each sweep).

### Automated verification

```bash
npm run verify:gaps              # mainnet + testnet
npm run verify:gaps -- dev       # a specific schema
```

`scripts/verify-data-gaps.mjs` runs every check in this section against a live deployment
and exits non-zero on failure, so it can gate a deploy. It is read-only. Checks that a view
is missing are reported as `SKIP` rather than a failure, so it is safe to run before the
migrations are applied.

### Regression tests

`tests/services/owner-removal-invalidation.test.ts` covers Gap 1 (10 tests):

- `OwnerRemoved` deactivates that owner's confirmations, across every transaction rather
  than one, leaving `revoked_at_block` free for a genuine `ApprovalRevoked`.
- Re-adding the same owner does **not** reactivate them (`addOwner`, `addOwnersBatch`).
- `removeOwner` writes to exactly `wallet_owners` and `confirmations` — the guard against
  someone later symmetrizing the fix onto `social_recovery_approvals`.

Gap 2 lives entirely in SQL views, which unit tests cannot reach; `npm run verify:gaps`
covers it instead — past-deadline rows report `expired`, `expiration = 0` continues to
report `pending`, and terminal statuses (including `cancelled` recoveries) pass through
unrewritten.

---

## References

| Subject | Location |
|---|---|
| Epoch-based approvals | `quaivault-contracts/contracts/QuaiVault.sol:135-148, 668-724` |
| `_removeOwner` version bump | `quaivault-contracts/contracts/QuaiVault.sol:761-784` |
| `expireTransaction` | `quaivault-contracts/contracts/QuaiVault.sol:900-913` |
| `expireRecovery` | `quaivault-contracts/contracts/modules/SocialRecoveryModule.sol:540+` |
| `removeOwner` handler | `src/services/supabase.ts:277-301` |
| `confirmation_count` trigger | `supabase/migrations/schema.sql:624-641` |
| `handleTransactionExpired` | `src/events/vault-core.ts:331-345` |
| `updateRecoveryStatus` | `src/services/supabase.ts:701-730` |
| SDK workarounds | `quaivault-sdk/src/vault.ts` (`buildTransaction`), `quaivault-sdk/src/lifecycle/status.ts` (`deriveStatus`, `deriveRecoveryStatus`) |
| `recovery_status` enum fix | `supabase/migrations/000_recovery_status_enum.sql` |
| Effective-status views | `supabase/migrations/001_effective_status_views.sql` |
| Invalidation columns | `supabase/migrations/002_confirmation_invalidation.sql` |
| Backfill | `supabase/migrations/003_backfill_stale_confirmations.sql` |
| Verification script | `scripts/verify-data-gaps.mjs` (`npm run verify:gaps`) |
| Gap 1 regression tests | `tests/services/owner-removal-invalidation.test.ts` |

---

## Applying the fixes

Run in the Supabase SQL editor, in order. `001` and `002` are additive — they create views,
add two nullable columns and one index, and modify no existing row. `003` is the only one
that writes to existing data.

| Step | File | Effect |
|---|---|---|
| 1 | `000_recovery_status_enum.sql` | Adds the two missing `recovery_status` labels. **Run alone and let it commit** — `001` cannot use a label added in the same transaction. Additive. |
| 2 | `001_effective_status_views.sql` | Creates the two `*_effective` views in every indexer schema. Additive. |
| 3 | `002_confirmation_invalidation.sql` | Adds `invalidated_at_block`, `invalidated_reason`, and the owner index. Additive. |
| 4 | *dry run* | Run the commented `SELECT` at the top of `003` alone. Expect 3 rows on `mainnet`, 0 on `testnet`. |
| 5 | `003_backfill_stale_confirmations.sql` | Deactivates the stale confirmations. **Modifies data.** |
| 6 | `npm run verify:gaps` | All checks should pass on both schemas. |

**Apply migration `002` before deploying the indexer change.** The handler writes
`invalidated_at_block`, and `processBlockRange` catches per-event errors and *skips* the
event (`'Failed to process event, skipping'`) rather than halting. Against a schema without
the column, an `OwnerRemoved` would therefore apply the `wallet_owners` update, fail on the
`confirmations` update, and then be skipped — silently half-applied, with no retry. Only a
backfill of that block range would recover it.

The `wallet_owners` update deliberately stays first: if the second update fails, the
resulting state is the original Gap 1 bug, which `npm run verify:gaps` detects. Reversing
the order would fail into a state that looks clean but is not.

Steps 1 and 2 are independent of the deploy and safe to apply first. All three migrations
are idempotent and safe to re-run.

**PostgREST caches the schema it exposes.** Both `001` and `002` end with
`NOTIFY pgrst, 'reload schema';` for this reason. Without it the new views stay invisible to
the REST API, and — worse — the indexer's `UPDATE` fails with
`column confirmations.invalidated_at_block does not exist` even though the column is
present. If `npm run verify:gaps` still reports `SKIP` after applying `001`, the cache has
not reloaded yet.
