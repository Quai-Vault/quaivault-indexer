import { config } from './config.js';
import { quai } from './services/quai.js';
import { supabase } from './services/supabase.js';
import { decodeEvent, EVENT_SIGNATURES } from './services/decoder.js';
import { handleDisabledModule, handleEnabledModule } from './events/vault-core.js';
import { logger } from './utils/logger.js';
import type { IndexerLog } from './types/index.js';

const MODULE_TOPICS = [[
  EVENT_SIGNATURES.EnabledModule,
  EVENT_SIGNATURES.DisabledModule,
]];

/**
 * Some RPC gateways reject an otherwise valid getLogs filter when the address
 * count and block span are large. The Quai service already retries transient
 * failures; after those retries are exhausted, subdivide the query while
 * preserving the exact address/block coverage.
 */
async function getModuleLogsAdaptive(
  addresses: string[],
  fromBlock: number,
  toBlock: number
): Promise<IndexerLog[]> {
  try {
    return await quai.getLogs(addresses, MODULE_TOPICS, fromBlock, toBlock);
  } catch (error) {
    if (addresses.length > 1) {
      const midpoint = Math.ceil(addresses.length / 2);
      logger.warn(
        { addresses: addresses.length, fromBlock, toBlock },
        'Module log query failed; splitting address filter'
      );
      const left = await getModuleLogsAdaptive(
        addresses.slice(0, midpoint),
        fromBlock,
        toBlock
      );
      const right = await getModuleLogsAdaptive(
        addresses.slice(midpoint),
        fromBlock,
        toBlock
      );
      return [...left, ...right];
    }

    if (fromBlock < toBlock) {
      const midpoint = Math.floor((fromBlock + toBlock) / 2);
      logger.warn(
        { address: addresses[0], fromBlock, toBlock },
        'Module log query failed; splitting block range'
      );
      const left = await getModuleLogsAdaptive(addresses, fromBlock, midpoint);
      const right = await getModuleLogsAdaptive(addresses, midpoint + 1, toBlock);
      return [...left, ...right];
    }

    throw error;
  }
}

async function backfillModuleLifecycle(): Promise<void> {
  const wallets = await supabase.getAllWalletAddresses();
  const chainHead = await quai.getBlockNumber();
  const safeBlock = chainHead - config.indexer.confirmations;
  const fromBlock = Number.parseInt(
    process.env.MODULE_BACKFILL_FROM ?? String(config.indexer.startBlock),
    10
  );
  const toBlock = Number.parseInt(process.env.MODULE_BACKFILL_TO ?? String(safeBlock), 10);
  if (!Number.isSafeInteger(fromBlock) || fromBlock < config.indexer.startBlock) {
    throw new Error(`MODULE_BACKFILL_FROM must be an integer >= START_BLOCK (${config.indexer.startBlock})`);
  }
  if (!Number.isSafeInteger(toBlock) || toBlock < fromBlock || toBlock > safeBlock) {
    throw new Error(`MODULE_BACKFILL_TO must be between ${fromBlock} and safe block ${safeBlock}`);
  }
  const addressChunkSize = config.indexer.getLogsChunkSize;
  const blockBatchSize = config.indexer.batchSize;

  logger.info({ wallets: wallets.length, fromBlock, toBlock }, 'Starting module lifecycle backfill');

  let processed = 0;
  // WalletRegistered records use the registration block as created_at_block, so
  // START_BLOCK is the only complete default. Explicit ranges let operators resume
  // large jobs at a logged batch boundary without weakening replay safety.
  for (let start = fromBlock; start <= toBlock; start += blockBatchSize) {
    const end = Math.min(start + blockBatchSize - 1, toBlock);
    const before = await quai.getBlock(end);

    for (let offset = 0; offset < wallets.length; offset += addressChunkSize) {
      const chunk = wallets.slice(offset, offset + addressChunkSize);
      const logs = await getModuleLogsAdaptive(chunk, start, end);

      logs.sort((a, b) =>
        a.blockNumber !== b.blockNumber
          ? a.blockNumber - b.blockNumber
          : a.index - b.index
      );

      for (const log of logs) {
        const event = decodeEvent(log);
        if (event?.name === 'EnabledModule') {
          await handleEnabledModule(event);
          processed++;
        } else if (event?.name === 'DisabledModule') {
          await handleDisabledModule(event);
          processed++;
        }
      }
    }

    const after = await quai.getBlock(end);
    if (before.hash !== after.hash) {
      await supabase.rollbackModuleEventsAfterBlock(start - 1);
      throw new Error(`Chain changed during module backfill ${start}-${end}; batch was rolled back`);
    }
    logger.info(
      { completedThroughBlock: end, targetBlock: toBlock, wallets: wallets.length, events: processed },
      'Module lifecycle backfill progress'
    );
  }

  logger.info({ wallets: wallets.length, events: processed }, 'Module lifecycle backfill complete');
}

backfillModuleLifecycle().catch((err) => {
  const error = err as Error & { code?: string };
  logger.error(
    { error: { message: error.message, code: error.code } },
    'Module lifecycle backfill failed'
  );
  process.exit(1);
});
