-- ============================================
-- Quai Multisig Indexer - Database Schema
-- ============================================
--
-- This file provides functions to create and manage network-specific schemas.
-- Each network (testnet, mainnet) gets its own isolated schema.
--
-- USAGE:
--   1. Run this entire file in Supabase SQL Editor (creates the functions)
--   2. Create your network schema(s):
--      SELECT create_network_schema('testnet');
--      SELECT create_network_schema('mainnet');
--
-- RESET A SCHEMA (WARNING: Deletes all data):
--   SELECT drop_network_schema('testnet');
--   SELECT create_network_schema('testnet');
--
-- ============================================

-- Note: We use gen_random_uuid() which is built into PostgreSQL 13+
-- No extensions required for UUID generation

-- ============================================
-- ENUM TYPES (Shared across all schemas)
-- ============================================
-- Create ENUMs in public schema if they don't exist

DO $$
BEGIN
    -- Transaction status enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_status') THEN
        CREATE TYPE public.transaction_status AS ENUM ('pending', 'executed', 'cancelled');
    END IF;

    -- Transaction type enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_type') THEN
        CREATE TYPE public.transaction_type AS ENUM (
            'transfer',
            'module_config',
            'wallet_admin',
            'recovery_setup',
            'external_call',
            'unknown'
        );
    END IF;

    -- Recovery status enum (same values as transaction_status but separate type for clarity)
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recovery_status') THEN
        CREATE TYPE public.recovery_status AS ENUM ('pending', 'executed', 'cancelled');
    END IF;

    -- Module type enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'module_type') THEN
        CREATE TYPE public.module_type AS ENUM ('daily_limit', 'whitelist', 'social_recovery');
    END IF;
END
$$;

-- ============================================
-- SCHEMA MANAGEMENT FUNCTIONS
-- ============================================

-- Drop a network schema and all its data
-- WARNING: This is destructive and cannot be undone!
CREATE OR REPLACE FUNCTION drop_network_schema(network_name TEXT)
RETURNS void AS $$
BEGIN
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', network_name);
    RAISE NOTICE 'Schema "%" dropped', network_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- MAIN SCHEMA CREATION FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION create_network_schema(network_name TEXT)
RETURNS void AS $$
DECLARE
    schema_name TEXT := network_name;
