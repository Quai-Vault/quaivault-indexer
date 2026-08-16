-- ============================================================================
-- 005 — Make atomic rebuild compatible with Supabase safe-update enforcement
-- ============================================================================
-- Supabase rejects DELETE statements without an explicit predicate, including
-- statements executed inside an RPC function. Both address columns are primary
-- keys and therefore non-null, so these predicates still delete every row while
-- satisfying the guard. Wallet-dependent and token-dependent rows continue to
-- be removed by their existing ON DELETE CASCADE constraints.

DO $$
DECLARE
    target_schema TEXT;
    applied INT := 0;
BEGIN
    FOR target_schema IN
        SELECT t.table_schema
        FROM information_schema.tables t
        WHERE t.table_name = 'indexer_state'
          AND t.table_type = 'BASE TABLE'
          AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND EXISTS (
              SELECT 1 FROM information_schema.tables x
              WHERE x.table_schema = t.table_schema AND x.table_name = 'wallets'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.tables x
              WHERE x.table_schema = t.table_schema AND x.table_name = 'tokens'
          )
        ORDER BY t.table_schema
    LOOP
        EXECUTE format($migration$
            CREATE OR REPLACE FUNCTION %I.reset_indexed_data(
                p_last_indexed_block BIGINT,
                p_expected_indexed_block BIGINT,
                p_expected_block_hash TEXT
            )
            RETURNS VOID
            LANGUAGE plpgsql
            SECURITY INVOKER
            SET search_path = %I
            AS $func$
            DECLARE
                current_block BIGINT;
                current_hash TEXT;
            BEGIN
                IF p_last_indexed_block < -1 THEN
                    RAISE EXCEPTION 'reset checkpoint must be >= -1';
                END IF;
                PERFORM pg_advisory_xact_lock(hashtext('quaivault_indexer_reset'));
                SELECT last_indexed_block, last_block_hash
                INTO current_block, current_hash
                FROM indexer_state
                WHERE id = 'main'
                FOR UPDATE;
                IF current_block IS DISTINCT FROM p_expected_indexed_block
                   OR lower(current_hash) IS DISTINCT FROM lower(p_expected_block_hash) THEN
                    RAISE EXCEPTION 'indexer checkpoint changed before reset';
                END IF;
                DELETE FROM wallets WHERE address IS NOT NULL;
                DELETE FROM tokens WHERE address IS NOT NULL;
                UPDATE indexer_state
                SET last_indexed_block = p_last_indexed_block,
                    last_block_hash = NULL,
                    last_indexed_at = NOW(),
                    is_syncing = TRUE,
                    updated_at = NOW()
                WHERE id = 'main';
            END;
            $func$
        $migration$, target_schema, target_schema);

        EXECUTE format(
            'REVOKE ALL ON FUNCTION %I.reset_indexed_data(BIGINT, BIGINT, TEXT) FROM PUBLIC, authenticated, anon',
            target_schema
        );
        EXECUTE format(
            'GRANT EXECUTE ON FUNCTION %I.reset_indexed_data(BIGINT, BIGINT, TEXT) TO service_role',
            target_schema
        );

        applied := applied + 1;
        RAISE NOTICE 'safe rebuild delete predicates installed in schema "%"', target_schema;
    END LOOP;

    IF applied = 0 THEN
        RAISE EXCEPTION 'no indexer schemas found — nothing was changed';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
