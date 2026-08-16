-- ============================================================================
-- 004 — First-class wallet module lifecycle and inventory
-- ============================================================================
-- Additive lifecycle history plus an ordered current-state projection.
-- Existing wallet_modules rows are retained. No historical lifecycle events are
-- synthesized from the mutable projection; run `npm run backfill:modules` after
-- deployment to populate the append-only history from chain logs.

DO $$
DECLARE
    target_schema TEXT;
    applied INT := 0;
BEGIN
    FOR target_schema IN
        SELECT t.table_schema
        FROM information_schema.tables t
        WHERE t.table_name = 'wallet_modules'
          AND t.table_type = 'BASE TABLE'
          AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND EXISTS (SELECT 1 FROM information_schema.tables x WHERE x.table_schema = t.table_schema AND x.table_name = 'wallets')
          AND EXISTS (SELECT 1 FROM information_schema.tables x WHERE x.table_schema = t.table_schema AND x.table_name = 'transactions')
          AND EXISTS (SELECT 1 FROM information_schema.tables x WHERE x.table_schema = t.table_schema AND x.table_name = 'module_executions')
          AND EXISTS (SELECT 1 FROM information_schema.tables x WHERE x.table_schema = t.table_schema AND x.table_name = 'indexer_state')
        ORDER BY t.table_schema
    LOOP
        EXECUTE format('
            ALTER TABLE %I.wallet_modules
              ALTER COLUMN enabled_at_block DROP NOT NULL,
              ALTER COLUMN enabled_at_tx DROP NOT NULL,
              ADD COLUMN IF NOT EXISTS last_event_block BIGINT,
              ADD COLUMN IF NOT EXISTS last_event_block_hash TEXT,
              ADD COLUMN IF NOT EXISTS last_event_tx TEXT,
              ADD COLUMN IF NOT EXISTS last_event_log_index INTEGER NOT NULL DEFAULT -1
        ', target_schema);

        -- Correct stale disable metadata and establish ordering provenance for
        -- pre-migration projection rows without inventing lifecycle history.
        EXECUTE format('
            UPDATE %I.wallet_modules
            SET disabled_at_block = CASE WHEN is_active THEN NULL ELSE disabled_at_block END,
                disabled_at_tx = CASE WHEN is_active THEN NULL ELSE disabled_at_tx END,
                last_event_block = COALESCE(
                    last_event_block,
                    CASE WHEN is_active THEN enabled_at_block ELSE COALESCE(disabled_at_block, enabled_at_block) END
                ),
                last_event_tx = COALESCE(
                    last_event_tx,
                    CASE WHEN is_active THEN enabled_at_tx ELSE COALESCE(disabled_at_tx, enabled_at_tx) END
                ),
                updated_at = NOW()
        ', target_schema);

        EXECUTE format('
            ALTER TABLE %I.wallet_modules
              ALTER COLUMN last_event_block SET NOT NULL,
              ALTER COLUMN last_event_tx SET NOT NULL
        ', target_schema);

        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I.wallet_module_events (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
                module_address TEXT NOT NULL,
                event_type TEXT NOT NULL CHECK (event_type IN (''enabled'', ''disabled'')),
                event_block BIGINT NOT NULL CHECK (event_block >= 0),
                event_block_hash TEXT,
                event_tx TEXT NOT NULL,
                log_index INTEGER NOT NULL CHECK (log_index >= 0),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(wallet_address, event_tx, log_index)
            )
        ', target_schema, target_schema);

        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_wallet_module_events_wallet_block ON %I.wallet_module_events(wallet_address, event_block DESC, log_index DESC)', target_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_wallet_module_events_module_block ON %I.wallet_module_events(module_address, event_block DESC, log_index DESC)', target_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_wallet_module_events_block ON %I.wallet_module_events(event_block)', target_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_module_executions_inventory ON %I.module_executions(wallet_address, module_address, executed_at_block DESC, log_index DESC NULLS LAST)', target_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_module_executions_wallet_order ON %I.module_executions(wallet_address, executed_at_block DESC, log_index DESC NULLS LAST)', target_schema);

        EXECUTE format('
            CREATE OR REPLACE FUNCTION %I.apply_wallet_module_event(
                p_wallet TEXT,
                p_module TEXT,
                p_event_type TEXT,
                p_event_block BIGINT,
                p_event_block_hash TEXT,
                p_event_tx TEXT,
                p_log_index INTEGER
            )
            RETURNS TEXT
            LANGUAGE plpgsql
            SECURITY INVOKER
            SET search_path = %I
            AS $func$
            DECLARE
                inserted_id UUID;
                projection_existed BOOLEAN;
                changed_rows INTEGER;
                normalized_wallet TEXT := lower(p_wallet);
                normalized_module TEXT := lower(p_module);
                normalized_tx TEXT := lower(p_event_tx);
            BEGIN
                IF p_event_type NOT IN (''enabled'', ''disabled'') THEN
                    RAISE EXCEPTION ''invalid module event type: %%'', p_event_type;
                END IF;
                IF p_event_block < 0 OR p_log_index < 0 THEN
                    RAISE EXCEPTION ''module event block and log index must be non-negative'';
                END IF;

                SELECT EXISTS (
                    SELECT 1 FROM wallet_modules
                    WHERE wallet_address = normalized_wallet
                      AND module_address = normalized_module
                ) INTO projection_existed;

                INSERT INTO wallet_module_events (
                    wallet_address, module_address, event_type, event_block,
                    event_block_hash, event_tx, log_index
                ) VALUES (
                    normalized_wallet, normalized_module, p_event_type, p_event_block,
                    lower(p_event_block_hash), normalized_tx, p_log_index
                )
                ON CONFLICT (wallet_address, event_tx, log_index) DO NOTHING
                RETURNING id INTO inserted_id;

                IF inserted_id IS NULL THEN
                    IF EXISTS (
                        SELECT 1 FROM wallet_module_events
                        WHERE wallet_address = normalized_wallet
                          AND event_tx = normalized_tx
                          AND log_index = p_log_index
                          AND module_address = normalized_module
                          AND event_type = p_event_type
                          AND event_block = p_event_block
                          AND event_block_hash IS NOT DISTINCT FROM lower(p_event_block_hash)
                    ) THEN
                        RETURN ''duplicate'';
                    END IF;
                    RAISE EXCEPTION ''module event identity collision for wallet %%, tx %%, log %%'',
                        normalized_wallet, normalized_tx, p_log_index;
                END IF;

                IF p_event_type = ''enabled'' THEN
                    INSERT INTO wallet_modules (
                        wallet_address, module_address, enabled_at_block, enabled_at_tx,
                        disabled_at_block, disabled_at_tx, is_active,
                        last_event_block, last_event_block_hash, last_event_tx,
                        last_event_log_index, updated_at
                    ) VALUES (
                        normalized_wallet, normalized_module, p_event_block, normalized_tx,
                        NULL, NULL, TRUE,
                        p_event_block, lower(p_event_block_hash), normalized_tx,
                        p_log_index, NOW()
                    )
                    ON CONFLICT (wallet_address, module_address) DO UPDATE SET
                        enabled_at_block = EXCLUDED.enabled_at_block,
                        enabled_at_tx = EXCLUDED.enabled_at_tx,
                        disabled_at_block = NULL,
                        disabled_at_tx = NULL,
                        is_active = TRUE,
                        last_event_block = EXCLUDED.last_event_block,
                        last_event_block_hash = EXCLUDED.last_event_block_hash,
                        last_event_tx = EXCLUDED.last_event_tx,
                        last_event_log_index = EXCLUDED.last_event_log_index,
                        updated_at = NOW()
                    WHERE (wallet_modules.last_event_block, wallet_modules.last_event_log_index)
                        < (EXCLUDED.last_event_block, EXCLUDED.last_event_log_index);
                ELSE
                    INSERT INTO wallet_modules (
                        wallet_address, module_address, enabled_at_block, enabled_at_tx,
                        disabled_at_block, disabled_at_tx, is_active,
                        last_event_block, last_event_block_hash, last_event_tx,
                        last_event_log_index, updated_at
                    ) VALUES (
                        normalized_wallet, normalized_module, NULL, NULL,
                        p_event_block, normalized_tx, FALSE,
                        p_event_block, lower(p_event_block_hash), normalized_tx,
                        p_log_index, NOW()
                    )
                    ON CONFLICT (wallet_address, module_address) DO UPDATE SET
                        disabled_at_block = EXCLUDED.disabled_at_block,
                        disabled_at_tx = EXCLUDED.disabled_at_tx,
                        is_active = FALSE,
                        last_event_block = EXCLUDED.last_event_block,
                        last_event_block_hash = EXCLUDED.last_event_block_hash,
                        last_event_tx = EXCLUDED.last_event_tx,
                        last_event_log_index = EXCLUDED.last_event_log_index,
                        updated_at = NOW()
                    WHERE (wallet_modules.last_event_block, wallet_modules.last_event_log_index)
                        < (EXCLUDED.last_event_block, EXCLUDED.last_event_log_index);
                END IF;

                GET DIAGNOSTICS changed_rows = ROW_COUNT;
                IF changed_rows = 0 THEN
                    -- An older enable discovered after an orphan disable must
                    -- hydrate enable provenance without replacing newer state.
                    UPDATE wallet_modules projection
                    SET enabled_at_block = latest_enable.event_block,
                        enabled_at_tx = latest_enable.event_tx,
                        updated_at = NOW()
                    FROM (
                        SELECT event_block, event_tx
                        FROM wallet_module_events
                        WHERE wallet_address = normalized_wallet
                          AND module_address = normalized_module
                          AND event_type = ''enabled''
                        ORDER BY event_block DESC, log_index DESC
                        LIMIT 1
                    ) latest_enable
                    WHERE projection.wallet_address = normalized_wallet
                      AND projection.module_address = normalized_module
                      AND projection.is_active = FALSE
                      AND (
                          projection.enabled_at_block IS DISTINCT FROM latest_enable.event_block OR
                          projection.enabled_at_tx IS DISTINCT FROM latest_enable.event_tx
                      );
                    RETURN ''out_of_order'';
                END IF;
                IF p_event_type = ''disabled'' AND NOT projection_existed THEN
                    RETURN ''orphan_applied'';
                END IF;
                RETURN ''applied'';
            END;
            $func$
        ', target_schema, target_schema);

        EXECUTE format('
            CREATE OR REPLACE FUNCTION %I.rollback_wallet_module_events_after(p_block_number BIGINT)
            RETURNS INTEGER
            LANGUAGE plpgsql
            SECURITY INVOKER
            SET search_path = %I
            AS $func$
            DECLARE
                removed_events INTEGER;
            BEGIN
                IF p_block_number < -1 THEN
                    RAISE EXCEPTION ''rollback block must be >= -1'';
                END IF;
                CREATE TEMP TABLE IF NOT EXISTS qv_affected_modules (
                    wallet_address TEXT,
                    module_address TEXT,
                    PRIMARY KEY (wallet_address, module_address)
                ) ON COMMIT DROP;
                TRUNCATE qv_affected_modules;

                INSERT INTO qv_affected_modules
                SELECT DISTINCT wallet_address, module_address
                FROM wallet_module_events
                WHERE event_block > p_block_number;

                DELETE FROM wallet_module_events WHERE event_block > p_block_number;
                GET DIAGNOSTICS removed_events = ROW_COUNT;

                DELETE FROM wallet_modules wm
                USING qv_affected_modules affected
                WHERE wm.wallet_address = affected.wallet_address
                  AND wm.module_address = affected.module_address;

                INSERT INTO wallet_modules (
                    wallet_address, module_address, enabled_at_block, enabled_at_tx,
                    disabled_at_block, disabled_at_tx, is_active,
                    last_event_block, last_event_block_hash, last_event_tx,
                    last_event_log_index, updated_at
                )
                WITH latest AS (
                    SELECT DISTINCT ON (events.wallet_address, events.module_address)
                        events.*
                    FROM wallet_module_events events
                    JOIN qv_affected_modules affected
                      ON affected.wallet_address = events.wallet_address
                     AND affected.module_address = events.module_address
                    ORDER BY events.wallet_address, events.module_address,
                             events.event_block DESC, events.log_index DESC
                ), latest_enable AS (
                    SELECT DISTINCT ON (events.wallet_address, events.module_address)
                        events.wallet_address, events.module_address,
                        events.event_block, events.event_tx
                    FROM wallet_module_events events
                    JOIN qv_affected_modules affected
                      ON affected.wallet_address = events.wallet_address
                     AND affected.module_address = events.module_address
                    WHERE events.event_type = ''enabled''
                    ORDER BY events.wallet_address, events.module_address,
                             events.event_block DESC, events.log_index DESC
                )
                SELECT
                    latest.wallet_address,
                    latest.module_address,
                    latest_enable.event_block,
                    latest_enable.event_tx,
                    CASE WHEN latest.event_type = ''disabled'' THEN latest.event_block END,
                    CASE WHEN latest.event_type = ''disabled'' THEN latest.event_tx END,
                    latest.event_type = ''enabled'',
                    latest.event_block,
                    latest.event_block_hash,
                    latest.event_tx,
                    latest.log_index,
                    NOW()
                FROM latest
                LEFT JOIN latest_enable
                  ON latest_enable.wallet_address = latest.wallet_address
                 AND latest_enable.module_address = latest.module_address;

                DROP TABLE qv_affected_modules;
                RETURN removed_events;
            END;
            $func$
        ', target_schema, target_schema);

        EXECUTE format('
            CREATE OR REPLACE FUNCTION %I.get_wallet_module_inventory(p_wallet_address TEXT)
            RETURNS JSONB
            LANGUAGE sql
            STABLE
            SECURITY INVOKER
            SET search_path = %I
            AS $func$
                SELECT jsonb_build_object(
                    ''wallet'', lower(p_wallet_address),
                    ''walletIndexed'', indexed_wallet.address IS NOT NULL,
                    ''walletCreatedAtBlock'', indexed_wallet.created_at_block,
                    ''indexedThroughBlock'', state.last_indexed_block,
                    ''lastIndexedAt'', state.last_indexed_at,
                    ''isSyncing'', state.is_syncing,
                    ''modules'', COALESCE(inventory.modules, ''[]''::jsonb)
                )
                FROM indexer_state state
                LEFT JOIN wallets indexed_wallet
                  ON indexed_wallet.address = lower(p_wallet_address)
                LEFT JOIN LATERAL (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            ''moduleAddress'', modules.module_address,
                            ''isActive'', modules.is_active,
                            ''enabledAtBlock'', modules.enabled_at_block,
                            ''enabledAtTx'', modules.enabled_at_tx,
                            ''disabledAtBlock'', modules.disabled_at_block,
                            ''disabledAtTx'', modules.disabled_at_tx,
                            ''lastEventBlock'', modules.last_event_block,
                            ''lastEventBlockHash'', modules.last_event_block_hash,
                            ''lastEventTx'', modules.last_event_tx,
                            ''lastEventLogIndex'', modules.last_event_log_index,
                            ''executionCount'', executions.execution_count,
                            ''successfulExecutionCount'', executions.success_count,
                            ''failedExecutionCount'', executions.failure_count,
                            ''lastExecutionBlock'', latest_execution.executed_at_block,
                            ''lastExecutionTx'', latest_execution.executed_at_tx,
                            ''lastExecutionLogIndex'', latest_execution.log_index
                        ) ORDER BY modules.is_active DESC, modules.module_address
                    ) AS modules
                    FROM wallet_modules modules
                    LEFT JOIN LATERAL (
                        SELECT
                            COUNT(*) AS execution_count,
                            COUNT(*) FILTER (WHERE success) AS success_count,
                            COUNT(*) FILTER (WHERE NOT success) AS failure_count
                        FROM module_executions
                        WHERE wallet_address = modules.wallet_address
                          AND module_address = modules.module_address
                    ) executions ON TRUE
                    LEFT JOIN LATERAL (
                        SELECT executed_at_block, executed_at_tx, log_index
                        FROM module_executions
                        WHERE wallet_address = modules.wallet_address
                          AND module_address = modules.module_address
                        ORDER BY executed_at_block DESC, log_index DESC NULLS LAST
                        LIMIT 1
                    ) latest_execution ON TRUE
                    WHERE modules.wallet_address = lower(p_wallet_address)
                ) inventory ON TRUE
                WHERE state.id = ''main'';
            $func$
        ', target_schema, target_schema);

        EXECUTE format('
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
                    RAISE EXCEPTION ''reset checkpoint must be >= -1'';
                END IF;
                PERFORM pg_advisory_xact_lock(hashtext(''quaivault_indexer_reset''));
                SELECT last_indexed_block, last_block_hash
                INTO current_block, current_hash
                FROM indexer_state
                WHERE id = ''main''
                FOR UPDATE;
                IF current_block IS DISTINCT FROM p_expected_indexed_block
                   OR lower(current_hash) IS DISTINCT FROM lower(p_expected_block_hash) THEN
                    RAISE EXCEPTION ''indexer checkpoint changed before reset'';
                END IF;
                -- Explicit predicates preserve full-reset semantics while remaining
                -- compatible with Supabase's safe-update guard.
                DELETE FROM wallets WHERE address IS NOT NULL;
                DELETE FROM tokens WHERE address IS NOT NULL;
                UPDATE indexer_state
                SET last_indexed_block = p_last_indexed_block,
                    last_block_hash = NULL,
                    last_indexed_at = NOW(),
                    is_syncing = TRUE,
                    updated_at = NOW()
                WHERE id = ''main'';
            END;
            $func$
        ', target_schema, target_schema);

        EXECUTE format('ALTER TABLE %I.wallet_module_events ENABLE ROW LEVEL SECURITY', target_schema);
        EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.wallet_module_events', target_schema);
        EXECUTE format('CREATE POLICY "Public read access" ON %I.wallet_module_events FOR SELECT USING (true)', target_schema);
        EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.wallet_module_events', target_schema);
        EXECUTE format('CREATE POLICY "Service write access" ON %I.wallet_module_events FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', target_schema);

        EXECUTE format('GRANT SELECT ON %I.wallet_module_events TO authenticated, anon', target_schema);
        EXECUTE format('GRANT ALL ON %I.wallet_module_events TO service_role', target_schema);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %I.get_wallet_module_inventory(TEXT) TO authenticated, anon, service_role', target_schema);

        EXECUTE format('REVOKE ALL ON FUNCTION %I.apply_wallet_module_event(TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, INTEGER) FROM PUBLIC, authenticated, anon', target_schema);
        EXECUTE format('REVOKE ALL ON FUNCTION %I.rollback_wallet_module_events_after(BIGINT) FROM PUBLIC, authenticated, anon', target_schema);
        EXECUTE format('REVOKE ALL ON FUNCTION %I.reset_indexed_data(BIGINT, BIGINT, TEXT) FROM PUBLIC, authenticated, anon', target_schema);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %I.apply_wallet_module_event(TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, INTEGER) TO service_role', target_schema);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %I.rollback_wallet_module_events_after(BIGINT) TO service_role', target_schema);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %I.reset_indexed_data(BIGINT, BIGINT, TEXT) TO service_role', target_schema);

        BEGIN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.wallet_module_events', target_schema);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;

        applied := applied + 1;
        RAISE NOTICE 'wallet module lifecycle installed in schema "%"', target_schema;
    END LOOP;

    IF applied = 0 THEN
        RAISE EXCEPTION 'no indexer schemas found — nothing was changed';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
