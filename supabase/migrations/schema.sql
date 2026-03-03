-- ============================================
-- QuaiVault Indexer - Database Schema
-- ============================================
--
-- Complete schema with Zodiac IAvatar support for module execution tracking.
-- This file creates all required types, tables, indexes, triggers,
-- RLS policies, permissions, and realtime subscriptions.
--
-- USAGE:
--   1. Run this entire file in Supabase SQL Editor
--   2. Create your schema: SELECT create_quaivault_schema('testnet');
--   3. Expose schema to API (see bottom of file)
--
-- ============================================

-- ============================================
-- BASE ENUM TYPES (created in public schema)
-- ============================================
-- These must exist before tables can reference them

DO $$
BEGIN
    -- Transaction status enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_status') THEN
        CREATE TYPE public.transaction_status AS ENUM ('pending', 'executed', 'cancelled', 'expired', 'failed');
    END IF;
END
$$;

DO $$
BEGIN
    -- Recovery status enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recovery_status') THEN
        CREATE TYPE public.recovery_status AS ENUM ('pending', 'executed', 'cancelled');
    END IF;
END
$$;

DO $$
BEGIN
    -- Module type enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'module_type') THEN
        CREATE TYPE public.module_type AS ENUM ('daily_limit', 'whitelist', 'social_recovery');
    END IF;
END
$$;

DO $$
BEGIN
    -- Transaction type enum (includes Zodiac types)
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_type') THEN
        CREATE TYPE public.transaction_type AS ENUM (
            'transfer',
            'module_config',
            'wallet_admin',
            'recovery_setup',
            'external_call',
            'unknown',
            'module_execution',
            'batched_call',
            'erc20_transfer',
            'erc721_transfer',
            'erc1155_transfer',
            'message_signing'
        );
    END IF;
END
$$;

-- ============================================
-- ADD ZODIAC ENUM VALUES (if enum already exists)
-- ============================================
-- Add new transaction types for Zodiac module execution tracking

DO $$
BEGIN
    -- Add 'module_execution' to transaction_type enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'module_execution'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_type')
    ) THEN
        ALTER TYPE public.transaction_type ADD VALUE 'module_execution';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Add 'batched_call' to transaction_type enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'batched_call'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_type')
    ) THEN
        ALTER TYPE public.transaction_type ADD VALUE 'batched_call';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Add 'erc20_transfer' to transaction_type enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'erc20_transfer'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_type')
    ) THEN
        ALTER TYPE public.transaction_type ADD VALUE 'erc20_transfer';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Add 'erc721_transfer' to transaction_type enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'erc721_transfer'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_type')
    ) THEN
        ALTER TYPE public.transaction_type ADD VALUE 'erc721_transfer';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Add 'message_signing' to transaction_type enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'message_signing'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_type')
    ) THEN
        ALTER TYPE public.transaction_type ADD VALUE 'message_signing';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Add 'erc1155_transfer' to transaction_type enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'erc1155_transfer'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_type')
    ) THEN
        ALTER TYPE public.transaction_type ADD VALUE 'erc1155_transfer';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Add 'expired' to transaction_status enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'expired'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_status')
    ) THEN
        ALTER TYPE public.transaction_status ADD VALUE 'expired';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Add 'failed' to transaction_status enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'failed'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_status')
    ) THEN
        ALTER TYPE public.transaction_status ADD VALUE 'failed';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Token standard enum (ERC20, ERC721, ERC1155)
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'token_standard') THEN
        CREATE TYPE public.token_standard AS ENUM ('ERC20', 'ERC721', 'ERC1155');
    END IF;
END
$$;

DO $$
BEGIN
    -- Add 'ERC1155' to token_standard enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'ERC1155'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'token_standard')
    ) THEN
        ALTER TYPE public.token_standard ADD VALUE 'ERC1155';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Transfer direction enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transfer_direction') THEN
        CREATE TYPE public.transfer_direction AS ENUM ('inflow', 'outflow');
    END IF;
END
$$;

-- ============================================
-- DROP NETWORK SCHEMA FUNCTION
-- ============================================
-- Use this to completely remove a schema and all its data

CREATE OR REPLACE FUNCTION drop_quaivault_schema(network_name TEXT)
RETURNS void AS $$
DECLARE
    schema_name TEXT := network_name;
