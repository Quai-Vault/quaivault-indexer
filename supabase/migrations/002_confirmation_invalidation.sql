-- ============================================================================
-- 002 — Confirmation invalidation columns (KNOWN_DATA_GAPS.md, Gap 1)
-- ============================================================================
--
-- QuaiVault invalidates a departing owner's in-flight approvals with an epoch
-- counter rather than by iterating transactions: `_removeOwner` bumps
-- `ownerVersions[owner]`, and `_approvalValid` requires
-- `_approvalEpochs[txHash][owner] == ownerVersions[owner] + 1`. One OwnerRemoved
-- therefore kills every approval that address ever made, across all pending
-- transactions, in O(1) — and permanently: re-adding the owner does NOT
-- decrement the version, so the old approvals stay dead.
--
-- The indexer's removeOwner handler only touched `wallet_owners`, so those
-- confirmations stayed `is_active = TRUE` and kept inflating
-- `transactions.confirmation_count`.
--
-- These columns keep a removal-driven invalidation distinguishable from a
-- genuine ApprovalRevoked — they mean different things to auditors and to the
-- UI, and `revoked_at_block` must stay reserved for the real revocation event.
--
-- This migration is ADDITIVE ONLY: two nullable columns and one index. It does
-- not modify any existing row. The backfill is deliberately a separate file
-- (003) so it can be dry-run first.
--
-- Safe to re-run. Idempotent.
-- ============================================================================

DO $$
DECLARE
    target_schema TEXT;
    applied INT := 0;
BEGIN
    FOR target_schema IN
        SELECT t.table_schema
        FROM information_schema.tables t
        WHERE t.table_name = 'confirmations'
          AND t.table_type = 'BASE TABLE'
          AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY t.table_schema
    LOOP
        EXECUTE format('
            ALTER TABLE %I.confirmations
              ADD COLUMN IF NOT EXISTS invalidated_at_block BIGINT,
              ADD COLUMN IF NOT EXISTS invalidated_reason   TEXT
        ', target_schema);

        -- The invalidation UPDATE filters on (wallet_address, owner_address)
        -- among active rows; the existing indexes are both keyed on
        -- (wallet_address, tx_hash) and do not serve it.
        EXECUTE format('
            CREATE INDEX IF NOT EXISTS idx_confirmations_wallet_owner_active
              ON %I.confirmations(wallet_address, owner_address)
              WHERE is_active = TRUE
        ', target_schema);

        applied := applied + 1;
        RAISE NOTICE 'confirmation invalidation columns added in schema "%"', target_schema;
    END LOOP;

    IF applied = 0 THEN
        RAISE EXCEPTION 'no indexer schemas found — nothing was changed';
    END IF;

    RAISE NOTICE '002 complete: % schema(s) updated', applied;
END $$;

-- The indexer writes these columns through PostgREST, which caches the schema it
-- exposes. Without a reload, removeOwner's UPDATE fails with
-- "column confirmations.invalidated_at_block does not exist" even though it does.
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- Post-check — run separately after the migration.
-- Expect: both columns present, all values NULL (the backfill is migration 003).
-- ============================================================================
--
--   SELECT table_schema, column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'confirmations'
--     AND column_name IN ('invalidated_at_block', 'invalidated_reason')
--   ORDER BY table_schema, column_name;
