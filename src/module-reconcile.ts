import { quai } from './services/quai.js';
import { supabase } from './services/supabase.js';
import { logger } from './utils/logger.js';

function difference(left: Set<string>, right: Set<string>): string[] {
  return Array.from(left).filter((value) => !right.has(value)).sort();
}

async function reconcileModules(): Promise<void> {
  const initialState = await supabase.getIndexerState();
  if (initialState.isSyncing) {
    throw new Error('Module reconciliation requires a caught-up, non-syncing indexer');
  }
  if (initialState.lastBlockHash) {
    const indexedBlock = await quai.getBlock(initialState.lastIndexedBlock);
    if (indexedBlock.hash.toLowerCase() !== initialState.lastBlockHash.toLowerCase()) {
      throw new Error('RPC checkpoint hash disagrees with indexer_state; reconciliation aborted');
    }
  }

  const wallets = await supabase.getAllWalletAddresses();
  let mismatchCount = 0;

  logger.info(
    { wallets: wallets.length, indexedBlock: initialState.lastIndexedBlock },
    'Starting read-only module reconciliation at the indexed checkpoint'
  );

  for (const wallet of wallets) {
    const [chainModules, indexedModules] = await Promise.all([
      quai.getModules(wallet, initialState.lastIndexedBlock),
      supabase.getActiveModuleAddresses(wallet),
    ]);
    const chainSet = new Set(chainModules.map((address) => address.toLowerCase()));
    const indexSet = new Set(indexedModules.map((address) => address.toLowerCase()));
    const missingFromIndex = difference(chainSet, indexSet);
    const staleInIndex = difference(indexSet, chainSet);

    if (missingFromIndex.length > 0 || staleInIndex.length > 0) {
      mismatchCount++;
      logger.error({ wallet, missingFromIndex, staleInIndex }, 'Module projection mismatch');
    }
  }

  const finalState = await supabase.getIndexerState();
  if (
    finalState.isSyncing ||
    finalState.lastIndexedBlock !== initialState.lastIndexedBlock ||
    finalState.lastBlockHash !== initialState.lastBlockHash
  ) {
    throw new Error('Indexer checkpoint changed during reconciliation; pause the indexer and retry');
  }

  if (mismatchCount > 0) {
    throw new Error(`Module reconciliation failed for ${mismatchCount} wallet(s)`);
  }

  logger.info({ wallets: wallets.length }, 'Module reconciliation passed');
}

reconcileModules().catch((err) => {
  logger.error({ err }, 'Module reconciliation failed');
  process.exit(1);
});
