import { config } from './config.js';
import { quai } from './services/quai.js';
import { supabase } from './services/supabase.js';
import {
  decodeEvent,
  getAllEventTopics,
  getModuleEventTopics,
  EVENT_SIGNATURES,
} from './services/decoder.js';
import { handleEvent } from './events/index.js';
import { logger } from './utils/logger.js';
import { getModuleContractAddresses } from './utils/modules.js';

// Maximum addresses per getLogs call to avoid RPC limits
const GET_LOGS_ADDRESS_CHUNK_SIZE = 100;

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
  let processedBlocks = 0;

  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock);

    try {
      // Get factory events (new wallet deployments/registrations)
      const factoryLogs = await quai.getLogs(
        config.contracts.quaiVaultFactory,
        [[EVENT_SIGNATURES.WalletCreated, EVENT_SIGNATURES.WalletRegistered]],
        start,
        end
      );

      // Process factory events first
      for (const log of factoryLogs) {
        const event = decodeEvent(log);
        if (event) {
          await handleEvent(event);
          if (event.name === 'WalletCreated' || event.name === 'WalletRegistered') {
            const walletAddress = event.args.wallet as string;
            trackedWallets.add(walletAddress.toLowerCase());
            logger.info({ wallet: walletAddress }, 'Discovered new wallet');
          }
        }
      }

      // Collect all logs with priority for proper ordering
      const allLogs: Array<{
        log: Awaited<ReturnType<typeof quai.getLogs>>[number];
        priority: number;
      }> = [];

      // Get events from tracked wallets (chunked to avoid RPC limits)
      if (trackedWallets.size > 0) {
        const walletAddresses = Array.from(trackedWallets);

        // Chunk addresses to avoid RPC provider limits
        for (let i = 0; i < walletAddresses.length; i += GET_LOGS_ADDRESS_CHUNK_SIZE) {
          const chunk = walletAddresses.slice(i, i + GET_LOGS_ADDRESS_CHUNK_SIZE);
          const walletLogs = await quai.getLogs(
            chunk,
            [getAllEventTopics()],
            start,
            end
          );

          for (const log of walletLogs) {
            allLogs.push({ log, priority: 1 });
          }
        }
      }

      // Get events from module contracts
      const moduleAddresses = getModuleContractAddresses();
      if (moduleAddresses.length > 0) {
        const moduleLogs = await quai.getLogs(
          moduleAddresses,
          [getModuleEventTopics()],
          start,
          end
        );

        for (const log of moduleLogs) {
          allLogs.push({ log, priority: 2 });
        }
      }

      // Sort by block number, then priority, then log index
      allLogs.sort((a, b) => {
        if (a.log.blockNumber !== b.log.blockNumber) {
          return a.log.blockNumber - b.log.blockNumber;
        }
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return a.log.index - b.log.index;
      });

      // Process all events
      for (const { log } of allLogs) {
        const event = decodeEvent(log);
        if (event) {
          await handleEvent(event);
        }
      }

      await supabase.updateIndexerState(end);
      processedBlocks = end - fromBlock;

      const totalBlocks = toBlock - fromBlock;
      const progress = totalBlocks > 0
        ? ((processedBlocks / totalBlocks) * 100).toFixed(1)
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

  await supabase.setIsSyncing(false);
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
