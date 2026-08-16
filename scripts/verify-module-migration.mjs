import { readFile } from 'node:fs/promises';

const files = [
  'supabase/migrations/schema.sql',
  'supabase/migrations/004_wallet_module_lifecycle.sql',
];

const safeResetFiles = [
  ...files,
  'supabase/migrations/005_safe_rebuild_deletes.sql',
];

const requiredPatterns = [
  ['lifecycle table', /wallet_module_events/],
  ['projection ordering block', /last_event_block/],
  ['projection ordering log index', /last_event_log_index/],
  ['atomic lifecycle function', /apply_wallet_module_event/],
  ['targeted rollback function', /rollback_wallet_module_events_after/],
  ['inventory function', /get_wallet_module_inventory/],
  ['inventory wallet existence signal', /walletIndexed/],
  ['reorg rebuild function', /reset_indexed_data/],
  ['event uniqueness', /UNIQUE\s*\(wallet_address,\s*event_tx,\s*log_index\)/s],
  ['replay collision detection', /module event identity collision/],
  ['global rollback index', /idx_wallet_module_events_block/],
  ['reset advisory lock', /pg_advisory_xact_lock/],
  ['checkpoint-fenced reset', /p_expected_indexed_block/],
  ['public read policy', /Public read access[\s\S]*wallet_module_events/],
  ['service write policy', /Service write access[\s\S]*wallet_module_events/],
  ['service-only lifecycle revoke', /REVOKE ALL ON FUNCTION[\s\S]*apply_wallet_module_event/],
  ['realtime publication', /supabase_realtime ADD TABLE[\s\S]*wallet_module_events/],
];

let failed = false;
for (const file of files) {
  const sql = await readFile(file, 'utf8');
  for (const [name, pattern] of requiredPatterns) {
    if (!pattern.test(sql)) {
      console.error(`FAIL ${file}: missing ${name}`);
      failed = true;
    }
  }
}

for (const file of safeResetFiles) {
  const sql = await readFile(file, 'utf8');
  if (!/DELETE FROM wallets WHERE address IS NOT NULL/.test(sql)) {
    console.error(`FAIL ${file}: reset wallet delete lacks an explicit predicate`);
    failed = true;
  }
  if (!/DELETE FROM tokens WHERE address IS NOT NULL/.test(sql)) {
    console.error(`FAIL ${file}: reset token delete lacks an explicit predicate`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`PASS module lifecycle migration structure (${safeResetFiles.length} files)`);
