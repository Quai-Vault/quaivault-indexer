#!/usr/bin/env node
/**
 * Verification for the two gaps in KNOWN_DATA_GAPS.md.
 *
 * Gap 1 (approvals from removed owners stay active) is checked against the
 * confirmations/wallet_owners tables. Gap 2 (expired records stay `pending`) is
 * checked through the effective-status views, which is the only way to cover a
 * view — the unit tests in tests/services/ cannot.
 *
 * Usage:
 *   node scripts/verify-data-gaps.mjs                 # mainnet + testnet
 *   node scripts/verify-data-gaps.mjs dev             # a specific schema
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_KEY from .env. Read-only: issues nothing
 * but GETs. Exits non-zero if any check fails, so it can gate a deploy.
 */
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
  console.error('no .env found in the current directory');
  process.exit(2);
}
const env = Object.fromEntries(
  fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const URL_BASE = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_KEY;
if (!URL_BASE || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
  process.exit(2);
}

const schemas = process.argv.slice(2);
const targets = schemas.length ? schemas : ['mainnet', 'testnet'];

async function q(schema, pathAndQuery) {
  const res = await fetch(`${URL_BASE}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Accept-Profile': schema,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`${res.status} ${body}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

let failures = 0;
let skipped = 0;

const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg, detail) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
  if (detail) console.log(detail);
};
const skip = (msg, why) => {
  skipped++;
  console.log(`  SKIP  ${msg} — ${why}`);
};

/**
 * Enum labels the indexer writes. schema.sql's CREATE TYPE statements are guarded
 * by IF NOT EXISTS, so a type created by an older schema version silently never
 * picks up labels added later — which is exactly how recovery_status ended up
 * missing 'invalidated' and 'expired' on every schema (Gap 3). A write of a
 * missing label fails with 22P02 and processBlockRange skips the event silently.
 *
 * Filtering on an enum literal makes Postgres parse it against the type, so a
 * 22P02 back means the label is absent.
 */
const ENUMS = [
  ['transactions', 'status', 'transaction_status', ['pending', 'executed', 'cancelled', 'expired', 'failed']],
  ['transactions', 'transaction_type', 'transaction_type', ['transfer', 'module_config', 'wallet_admin', 'recovery_setup', 'external_call', 'unknown', 'module_execution', 'batched_call', 'erc20_transfer', 'erc721_transfer', 'erc1155_transfer', 'message_signing']],
  ['social_recoveries', 'status', 'recovery_status', ['pending', 'executed', 'cancelled', 'invalidated', 'expired']],
  ['tokens', 'standard', 'token_standard', ['ERC20', 'ERC721', 'ERC1155']],
  ['token_transfers', 'direction', 'transfer_direction', ['inflow', 'outflow']],
];

async function enumLabelExists(schema, table, column, label) {
  try {
    await q(schema, `${table}?select=${column}&${column}=eq.${encodeURIComponent(label)}&limit=1`);
    return true;
  } catch (e) {
    if (/22P02|invalid input value for enum/.test(e.body ?? '')) return false;
    throw e;
  }
}

for (const schema of targets) {
  console.log(`\n=== ${schema} ===`);

  // ---- Gap 3: enum drift ---------------------------------------------------
  for (const [table, column, typeName, labels] of ENUMS) {
    let missing;
    try {
      missing = [];
      for (const label of labels) {
        if (!(await enumLabelExists(schema, table, column, label))) missing.push(label);
      }
    } catch (e) {
      fail(`Gap 3 — could not check public.${typeName}`, `        ${e.message}`);
      continue;
    }
    if (missing.length === 0) {
      pass(`Gap 3 — public.${typeName} has all ${labels.length} labels`);
    } else {
      fail(
        `Gap 3 — public.${typeName} is missing ${missing.map((m) => `'${m}'`).join(', ')}`,
        `        the indexer writes these; a write fails with 22P02 and the event is skipped silently`
      );
    }
  }

  let confirmations;
  let owners;
  let transactions;
  try {
    [confirmations, owners, transactions] = await Promise.all([
      q(schema, 'confirmations?select=wallet_address,tx_hash,owner_address,is_active&limit=100000'),
      q(schema, 'wallet_owners?select=wallet_address,owner_address,is_active&limit=100000'),
      q(schema, 'transactions?select=wallet_address,tx_hash,status,confirmation_count,expiration&limit=100000'),
    ]);
  } catch (e) {
    fail(`could not read ${schema}`, `        ${e.message}`);
    continue;
  }

  // ---- Gap 1, check 1: no active confirmations from non-owners -------------
  const activeOwners = new Set(
    owners.filter((o) => o.is_active).map((o) => `${o.wallet_address}|${o.owner_address}`)
  );
  const ghosts = confirmations.filter(
    (c) => c.is_active && !activeOwners.has(`${c.wallet_address}|${c.owner_address}`)
  );
  if (ghosts.length === 0) {
    pass('Gap 1 — no active confirmations from non-owners');
  } else {
    fail(
      `Gap 1 — ${ghosts.length} active confirmation(s) from addresses that are not current owners`,
      ghosts
        .slice(0, 10)
        .map((g) => `        ${g.wallet_address} ${g.tx_hash} owner=${g.owner_address}`)
        .join('\n')
    );
  }

  // ---- Gap 1, check 2: stored count matches a recount ----------------------
  const activeByTx = new Map();
  for (const c of confirmations) {
    if (!c.is_active) continue;
    const k = `${c.wallet_address}|${c.tx_hash}`;
    activeByTx.set(k, (activeByTx.get(k) ?? 0) + 1);
  }
  const drift = transactions
    .filter((t) => t.status === 'pending')
    .map((t) => ({ t, recomputed: activeByTx.get(`${t.wallet_address}|${t.tx_hash}`) ?? 0 }))
    .filter(({ t, recomputed }) => t.confirmation_count !== recomputed);
  if (drift.length === 0) {
    pass('Gap 1 — stored confirmation_count matches active confirmations');
  } else {
    fail(
      `Gap 1 — ${drift.length} pending transaction(s) with a stale confirmation_count`,
      drift
        .slice(0, 10)
        .map(({ t, recomputed }) => `        ${t.tx_hash} stored=${t.confirmation_count} recomputed=${recomputed}`)
        .join('\n')
    );
  }

  // ---- Gap 2: the effective-status views exist and reclassify correctly ----
  const now = Math.floor(Date.now() / 1000);

  let txEffective;
  try {
    txEffective = await q(
      schema,
      'transactions_effective?select=wallet_address,tx_hash,status,effective_status,expiration,confirmation_count&limit=100000'
    );
  } catch (e) {
    if (e.status === 404 || /does not exist|Could not find/i.test(e.body ?? '')) {
      skip('Gap 2 — transactions_effective', 'view not present (apply migration 001)');
    } else {
      fail('Gap 2 — could not read transactions_effective', `        ${e.message}`);
    }
    txEffective = null;
  }

  if (txEffective) {
    const shouldExpire = txEffective.filter(
      (t) => t.status === 'pending' && Number(t.expiration) > 0 && Number(t.expiration) < now
    );
    const misreported = shouldExpire.filter((t) => t.effective_status !== 'expired');
    if (misreported.length === 0) {
      pass(
        `Gap 2 — all ${shouldExpire.length} past-deadline transaction(s) report effective_status='expired'`
      );
    } else {
      fail(
        `Gap 2 — ${misreported.length} past-deadline transaction(s) still report '${misreported[0].effective_status}'`,
        misreported.slice(0, 10).map((t) => `        ${t.tx_hash} expiration=${t.expiration}`).join('\n')
      );
    }

    // expiration = 0 means "no expiry" and must never be reclassified.
    const noExpiry = txEffective.filter((t) => t.status === 'pending' && Number(t.expiration) === 0);
    const wronglyExpired = noExpiry.filter((t) => t.effective_status !== 'pending');
    if (wronglyExpired.length === 0) {
      pass(`Gap 2 — all ${noExpiry.length} transaction(s) with expiration=0 still report 'pending'`);
    } else {
      fail(
        `Gap 2 — ${wronglyExpired.length} transaction(s) with expiration=0 were wrongly reclassified`,
        wronglyExpired.slice(0, 10).map((t) => `        ${t.tx_hash}`).join('\n')
      );
    }

    // Terminal statuses must pass through untouched.
    const terminalChanged = txEffective.filter(
      (t) => t.status !== 'pending' && t.status !== t.effective_status
    );
    if (terminalChanged.length === 0) {
      pass('Gap 2 — non-pending transactions pass through unchanged');
    } else {
      fail(
        `Gap 2 — ${terminalChanged.length} non-pending transaction(s) were rewritten by the view`,
        terminalChanged
          .slice(0, 10)
          .map((t) => `        ${t.tx_hash} ${t.status} -> ${t.effective_status}`)
          .join('\n')
      );
    }
  }

  let recEffective;
  try {
    recEffective = await q(
      schema,
      'social_recoveries_effective?select=wallet_address,recovery_hash,status,effective_status,expiration&limit=100000'
    );
  } catch (e) {
    if (e.status === 404 || /does not exist|Could not find/i.test(e.body ?? '')) {
      skip('Gap 2 — social_recoveries_effective', 'view not present (apply migration 001)');
    } else {
      fail('Gap 2 — could not read social_recoveries_effective', `        ${e.message}`);
    }
    recEffective = null;
  }

  if (recEffective) {
    const shouldExpire = recEffective.filter(
      (r) => r.status === 'pending' && Number(r.expiration) > 0 && Number(r.expiration) < now
    );
    const misreported = shouldExpire.filter((r) => r.effective_status !== 'expired');
    if (misreported.length === 0) {
      pass(
        `Gap 2 — all ${shouldExpire.length} past-deadline recover${shouldExpire.length === 1 ? 'y' : 'ies'} report effective_status='expired'`
      );
    } else {
      fail(
        `Gap 2 — ${misreported.length} past-deadline recovery/recoveries still report pending`,
        misreported.slice(0, 10).map((r) => `        ${r.recovery_hash}`).join('\n')
      );
    }

    const terminalChanged = recEffective.filter(
      (r) => r.status !== 'pending' && r.status !== r.effective_status
    );
    if (terminalChanged.length === 0) {
      pass('Gap 2 — non-pending recoveries pass through unchanged (incl. cancelled)');
    } else {
      fail(
        `Gap 2 — ${terminalChanged.length} non-pending recovery/recoveries were rewritten`,
        terminalChanged
          .slice(0, 10)
          .map((r) => `        ${r.recovery_hash} ${r.status} -> ${r.effective_status}`)
          .join('\n')
      );
    }
  }
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(1);
}
console.log(`all checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
