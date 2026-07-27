-- ============================================================================
-- 003 — Backfill: deactivate approvals from removed owners (Gap 1)
-- ============================================================================
--
-- REQUIRES 002 to have been applied first.
--
-- This is the only migration in this set that MODIFIES EXISTING ROWS.
-- Run the DRY RUN below first and confirm the row set before running it.
--
-- Dry-run performed against live data on 2026-07-27:
--   mainnet — 3 rows (all owner 0x004c0d1b…, 2 on pending txs, 1 on a cancelled tx)
--   testnet — 0 rows
-- For each of the three, hasApproved(txHash, owner) on mainnet returns false and
-- the resulting confirmation_count (1 -> 0) matches the chain's valid-approval
-- count exactly.
--
-- A confirmation is invalid if the address was removed at any point AFTER making
-- it, so each confirmation is matched to the EARLIEST removal at or after its
-- block. Taking the earliest matters: all three mainnet rows have TWO qualifying
-- wallet_owners rows (that address went through three add/remove cycles), and a
-- naive join would record whichever the planner happened to pick, giving a
-- misleading invalidated_at_block.
--
-- Approvals made AFTER a re-add are correctly left alone: they have no removal
-- row at or after their block unless the owner was removed again — which is
-- exactly when they should be invalidated.
--
-- Idempotent: the `c.is_active = TRUE` predicate means a second run matches
-- nothing, so invalidated_at_block is never overwritten.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- DRY RUN — run this ALONE first. Changes nothing.
-- Expect 3 rows on mainnet, 0 on testnet, and `would_set_invalidated_at_block`
-- to be >= confirmed_at_block on every row.
-- ----------------------------------------------------------------------------
--
--   SELECT c.wallet_address,
--          c.tx_hash,
--          c.owner_address,
--          c.confirmed_at_block,
--          MIN(wo.removed_at_block) AS would_set_invalidated_at_block,
--          COUNT(*)                 AS candidate_removal_rows,
--          t.status                 AS tx_status,
--          t.confirmation_count     AS count_before
--   FROM mainnet.confirmations c
--   JOIN mainnet.wallet_owners wo
--     ON wo.wallet_address = c.wallet_address
--    AND wo.owner_address  = c.owner_address
--   JOIN mainnet.transactions t
--     ON t.wallet_address = c.wallet_address
--    AND t.tx_hash        = c.tx_hash
--   WHERE c.is_active = TRUE
--     AND wo.is_active = FALSE
--     AND wo.removed_at_block IS NOT NULL
--     AND wo.removed_at_block >= c.confirmed_at_block
--   GROUP BY c.wallet_address, c.tx_hash, c.owner_address,
--            c.confirmed_at_block, t.status, t.confirmation_count
--   ORDER BY c.wallet_address;
--
-- ----------------------------------------------------------------------------


DO $$
DECLARE
    target_schema TEXT;
    updated INT;
    total INT := 0;
BEGIN
    FOR target_schema IN
        SELECT t.table_schema
        FROM information_schema.tables t
        WHERE t.table_name = 'confirmations'
          AND t.table_type = 'BASE TABLE'
          AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY t.table_schema
    LOOP
        -- Fail loudly rather than silently skipping if 002 was not applied.
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = target_schema
              AND table_name   = 'confirmations'
              AND column_name  = 'invalidated_at_block'
        ) THEN
            RAISE EXCEPTION
                'schema "%" is missing confirmations.invalidated_at_block — apply 002 first',
                target_schema;
        END IF;

        EXECUTE format('
            UPDATE %I.confirmations c
            SET is_active            = FALSE,
                invalidated_at_block = r.removed_at_block,
                invalidated_reason   = ''owner_removed''
            FROM (
                SELECT c2.wallet_address,
                       c2.owner_address,
                       c2.tx_hash,
                       c2.confirmed_at_block,
                       MIN(wo.removed_at_block) AS removed_at_block
                FROM %I.confirmations c2
                JOIN %I.wallet_owners wo
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
              AND c.is_active = TRUE
        ', target_schema, target_schema, target_schema);

        GET DIAGNOSTICS updated = ROW_COUNT;
        total := total + updated;
        RAISE NOTICE 'schema "%": % confirmation(s) invalidated', target_schema, updated;
    END LOOP;

    RAISE NOTICE '003 complete: % row(s) updated in total', total;
END $$;

-- The AFTER UPDATE trigger on confirmations fires per row, so
-- transactions.confirmation_count is recomputed automatically. No further work.


-- ============================================================================
-- Post-check — run separately after the migration. Both should return 0 rows.
-- ============================================================================
--
-- 1. No active confirmations from addresses that are not currently owners.
--    (Approvals made after a re-add are legitimately active and have a matching
--    active wallet_owners row, so they do not appear here.)
--
--   SELECT c.wallet_address, c.tx_hash, c.owner_address
--   FROM mainnet.confirmations c
--   WHERE c.is_active = TRUE
--     AND NOT EXISTS (
--       SELECT 1 FROM mainnet.wallet_owners wo
--       WHERE wo.wallet_address = c.wallet_address
--         AND wo.owner_address  = c.owner_address
--         AND wo.is_active = TRUE
--     );
--
-- 2. No drift between the stored count and a recount of active confirmations.
--
--   SELECT t.wallet_address, t.tx_hash, t.confirmation_count AS stored,
--          COUNT(c.*) FILTER (WHERE c.is_active) AS recomputed
--   FROM mainnet.transactions t
--   LEFT JOIN mainnet.confirmations c
--     ON c.wallet_address = t.wallet_address AND c.tx_hash = t.tx_hash
--   WHERE t.status = 'pending'
--   GROUP BY t.wallet_address, t.tx_hash, t.confirmation_count
--   HAVING t.confirmation_count <> COUNT(c.*) FILTER (WHERE c.is_active);
