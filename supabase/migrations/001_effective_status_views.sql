-- ============================================================================
-- 001 — Effective-status views (KNOWN_DATA_GAPS.md, Gap 2)
-- ============================================================================
--
-- Expiry is a timestamp comparison on chain, not a state transition.
-- `expireTransaction` / `expireRecovery` are permissionless cleanup calls that
-- somebody has to make, and frequently nobody does. Until then no event fires
-- and the indexed row keeps `status = 'pending'` however long past its deadline.
--
-- Verified on mainnet 2026-07-27: 3 transactions and 1 recovery past expiration
-- still reading `pending`. Two of those transactions have
-- confirmation_count = threshold = 2, so a consumer computing
-- `status = 'pending' AND confirmation_count >= threshold` renders them as
-- executable; on chain `executeTransaction` reverts `TransactionIsExpired()`.
--
-- This migration is ADDITIVE ONLY. It creates two views. It does not alter,
-- delete, or rewrite a single row of existing data.
--
-- Safe to re-run. Idempotent.
--
-- Applies to every schema that has the indexer tables (mainnet, testnet, dev, …).
--
-- ⚠️ REQUIRES 000 to have been applied AND COMMITTED first. This file casts to
-- `public.recovery_status`, whose live definition is missing the 'expired' label,
-- and a new enum value cannot be used in the transaction that adds it. Running
-- 000 and 001 together fails with:
--   22P02: invalid input value for enum recovery_status: "expired"
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'recovery_status' AND e.enumlabel = 'expired'
    ) THEN
        RAISE EXCEPTION
            'public.recovery_status is missing the ''expired'' label — apply 000_recovery_status_enum.sql, let it commit, then re-run this file.';
    END IF;
END $$;

DO $$
DECLARE
    target_schema TEXT;
    applied INT := 0;
BEGIN
    FOR target_schema IN
        SELECT t.table_schema
        FROM information_schema.tables t
        WHERE t.table_name = 'transactions'
          AND t.table_type = 'BASE TABLE'
          AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND EXISTS (
              SELECT 1 FROM information_schema.tables s
              WHERE s.table_schema = t.table_schema
                AND s.table_name = 'social_recoveries'
                AND s.table_type = 'BASE TABLE'
          )
        ORDER BY t.table_schema
    LOOP
        -- DROP + CREATE rather than CREATE OR REPLACE: replacing a view cannot
        -- reorder or retype its output columns, and `SELECT t.*` freezes the base
        -- table's column list at creation time. Any future ALTER TABLE ... ADD COLUMN
        -- on the base table would make CREATE OR REPLACE fail here. Plain DROP
        -- (RESTRICT, not CASCADE) errors instead of silently removing dependents.
        EXECUTE format('DROP VIEW IF EXISTS %I.transactions_effective', target_schema);
        EXECUTE format('
            CREATE VIEW %I.transactions_effective AS
            SELECT t.*,
                   CASE
                     WHEN t.status = ''pending''
                      AND COALESCE(t.expiration, 0) > 0
                      AND t.expiration < extract(epoch from now())
                     THEN ''expired''::public.transaction_status
                     ELSE t.status
                   END AS effective_status
            FROM %I.transactions t
        ', target_schema, target_schema);

        EXECUTE format('DROP VIEW IF EXISTS %I.social_recoveries_effective', target_schema);
        EXECUTE format('
            CREATE VIEW %I.social_recoveries_effective AS
            SELECT r.*,
                   CASE
                     WHEN r.status = ''pending''
                      AND COALESCE(r.expiration, 0) > 0
                      AND r.expiration < extract(epoch from now())
                     THEN ''expired''::public.recovery_status
                     ELSE r.status
                   END AS effective_status
            FROM %I.social_recoveries r
        ', target_schema, target_schema);

        -- PG15+: respect the querying role's RLS on the base tables rather than
        -- running as the view owner. Behaviour is identical here (the read policy
        -- is USING (true)), but it keeps Supabase's linter quiet about
        -- SECURITY DEFINER views.
        IF current_setting('server_version_num')::int >= 150000 THEN
            EXECUTE format('ALTER VIEW %I.transactions_effective SET (security_invoker = true)', target_schema);
            EXECUTE format('ALTER VIEW %I.social_recoveries_effective SET (security_invoker = true)', target_schema);
        END IF;

        -- DROP VIEW discards grants, so re-grant explicitly. Matches the blanket
        -- GRANT SELECT ON ALL TABLES the schema function applies.
        EXECUTE format('GRANT SELECT ON %I.transactions_effective TO authenticated, anon, service_role', target_schema);
        EXECUTE format('GRANT SELECT ON %I.social_recoveries_effective TO authenticated, anon, service_role', target_schema);

        applied := applied + 1;
        RAISE NOTICE 'effective-status views created in schema "%"', target_schema;
    END LOOP;

    IF applied = 0 THEN
        RAISE EXCEPTION 'no indexer schemas found — nothing was changed';
    END IF;

    RAISE NOTICE '001 complete: % schema(s) updated', applied;
END $$;

-- PostgREST caches the schema it exposes, so the new views are not reachable over
-- the REST API (and `npm run verify:gaps` keeps reporting SKIP) until it reloads.
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- Post-check — run separately after the migration.
-- Expect: one row per schema, effective_status = 'expired', status = 'pending'.
-- ============================================================================
--
--   SELECT wallet_address, tx_hash, status, effective_status,
--          confirmation_count, expiration
--   FROM mainnet.transactions_effective
--   WHERE status <> effective_status;
--
--   SELECT wallet_address, recovery_hash, status, effective_status,
--          approval_count, required_threshold, expiration
--   FROM mainnet.social_recoveries_effective
--   WHERE status <> effective_status;
