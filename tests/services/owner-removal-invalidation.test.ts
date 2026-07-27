/**
 * Regression tests for KNOWN_DATA_GAPS.md Gap 1.
 *
 * QuaiVault._removeOwner bumps ownerVersions[owner], which invalidates every
 * in-flight approval from that address at once and permanently — re-adding the
 * owner does not rewind the epoch. The indexer has to mirror that, or
 * transactions.confirmation_count over-reports for as long as the affected
 * transactions stay open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Call {
  table: string;
  op: 'update' | 'insert' | 'upsert' | 'select';
  payload?: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

const calls: Call[] = [];
/** Per-table error injection, keyed by table name. */
const errors: Record<string, { message: string; code?: string } | undefined> = {};

function builder(table: string) {
  const call: Call = { table, op: 'select', filters: [] };
  const chain = {
    update(payload: Record<string, unknown>) {
      call.op = 'update';
      call.payload = payload;
      calls.push(call);
      return chain;
    },
    insert(payload: Record<string, unknown>) {
      call.op = 'insert';
      call.payload = payload;
      calls.push(call);
      return chain;
    },
    upsert(payload: Record<string, unknown>) {
      call.op = 'upsert';
      call.payload = payload;
      calls.push(call);
      return chain;
    },
    eq(column: string, value: unknown) {
      call.filters.push([column, value]);
      return chain;
    },
    // Make the chain awaitable, the way a PostgREST builder is.
    then(resolve: (v: { error: unknown }) => unknown) {
      return Promise.resolve({ error: errors[table] ?? null }).then(resolve);
    },
  };
  return chain;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => builder(table) }),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    supabase: { url: 'http://localhost', serviceKey: 'test-key', schema: 'test' },
    // Retries are exercised by the error-path test; keep the delays at zero.
    retry: { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0, errorThreshold: 3 },
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { supabase } from '../../src/services/supabase.js';

const WALLET = '0x00432fa4a3e6eb3ebcee26ad34a8d80118cb4cfd';
const OWNER = '0x004c0d1b601fdbddc1fe125cd39c19b8dbeaa8c0';
const TX = '0x58de93d9d4f36661892e7d4907c059afebe6c98149f4028aad315f06b7095e54';

const filterMap = (c: Call) => Object.fromEntries(c.filters);

describe('Gap 1 — owner removal invalidates that owner\'s approvals', () => {
  beforeEach(() => {
    calls.length = 0;
    for (const k of Object.keys(errors)) delete errors[k];
  });

  it('deactivates the removed owner\'s confirmations', async () => {
    await supabase.removeOwner(WALLET, OWNER, 8162933, TX);

    const conf = calls.find((c) => c.table === 'confirmations');
    expect(conf, 'removeOwner must write to confirmations').toBeDefined();
    expect(conf!.op).toBe('update');
    expect(conf!.payload).toEqual({
      is_active: false,
      invalidated_at_block: 8162933,
      invalidated_reason: 'owner_removed',
    });
  });

  it('scopes the invalidation to that wallet/owner\'s still-active rows', async () => {
    await supabase.removeOwner(WALLET, OWNER, 8162933, TX);

    const conf = calls.find((c) => c.table === 'confirmations')!;
    expect(filterMap(conf)).toEqual({
      wallet_address: WALLET,
      owner_address: OWNER,
      is_active: true,
    });
  });

  it('invalidates across every transaction, not just one', async () => {
    // The epoch bump is global to the address, so the UPDATE must not be
    // narrowed by tx_hash — that is the whole point of the O(1) invalidation.
    await supabase.removeOwner(WALLET, OWNER, 8162933, TX);

    const conf = calls.find((c) => c.table === 'confirmations')!;
    expect(conf.filters.map(([col]) => col)).not.toContain('tx_hash');
  });

  it('leaves revoked_at_block alone so a real ApprovalRevoked stays distinguishable', async () => {
    await supabase.removeOwner(WALLET, OWNER, 8162933, TX);

    const conf = calls.find((c) => c.table === 'confirmations')!;
    expect(conf.payload).not.toHaveProperty('revoked_at_block');
    expect(conf.payload).not.toHaveProperty('revoked_at_tx');
  });

  it('still deactivates the wallet_owners row', async () => {
    await supabase.removeOwner(WALLET, OWNER, 8162933, TX);

    const owner = calls.find((c) => c.table === 'wallet_owners');
    expect(owner).toBeDefined();
    expect(owner!.payload).toMatchObject({
      is_active: false,
      removed_at_block: 8162933,
    });
  });

  it('normalizes mixed-case addresses before filtering', async () => {
    await supabase.removeOwner(WALLET.toUpperCase().replace('0X', '0x'), OWNER.toUpperCase().replace('0X', '0x'), 100, TX);

    const conf = calls.find((c) => c.table === 'confirmations')!;
    expect(filterMap(conf).wallet_address).toBe(WALLET);
    expect(filterMap(conf).owner_address).toBe(OWNER);
  });

  it('surfaces a confirmations failure under its own operation name', async () => {
    errors.confirmations = { message: 'boom' };

    await expect(supabase.removeOwner(WALLET, OWNER, 8162933, TX)).rejects.toThrow(
      /removeOwner\.invalidateConfirmations/
    );
  });

  it('touches only wallet_owners and confirmations', async () => {
    // Guardian approvals are deliberately NOT part of this. SocialRecoveryModule
    // has no epoch counter: executeRecovery gates on the stored
    // recovery.approvalCount and never revalidates guardianship, so a removed
    // guardian's approval still counts on chain. Mirroring the owner fix onto
    // social_recovery_approvals would make the indexer diverge from the chain,
    // not converge with it.
    await supabase.removeOwner(WALLET, OWNER, 8162933, TX);

    expect([...new Set(calls.map((c) => c.table))].sort()).toEqual([
      'confirmations',
      'wallet_owners',
    ]);
  });
});

describe('Gap 1 — re-adding an owner must not resurrect old approvals', () => {
  beforeEach(() => {
    calls.length = 0;
    for (const k of Object.keys(errors)) delete errors[k];
  });

  it('addOwner does not reactivate confirmations', async () => {
    // ownerVersions is never decremented, so approvals made under an earlier
    // epoch stay dead forever. This is also why the fix cannot be a view joined
    // against wallet_owners.is_active — a re-add would flip those rows back.
    await supabase.addOwner({
      walletAddress: WALLET,
      ownerAddress: OWNER,
      addedAtBlock: 8162947,
      addedAtTx: TX,
    });

    expect(calls.map((c) => c.table)).toEqual(['wallet_owners']);
    expect(calls.find((c) => c.table === 'confirmations')).toBeUndefined();
  });

  it('addOwnersBatch does not reactivate confirmations', async () => {
    await supabase.addOwnersBatch([
      { walletAddress: WALLET, ownerAddress: OWNER, addedAtBlock: 8162947, addedAtTx: TX },
    ]);

    expect(calls.find((c) => c.table === 'confirmations')).toBeUndefined();
  });
});
