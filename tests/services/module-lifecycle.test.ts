import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RpcCall {
  name: string;
  params: Record<string, unknown>;
}

interface QueryCall {
  table: string;
  filters: Array<[string, unknown]>;
  limit?: number;
}

const rpcCalls: RpcCall[] = [];
const queryCalls: QueryCall[] = [];
const rpcResults = new Map<string, { data: unknown; error: null }>();
const tableResults = new Map<string, unknown[]>();

function queryBuilder(table: string) {
  const call: QueryCall = { table, filters: [] };
  queryCalls.push(call);
  const chain = {
    select() { return chain; },
    eq(column: string, value: unknown) {
      call.filters.push([column, value]);
      return chain;
    },
    order() { return chain; },
    limit(value: number) {
      call.limit = value;
      return chain;
    },
    then(resolve: (result: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve({ data: tableResults.get(table) ?? [], error: null }).then(resolve);
    },
  };
  return chain;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      return Promise.resolve(rpcResults.get(name) ?? { data: null, error: null });
    },
    from: (table: string) => queryBuilder(table),
  }),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    supabase: { url: 'http://localhost', serviceKey: 'test-key', schema: 'test' },
    retry: { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0, errorThreshold: 3 },
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { supabase } from '../../src/services/supabase.js';

const WALLET = '0x00432fa4a3e6eb3ebcee26ad34a8d80118cb4cfd';
const MODULE = '0x004c0d1b601fdbddc1fe125cd39c19b8dbeaa8c0';
const TX = '0x58de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54';
const BLOCK_HASH = '0xa8de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54';

describe('module lifecycle service contract', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    queryCalls.length = 0;
    rpcResults.clear();
    tableResults.clear();
  });

  it('passes normalized lifecycle provenance to the atomic RPC', async () => {
    rpcResults.set('apply_wallet_module_event', { data: 'orphan_applied', error: null });

    const result = await supabase.applyModuleEvent({
      walletAddress: WALLET.toUpperCase().replace('0X', '0x'),
      moduleAddress: MODULE.toUpperCase().replace('0X', '0x'),
      eventType: 'disabled',
      eventBlock: 42,
      eventBlockHash: BLOCK_HASH.toUpperCase().replace('0X', '0x'),
      eventTx: TX.toUpperCase().replace('0X', '0x'),
      logIndex: 7,
    });

    expect(result).toBe('orphan_applied');
    expect(rpcCalls).toEqual([{
      name: 'apply_wallet_module_event',
      params: {
        p_wallet: WALLET,
        p_module: MODULE,
        p_event_type: 'disabled',
        p_event_block: 42,
        p_event_block_hash: BLOCK_HASH,
        p_event_tx: TX,
        p_log_index: 7,
      },
    }]);
  });

  it('returns the inventory envelope without reshaping away freshness', async () => {
    const envelope = {
      wallet: WALLET,
      walletIndexed: true,
      walletCreatedAtBlock: 10,
      indexedThroughBlock: 99,
      lastIndexedAt: null,
      isSyncing: true,
      modules: [],
    };
    rpcResults.set('get_wallet_module_inventory', { data: envelope, error: null });

    await expect(supabase.getWalletModuleInventory(WALLET)).resolves.toEqual(envelope);
    expect(rpcCalls[0]).toEqual({
      name: 'get_wallet_module_inventory',
      params: { p_wallet_address: WALLET },
    });
  });

  it('filters current active modules and execution failures precisely', async () => {
    tableResults.set('wallet_modules', [{ module_address: MODULE }]);
    tableResults.set('module_executions', [{
      wallet_address: WALLET,
      module_address: MODULE,
      success: false,
      executed_at_block: 88,
      executed_at_tx: TX,
      log_index: 12,
    }]);

    await expect(supabase.getActiveModuleAddresses(WALLET)).resolves.toEqual([MODULE]);
    await expect(supabase.getModuleExecutions(WALLET, {
      moduleAddress: MODULE,
      success: false,
      limit: 5,
    })).resolves.toEqual([{
      walletAddress: WALLET,
      moduleAddress: MODULE,
      success: false,
      operationType: undefined,
      toAddress: undefined,
      value: undefined,
      dataHash: undefined,
      executedAtBlock: 88,
      executedAtTx: TX,
      logIndex: 12,
    }]);

    expect(queryCalls[0].filters).toEqual([
      ['wallet_address', WALLET],
      ['is_active', true],
    ]);
    expect(queryCalls[1].filters).toEqual([
      ['wallet_address', WALLET],
      ['module_address', MODULE],
      ['success', false],
    ]);
    expect(queryCalls[1].limit).toBe(5);
  });

  it('uses service-only maintenance RPCs with explicit boundaries', async () => {
    rpcResults.set('rollback_wallet_module_events_after', { data: 3, error: null });
    rpcResults.set('reset_indexed_data', { data: null, error: null });

    await expect(supabase.rollbackModuleEventsAfterBlock(50)).resolves.toBe(3);
    await supabase.resetIndexedData(10, { lastIndexedBlock: 50, lastBlockHash: BLOCK_HASH });

    expect(rpcCalls).toEqual([
      { name: 'rollback_wallet_module_events_after', params: { p_block_number: 50 } },
      {
        name: 'reset_indexed_data',
        params: {
          p_last_indexed_block: 9,
          p_expected_indexed_block: 50,
          p_expected_block_hash: BLOCK_HASH,
        },
      },
    ]);
  });

  it('rejects unbounded execution query limits', async () => {
    await expect(supabase.getModuleExecutions(WALLET, { limit: 1001 })).rejects.toThrow(
      /between 1 and 1000/
    );
  });
});