BEGIN
    -- Drop only QuaiVault indexer tables (not the entire schema).
    -- Other projects (e.g. qdl-indexer) may share the same schema.
    -- Order: children before parents (FK dependencies).
    EXECUTE format('DROP TABLE IF EXISTS %I.token_transfers CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.tokens CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.social_recovery_approvals CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.social_recoveries CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.social_recovery_guardians CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.social_recovery_configs CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.signed_messages CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.module_executions CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.deposits CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.wallet_modules CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.confirmations CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.transactions CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.wallet_owners CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.wallets CASCADE', schema_name);
    EXECUTE format('DROP TABLE IF EXISTS %I.indexer_state CASCADE', schema_name);

    RAISE NOTICE 'QuaiVault indexer tables dropped from schema "%"', schema_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- MAIN SCHEMA CREATION FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION create_quaivault_schema(network_name TEXT)
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
            min_execution_delay INTEGER DEFAULT 0,
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

    -- Transactions (with executed_by column for tracking executor)
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
            executed_by TEXT,
            cancelled_at_block BIGINT,
            cancelled_at_tx TEXT,
            expiration BIGINT DEFAULT 0,
            execution_delay INTEGER DEFAULT 0,
            approved_at BIGINT,
            executable_after BIGINT,
            is_expired BOOLEAN DEFAULT FALSE,
            failed_return_data TEXT,
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
            last_block_hash TEXT,
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
    -- ZODIAC MODULE EXECUTIONS TABLE
    -- ============================================
    -- Tracks ExecutionFromModuleSuccess and ExecutionFromModuleFailure events

    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.module_executions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            module_address TEXT NOT NULL,
            success BOOLEAN NOT NULL,
            operation_type SMALLINT,
            to_address TEXT,
            value TEXT,
            data_hash TEXT,
            executed_at_block BIGINT NOT NULL,
            executed_at_tx TEXT NOT NULL,
            log_index INTEGER,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, module_address, executed_at_tx, log_index)
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
    -- TOKEN TRACKING TABLES
    -- ============================================

    -- Token registry (ERC20/ERC721 contracts tracked by the indexer)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            address TEXT UNIQUE NOT NULL,
            standard public.token_standard NOT NULL,
            symbol TEXT NOT NULL,
            name TEXT NOT NULL,
            decimals INTEGER NOT NULL,
            discovered_at_block BIGINT,
            discovered_via TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )', schema_name);

    -- Token transfer events (ERC20/ERC721/ERC1155 transfers involving tracked vaults)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.token_transfers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            token_address TEXT NOT NULL REFERENCES %I.tokens(address),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            from_address TEXT NOT NULL,
            to_address TEXT NOT NULL,
            value TEXT NOT NULL,
            token_id TEXT,
            batch_index INTEGER NOT NULL DEFAULT 0,
            direction public.transfer_direction NOT NULL,
            block_number BIGINT NOT NULL,
            transaction_hash TEXT NOT NULL,
            log_index INTEGER NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(transaction_hash, log_index, batch_index, wallet_address)
        )', schema_name, schema_name, schema_name);

    -- ============================================
    -- EIP-1271 SIGNED MESSAGES TABLE
    -- ============================================

    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.signed_messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address TEXT NOT NULL REFERENCES %I.wallets(address) ON DELETE CASCADE,
            msg_hash TEXT NOT NULL,
            data TEXT,
            signed_at_block BIGINT NOT NULL,
            signed_at_tx TEXT NOT NULL,
            unsigned_at_block BIGINT,
            unsigned_at_tx TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(wallet_address, msg_hash)
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
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recovery_configs_wallet ON %I.social_recovery_configs(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recovery_guardians_wallet ON %I.social_recovery_guardians(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recoveries_wallet ON %I.social_recoveries(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recoveries_pending ON %I.social_recoveries(wallet_address) WHERE status = ''pending''', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_social_recovery_approvals_recovery ON %I.social_recovery_approvals(wallet_address, recovery_hash)', schema_name);

    -- Zodiac module_executions indexes
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_module_executions_wallet ON %I.module_executions(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_module_executions_module ON %I.module_executions(module_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_module_executions_success ON %I.module_executions(wallet_address, success)', schema_name);

    -- Token tracking indexes
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_token_transfers_wallet ON %I.token_transfers(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_token_transfers_token ON %I.token_transfers(token_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_token_transfers_wallet_token ON %I.token_transfers(wallet_address, token_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_token_transfers_block ON %I.token_transfers(block_number)', schema_name);

    -- Signed messages indexes
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_signed_messages_wallet ON %I.signed_messages(wallet_address)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_signed_messages_active ON %I.signed_messages(wallet_address) WHERE is_active = TRUE', schema_name);

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

    -- Distinct token addresses for a wallet (for frontend token discovery at scale)
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.get_wallet_token_addresses(p_wallet_address text)
        RETURNS TABLE(token_address text)
        LANGUAGE sql
        STABLE
        SECURITY INVOKER
        SET search_path = %I
        AS $func$
            SELECT DISTINCT token_address
            FROM token_transfers
            WHERE wallet_address = lower(p_wallet_address);
        $func$
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

    EXECUTE format('DROP TRIGGER IF EXISTS trigger_signed_messages_updated_at ON %I.signed_messages', schema_name);
    EXECUTE format('CREATE TRIGGER trigger_signed_messages_updated_at BEFORE UPDATE ON %I.signed_messages FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', schema_name);

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
    EXECUTE format('ALTER TABLE %I.module_executions ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.social_recovery_configs ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.social_recovery_guardians ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.social_recoveries ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.social_recovery_approvals ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.indexer_state ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.tokens ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.token_transfers ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('ALTER TABLE %I.signed_messages ENABLE ROW LEVEL SECURITY', schema_name);

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
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.module_executions', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.module_executions FOR SELECT USING (true)', schema_name);
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
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.tokens', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.tokens FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.token_transfers', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.token_transfers FOR SELECT USING (true)', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I.signed_messages', schema_name);
    EXECUTE format('CREATE POLICY "Public read access" ON %I.signed_messages FOR SELECT USING (true)', schema_name);

    -- Service role write policies (with WITH CHECK for INSERT/UPDATE)
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.wallets', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.wallets FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.wallet_owners', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.wallet_owners FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.transactions', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.transactions FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.confirmations', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.confirmations FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.wallet_modules', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.wallet_modules FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.deposits', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.deposits FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.module_executions', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.module_executions FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.social_recovery_configs', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.social_recovery_configs FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.social_recovery_guardians', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.social_recovery_guardians FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.social_recoveries', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.social_recoveries FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.social_recovery_approvals', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.social_recovery_approvals FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.indexer_state', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.indexer_state FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.tokens', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.tokens FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.token_transfers', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.token_transfers FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "Service write access" ON %I.signed_messages', schema_name);
    EXECUTE format('CREATE POLICY "Service write access" ON %I.signed_messages FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')', schema_name);

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
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO authenticated, anon', schema_name);

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
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.module_executions', schema_name);
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
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.social_recovery_configs', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.social_recovery_guardians', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.indexer_state', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.tokens', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.token_transfers', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.signed_messages', schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    -- Reload PostgREST schema cache so new/changed columns are immediately visible
    NOTIFY pgrst, 'reload config';

    RAISE NOTICE 'Schema "%" created successfully with all tables, indexes, triggers, policies, permissions, and realtime', schema_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- USAGE EXAMPLES
-- ============================================
--
-- STEP 1: Run this entire file in Supabase SQL Editor
--   (This creates the enum types and helper functions)
--
-- STEP 2: Create your network schema
--   SELECT create_quaivault_schema('testnet');  -- For testnet
--   SELECT create_quaivault_schema('mainnet');  -- For mainnet
--
-- STEP 3: CRITICAL - Expose schema to PostgREST API
--   ALTER ROLE authenticator SET pgrst.db_schemas TO 'public, graphql_public, testnet, mainnet';
--   NOTIFY pgrst, 'reload config';
--
-- STEP 4: Verify schema is exposed (should show your schemas)
--   SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'authenticator';
--
-- STEP 5: Verify tables were created
--   SELECT table_name FROM information_schema.tables WHERE table_schema = 'testnet' ORDER BY table_name;
--
-- RESET A SCHEMA (WARNING: deletes all data!):
--   SELECT drop_quaivault_schema('testnet');
--   SELECT create_quaivault_schema('testnet');
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
--
-- TROUBLESHOOTING:
--   If you get PGRST205 errors, the schema isn't exposed. Run:
--     ALTER ROLE authenticator SET pgrst.db_schemas TO 'public, graphql_public, testnet, mainnet';
--     NOTIFY pgrst, 'reload config';
--   Then wait 10-15 seconds for PostgREST to reload.
--
