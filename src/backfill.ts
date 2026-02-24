import { config } from './config.js';
import { quai } from './services/quai.js';
import { supabase } from './services/supabase.js';
import { processBlockRange } from './services/block-processor.js';
import { logger } from './utils/logger.js';

/**
 * Standalone backfill script for historical data indexing.
 * Run with: npm run backfill
 *
 * Environment variables:
 * - BACKFILL_FROM: Starting block number (optional, defaults to START_BLOCK)
 * - BACKFILL_TO: Ending block number (optional, defaults to current block)
 */

async function backfill(): Promise<void> {
  logger.info('Starting backfill script...');

  const currentBlock = await quai.getBlockNumber();

  const fromBlock = parseInt(
    process.env.BACKFILL_FROM || String(config.indexer.startBlock)
  );
  const toBlock = parseInt(process.env.BACKFILL_TO || String(currentBlock));

  logger.info({ fromBlock, toBlock, totalBlocks: toBlock - fromBlock }, 'Backfill range');

  // Track wallets discovered during backfill (lowercase for RPC compatibility)
  const trackedWallets: Set<string> = new Set();

  // Load existing wallets
  const existingWallets = await supabase.getAllWalletAddresses();
  existingWallets.forEach((w) => trackedWallets.add(w.toLowerCase()));
  logger.info({ count: trackedWallets.size }, 'Loaded existing wallets');

  await supabase.setIsSyncing(true);

  const batchSize = config.indexer.batchSize;

  try {
    for (let start = fromBlock; start <= toBlock; start += batchSize) {
      const end = Math.min(start + batchSize - 1, toBlock);

      try {
        await processBlockRange(start, end, {
          trackedWallets,
          onWalletDiscovered: (walletAddress) => {
            trackedWallets.add(walletAddress.toLowerCase());
            logger.info({ wallet: walletAddress }, 'Discovered new wallet');
          },
        });

        await supabase.updateIndexerState(end);

        const totalBlocks = toBlock - fromBlock;
        const progress = totalBlocks > 0
          ? (((end - fromBlock) / totalBlocks) * 100).toFixed(1)
          : '100.0';
        logger.info(
          {
            start,
            end,
            progress: `${progress}%`,
            wallets: trackedWallets.size,
          },
          'Backfill progress'
        );
      } catch (err) {
        logger.error({ err, start, end }, 'Backfill batch failed');
        throw err;
      }
    }
  } finally {
    await supabase.setIsSyncing(false);
  }

  logger.info(
    {
      totalBlocks: toBlock - fromBlock,
      totalWallets: trackedWallets.size,
    },
    'Backfill complete'
  );
}

backfill().catch((err) => {
  logger.error({ err }, 'Backfill failed');
  process.exit(1);
});
