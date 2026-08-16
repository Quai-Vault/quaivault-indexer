\set ON_ERROR_STOP on

DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT current_user::text $$;
DO $$
BEGIN
  CREATE PUBLICATION supabase_realtime;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

\ir ../supabase/migrations/schema.sql
SELECT drop_quaivault_schema('qv_module_ci');
SELECT create_quaivault_schema('qv_module_ci');
\ir ../supabase/migrations/004_wallet_module_lifecycle.sql
\ir ../supabase/migrations/005_safe_rebuild_deletes.sql

INSERT INTO qv_module_ci.wallets(
  address, threshold, owner_count, created_at_block, created_at_tx
) VALUES (
  '0x00432fa4a3e6eb3ebcee26ad34a8d80118cb4cfd', 1, 1, 10,
  '0x58de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54'
);

DO $$
DECLARE
  wallet constant text := '0x00432fa4a3e6eb3ebcee26ad34a8d80118cb4cfd';
  module_a constant text := '0x004c0d1b601fdbddc1fe125cd39c19b8dbeaa8c0';
  module_b constant text := '0x0011111111111111111111111111111111111111';
  result text;
  projection record;
  inventory jsonb;
BEGIN
  result := qv_module_ci.apply_wallet_module_event(wallet, module_a, 'enabled', 10, NULL,
    '0x18de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54', 1);
  ASSERT result = 'applied';
  result := qv_module_ci.apply_wallet_module_event(wallet, module_a, 'disabled', 11, NULL,
    '0x28de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54', 2);
  ASSERT result = 'applied';
  result := qv_module_ci.apply_wallet_module_event(wallet, module_a, 'enabled', 12, NULL,
    '0x38de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54', 3);
  ASSERT result = 'applied';
  result := qv_module_ci.apply_wallet_module_event(wallet, module_a, 'enabled', 12, NULL,
    '0x38de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54', 3);
  ASSERT result = 'duplicate';

  BEGIN
    PERFORM qv_module_ci.apply_wallet_module_event(wallet, module_b, 'enabled', 12, NULL,
      '0x38de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54', 3);
    RAISE EXCEPTION 'expected replay identity collision';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'expected replay identity collision' THEN RAISE; END IF;
    ASSERT SQLERRM LIKE 'module event identity collision%';
  END;

  result := qv_module_ci.apply_wallet_module_event(wallet, module_b, 'disabled', 20, NULL,
    '0x48de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54', 4);
  ASSERT result = 'orphan_applied';
  result := qv_module_ci.apply_wallet_module_event(wallet, module_b, 'enabled', 19, NULL,
    '0x68de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54', 5);
  ASSERT result = 'out_of_order';

  SELECT * INTO projection FROM qv_module_ci.wallet_modules WHERE module_address = module_b;
  ASSERT projection.is_active = false;
  ASSERT projection.enabled_at_block = 19;
  ASSERT projection.disabled_at_block = 20;

  inventory := qv_module_ci.get_wallet_module_inventory(wallet);
  ASSERT (inventory->>'walletIndexed')::boolean;
  ASSERT jsonb_array_length(inventory->'modules') = 2;
  inventory := qv_module_ci.get_wallet_module_inventory('0x0099999999999999999999999999999999999999');
  ASSERT NOT (inventory->>'walletIndexed')::boolean;

  ASSERT qv_module_ci.rollback_wallet_module_events_after(11) = 3;
  SELECT * INTO projection FROM qv_module_ci.wallet_modules WHERE module_address = module_a;
  ASSERT projection.is_active = false;
  ASSERT projection.last_event_block = 11;

  ASSERT NOT has_function_privilege('anon',
    'qv_module_ci.apply_wallet_module_event(text,text,text,bigint,text,text,integer)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon',
    'qv_module_ci.reset_indexed_data(bigint,bigint,text)', 'EXECUTE');
  ASSERT has_function_privilege('service_role',
    'qv_module_ci.apply_wallet_module_event(text,text,text,bigint,text,text,integer)', 'EXECUTE');
END $$;

SELECT qv_module_ci.reset_indexed_data(9, 0, NULL);
DO $$ BEGIN ASSERT NOT EXISTS (SELECT 1 FROM qv_module_ci.wallets); END $$;