BEGIN
    -- Create the schema
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', schema_name);

    -- ============================================
    -- CORE TABLES
    -- ============================================

    -- Indexed wallets
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.wallets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            address TEXT UNIQUE NOT NULL,
            name TEXT,
            threshold INTEGER NOT NULL,
            owner_count INTEGER NOT NULL,
            created_at_block BIGINT NOT NULL,
            created_at_tx TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )', schema_name);

    -- Wallet owners
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.wallet_owners (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            owner_address TEXT NOT NULL,
            added_at_block BIGINT NOT NULL,
            added_at_tx TEXT NOT NULL,
            removed_at_block BIGINT,
            removed_at_tx TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, owner_address, added_at_block)
        )', schema_name, schema_name);

    -- Transactions
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.transactions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            tx_hash TEXT NOT NULL,
            to_address TEXT NOT NULL,
            value TEXT NOT NULL,
            data TEXT,
            transaction_type public.transaction_type NOT NULL DEFAULT ''unknown'',
            decoded_params JSONB,
            status public.transaction_status NOT NULL DEFAULT ''pending'',
            confirmation_count INTEGER DEFAULT 0,
            submitted_by TEXT NOT NULL,
            submitted_at_block BIGINT NOT NULL,
            submitted_at_tx TEXT NOT NULL,
            executed_at_block BIGINT,
            executed_at_tx TEXT,
            cancelled_at_block BIGINT,
            cancelled_at_tx TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, tx_hash)
        )', schema_name, schema_name);

    -- Confirmations
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.confirmations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL,
            tx_hash TEXT NOT NULL,
            owner_address TEXT NOT NULL,
            confirmed_at_block BIGINT NOT NULL,
            confirmed_at_tx TEXT NOT NULL,
            revoked_at_block BIGINT,
            revoked_at_tx TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            FOREIGN KEY (wallet_address, tx_hash)
                REFERENCES %I.transactions(wallet_address, tx_hash) ON DELETE CASCADE,
            UNIQUE(wallet_address, tx_hash, owner_address, confirmed_at_block)
        )', schema_name, schema_name);

    -- Wallet modules
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.wallet_modules (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            module_address TEXT NOT NULL,
            enabled_at_block BIGINT NOT NULL,
            enabled_at_tx TEXT NOT NULL,
            disabled_at_block BIGINT,
            disabled_at_tx TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, module_address)
        )', schema_name, schema_name);

    -- Deposits
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.deposits (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            sender_address TEXT NOT NULL,
            amount TEXT NOT NULL,
            deposited_at_block BIGINT NOT NULL,
            deposited_at_tx TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, deposited_at_tx)
        )', schema_name, schema_name);

    -- Indexer state
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.indexer_state (
            id TEXT PRIMARY KEY DEFAULT ''main'',
            last_indexed_block BIGINT NOT NULL DEFAULT 0,
            last_indexed_at TIMESTAMPTZ,
            is_syncing BOOLEAN DEFAULT FALSE,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )', schema_name);

    -- Initialize indexer state
    EXECUTE format('
        INSERT INTO %I.indexer_state (id, last_indexed_block)
        VALUES (''main'', 0)
        ON CONFLICT (id) DO NOTHING
    ', schema_name);

    -- ============================================
    -- MODULE TABLES
    -- ============================================

    -- Daily limit state
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.daily_limit_state (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            daily_limit TEXT NOT NULL,
            spent_today TEXT DEFAULT ''0'',
            last_reset_day DATE NOT NULL DEFAULT CURRENT_DATE,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address)
        )', schema_name, schema_name);

    -- Whitelist entries
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.whitelist_entries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            whitelisted_address TEXT NOT NULL,
            limit_amount TEXT,
            added_at_block BIGINT NOT NULL,
            added_at_tx TEXT,
            removed_at_block BIGINT,
            removed_at_tx TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, whitelisted_address, added_at_block)
        )', schema_name, schema_name);

    -- Module transactions
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.module_transactions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            module_type public.module_type NOT NULL,
            module_address TEXT NOT NULL,
            to_address TEXT NOT NULL,
            value TEXT NOT NULL,
            remaining_limit TEXT,
            executed_at_block BIGINT NOT NULL,
            executed_at_tx TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )', schema_name, schema_name);

    -- ============================================
    -- SOCIAL RECOVERY MODULE TABLES
    -- ============================================

    -- Recovery configs
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.social_recovery_configs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            threshold INTEGER NOT NULL,
            recovery_period BIGINT NOT NULL,
            setup_at_block BIGINT NOT NULL,
            setup_at_tx TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address)
        )', schema_name, schema_name);

    -- Guardians
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.social_recovery_guardians (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            guardian_address TEXT NOT NULL,
            added_at_block BIGINT NOT NULL,
            added_at_tx TEXT NOT NULL,
            removed_at_block BIGINT,
            removed_at_tx TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, guardian_address, added_at_block)
        )', schema_name, schema_name);

    -- Recoveries
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.social_recoveries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            recovery_hash TEXT NOT NULL,
            new_owners TEXT[] NOT NULL,
            new_threshold INTEGER NOT NULL,
            initiator_address TEXT NOT NULL,
            approval_count INTEGER DEFAULT 0,
            required_threshold INTEGER NOT NULL,
            execution_time BIGINT NOT NULL,
            status public.recovery_status NOT NULL DEFAULT ''pending'',
            initiated_at_block BIGINT NOT NULL,
            initiated_at_tx TEXT NOT NULL,
            executed_at_block BIGINT,
            executed_at_tx TEXT,
            cancelled_at_block BIGINT,
            cancelled_at_tx TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, recovery_hash)
        )', schema_name, schema_name);

    -- Recovery approvals
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.social_recovery_approvals (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL,
            recovery_hash TEXT NOT NULL,
            guardian_address TEXT NOT NULL,
            approved_at_block BIGINT NOT NULL,
            approved_at_tx TEXT NOT NULL,
            revoked_at_block BIGINT,
            revoked_at_tx TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            FOREIGN KEY (wallet_address, recovery_hash)
                REFERENCES %I.social_recoveries(wallet_address, recovery_hash) ON DELETE CASCADE,
            UNIQUE(wallet_address, recovery_hash, guardian_address, approved_at_block)
        )', schema_name, schema_name);

    -- ============================================
    -- INDEXES
    -- ============================================

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_wallet_owners_wallet ON %I.wallet_owners(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_wallet_owners_active ON %I.wallet_owners(wallet_address) WHERE is_active = TRUE', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON %I.transactions(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_transactions_wallet_txhash ON %I.transactions(wallet_address, tx_hash)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_transactions_status ON %I.transactions(wallet_address, status)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_transactions_pending ON %I.transactions(wallet_address) WHERE status = ''pending''', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_confirmations_wallet_txhash ON %I.confirmations(wallet_address, tx_hash)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_confirmations_active ON %I.confirmations(wallet_address, tx_hash) WHERE is_active = TRUE', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_wallet_modules_active ON %I.wallet_modules(wallet_address) WHERE is_active = TRUE', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_deposits_wallet ON %I.deposits(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_module_transactions_wallet ON %I.module_transactions(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recovery_configs_wallet ON %I.social_recovery_configs(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recovery_guardians_wallet ON %I.social_recovery_guardians(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recoveries_wallet ON %I.social_recoveries(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recoveries_pending ON %I.social_recoveries(wallet_address) WHERE status = ''pending''', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recovery_approvals_recovery ON %I.social_recovery_approvals(wallet_address, recovery_hash)', schema_name);

    -- ============================================
    -- FUNCTIONS & TRIGGERS
    -- ============================================

    -- Shared updated_at function (in public schema)
    CREATE OR REPLACE FUNCTION public.update_updated_at()
    RETURNS TRIGGER AS $func$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;

    -- Confirmation count trigger function (schema-specific)
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.update_confirmation_count()
        RETURNS TRIGGER AS $func$
        BEGIN
            UPDATE %I.transactions SET
                confirmation_count = (
                    SELECT COUNT(*) FROM %I.confirmations
                    WHERE wallet_address = NEW.wallet_address
                    AND tx_hash = NEW.tx_hash
                    AND is_active = TRUE
                ),
                updated_at = NOW()
            WHERE wallet_address = NEW.wallet_address
            AND tx_hash = NEW.tx_hash;
            RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql
    ', schema_name, schema_name, schema_name);

    -- Recovery approval count trigger function (schema-specific)
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.update_recovery_approval_count()
        RETURNS TRIGGER AS $func$
        BEGIN
            UPDATE %I.social_recoveries
            SET
                approval_count = (
                    SELECT COUNT(*) FROM %I.social_recovery_approvals
                    WHERE wallet_address = NEW.wallet_address
                    AND recovery_hash = NEW.recovery_hash
                    AND is_active = TRUE
                ),
                updated_at = NOW()
            WHERE wallet_address = NEW.wallet_address
            AND recovery_hash = NEW.recovery_hash;
            RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql
    ', schema_name, schema_name, schema_name);

    -- Owner count increment function (schema-specific)
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.increment_owner_count(
            wallet_addr TEXT,
            delta_value INTEGER
        )
        RETURNS void AS $func$
        BEGIN
            UPDATE %I.wallets
            SET owner_count = owner_count + delta_value,
                updated_at = NOW()
            WHERE address = wallet_addr;
        END;
        $func$ LANGUAGE plpgsql
    ', schema_name, schema_name);

    -- Create triggers
    EXECUTE format('DROP TRIGGER IF EXISTS trigger_update_confirmation_count ON %I.confirmations', schema_name);
    EXECUTE format('CREATE TRIGGER trigger_update_confirmation_count AFTER INSERT OR UPDATE ON %I.confirmations FOR EACH ROW EXECUTE FUNCTION %I.update_confirmation_count()', schema_name, schema_name);

    EXECUTE format('DROP TRIGGER IF EXISTS trigger_wallets_updated_at ON %I.wallets', schema_name);
    EXECUTE format('CREATE TRIGGER trigger_wallets_updated_at BEFORE UPDATE ON %I.wallets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', schema_name);

    EXECUTE format('DROP TRIGGER IF EXISTS trigger_transactions_updated_at ON %I.transactions', schema_name);
    EXECUTE format('CREATE TRIGGER trigger_transactions_updated_at BEFORE UPDATE ON %I.transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', schema_name);

    EXECUTE format('DROP TRIGGER IF EXISTS trigger_update_recovery_approval_count ON %I.social_recovery_approvals', schema_name);
    EXECUTE format('CREATE TRIGGER trigger_update_recovery_approval_count AFTER INSERT OR UPDATE ON %I.social_recovery_approvals FOR EACH ROW EXECUTE FUNCTION %I.update_recovery_approval_count()', schema_name, schema_name);

    EXECUTE format('DROP TRIGGER IF EXISTS trigger_social_recoveries_updated_at ON %I.social_recoveries', schema_name);
    EXECUTE format('CREATE TRIGGER trigger_social_recoveries_updated_at BEFORE UPDATE ON %I.social_recoveries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', schema_name);

    -- ============================================
    -- ROW LEVEL SECURITY
    -- ============================================

    -- Enable RLS
    EXECUTE format('ALTER TABLE %I.wallets ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.wallet_owners ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.transactions ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.confirmations ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.wallet_modules ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.deposits ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.daily_limit_state ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.whitelist_entries ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.module_transactions ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.social_recovery_configs ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.social_recovery_guardians ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.social_recoveries ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.social_recovery_approvals ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.indexer_state ENABLE ROW LEVEL SECURITY', schema_name);

    -- Public read policies
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.wallets', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.wallets FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.wallet_owners', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.wallet_owners FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.transactions', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.transactions FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.confirmations', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.confirmations FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.wallet_modules', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.wallet_modules FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.deposits', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.deposits FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.daily_limit_state', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.daily_limit_state FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.whitelist_entries', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.whitelist_entries FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.module_transactions', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.module_transactions FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.social_recovery_configs', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.social_recovery_configs FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.social_recovery_guardians', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.social_recovery_guardians FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.social_recoveries', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.social_recoveries FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.social_recovery_approvals', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.social_recovery_approvals FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.indexer_state', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.indexer_state FOR SELECT USING (true)', schema_name);

    -- Service role write policies
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.wallets', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.wallets FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.wallet_owners', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.wallet_owners FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.transactions', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.transactions FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.confirmations', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.confirmations FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.wallet_modules', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.wallet_modules FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.deposits', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.deposits FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.daily_limit_state', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.daily_limit_state FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.whitelist_entries', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.whitelist_entries FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.module_transactions', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.module_transactions FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.social_recovery_configs', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.social_recovery_configs FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.social_recovery_guardians', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.social_recovery_guardians FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.social_recoveries', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.social_recoveries FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.social_recovery_approvals', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.social_recovery_approvals FOR ALL USING (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.indexer_state', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.indexer_state FOR ALL USING (auth.role() = ''service_role'')', schema_name);

    -- ============================================
    -- GRANT PERMISSIONS
    -- ============================================

    -- Service role: full access for indexer operations
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role', schema_name);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO service_role', schema_name);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO service_role', schema_name);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO service_role', schema_name);

    -- Authenticated and anon roles: read-only access for frontend
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated, anon', schema_name);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO authenticated, anon', schema_name);

    -- ============================================
    -- REALTIME PUBLICATION
    -- ============================================
    -- Enable Supabase Realtime for frontend subscriptions
    -- Note: These may fail if tables are already in publication (safe to ignore)

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.wallets', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.wallet_owners', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.transactions', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.confirmations', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.deposits', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.wallet_modules', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.social_recoveries', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.social_recovery_approvals', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.daily_limit_state', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.whitelist_entries', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.social_recovery_configs', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.social_recovery_guardians', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    RAISE NOTICE 'Schema "%" created successfully with all tables, indexes, triggers, policies, permissions, and realtime', schema_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- USAGE EXAMPLES
-- ============================================
--
-- STEP 1: Run this entire file to create the functions
--
-- STEP 2: Create network schemas
--   SELECT create_network_schema('testnet');
--   SELECT create_network_schema('mainnet');
--
-- STEP 3: IMPORTANT - Expose schemas to Supabase API
--   By default, Supabase only exposes 'public'. You must expose custom schemas:
--
--   ALTER ROLE authenticator SET pgrst.db_schemas TO 'public, graphql_public, testnet, mainnet';
--   NOTIFY pgrst, 'reload config';
--
--   Or go to: Project Settings → API → Exposed Schemas → add 'testnet, mainnet'
--
-- RESET A SCHEMA (deletes all data, then recreates):
--   SELECT drop_network_schema('testnet');
--   SELECT create_network_schema('testnet');
--
-- LIST ALL SCHEMAS:
--   SELECT schema_name FROM information_schema.schemata
--   WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'pg_toast', 'extensions', 'storage', 'auth', 'graphql', 'graphql_public', 'realtime', 'supabase_migrations', 'supabase_functions', 'vault', 'pgsodium', 'pgsodium_masks');
--
-- VIEW TABLES IN A SCHEMA:
--   SELECT table_name FROM information_schema.tables WHERE table_schema = 'testnet';
--
-- COMPARE WALLET COUNTS ACROSS NETWORKS:
--   SELECT 'testnet' as network, COUNT(*) FROM testnet.wallets
--   UNION ALL
--   SELECT 'mainnet' as network, COUNT(*) FROM mainnet.wallets;
