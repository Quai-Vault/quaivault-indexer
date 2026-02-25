import { config } from '../config.js';
import { quai } from './quai.js';
import {
  decodeEvent,
  getAllEventTopics,
  getModuleEventTopics,
  getTokenTransferTopic,
  EVENT_SIGNATURES,
} from './decoder.js';
import { handleEvent } from '../events/index.js';
import { handleTokenTransfer } from '../events/token-transfer.js';
import { logger } from '../utils/logger.js';
import { getModuleContractAddresses } from '../utils/modules.js';
import { IndexerLog, DecodedEvent, TokenStandard } from '../types/index.js';

/**
 * Callback context for block processing.
 * Allows callers to react to discovered wallets without coupling to a specific implementation.
 */
export interface BlockProcessorContext {
  /** Set of lowercase wallet addresses currently being tracked */
  trackedWallets: Set<string>;
  /** Map of lowercase token addresses to their standard (ERC20/ERC721) */
  trackedTokens: Map<string, TokenStandard>;
  /** Called when a new wallet is discovered via factory events */
  onWalletDiscovered: (address: string, event: DecodedEvent) => void;
  /**
   * Called between wallet event processing (step 2) and token transfer fetching (step 3).
   * Must mutate ctx.trackedTokens in-place to include any tokens auto-discovered during
   * step 2 (e.g. via TransactionProposed calldata decoding), so those tokens' Transfer
   * events are captured in the same batch.
   */
  refreshTrackedTokens?: () => Promise<void>;
}

/**
 * Process a range of blocks: fetch factory events, wallet events (chunked),
 * module events, token transfer events, sort, decode, and handle.
 *
 * This is the core indexing logic shared between the real-time indexer and
 * the standalone backfill script.
 */
export async function processBlockRange(
  fromBlock: number,
  toBlock: number,
  ctx: BlockProcessorContext
): Promise<void> {
  // 1. Get and process factory events FIRST (new wallet deployments/registrations)
  const factoryLogs = await quai.getLogs(
    config.contracts.quaiVaultFactory,
    [[EVENT_SIGNATURES.WalletCreated, EVENT_SIGNATURES.WalletRegistered]],
    fromBlock,
    toBlock
  );

  for (const log of factoryLogs) {
    const event = decodeEvent(log);
    if (event) {
      await handleEvent(event);
      if (event.name === 'WalletCreated' || event.name === 'WalletRegistered') {
        const walletAddress = event.args.wallet as string;
        ctx.onWalletDiscovered(walletAddress, event);
      }
    }
  }

  // 2. Now fetch wallet and module events (new wallets are now tracked)
  const allLogs: Array<{
    log: IndexerLog;
    priority: number;
  }> = [];

  // Get events from all tracked wallets (chunked to avoid RPC limits)
  if (ctx.trackedWallets.size > 0) {
    const walletAddresses = Array.from(ctx.trackedWallets);
    const chunkSize = config.indexer.getLogsChunkSize;
    const eventTopics = [getAllEventTopics()];

    for (let i = 0; i < walletAddresses.length; i += chunkSize) {
      const chunk = walletAddresses.slice(i, i + chunkSize);
      const walletLogs = await quai.getLogs(
        chunk,
        eventTopics,
        fromBlock,
        toBlock
      );

      for (const log of walletLogs) {
        allLogs.push({ log, priority: 1 });
      }
    }
  }

  // Get events from module contracts
  const moduleAddresses = getModuleContractAddresses();
  if (moduleAddresses.length > 0) {
    const moduleTopics = getModuleEventTopics();
    logger.debug(
      { moduleAddresses, topicCount: moduleTopics.length, fromBlock, toBlock },
      'Querying module contracts for events'
    );

    const moduleLogs = await quai.getLogs(
      moduleAddresses,
      [moduleTopics],
      fromBlock,
      toBlock
    );

    logger.debug(
      { count: moduleLogs.length, fromBlock, toBlock },
      'Module logs retrieved'
    );

    // Build a set for O(1) source validation (defense-in-depth)
    const moduleAddressSet = new Set(moduleAddresses.map((a) => a.toLowerCase()));

    for (const log of moduleLogs) {
      // Validate source address — skip logs from unexpected contracts
      if (!moduleAddressSet.has(log.address.toLowerCase())) {
        logger.warn(
          { address: log.address, topic0: log.topics[0], blockNumber: log.blockNumber },
          'Module log from unexpected address, skipping'
        );
        continue;
      }

      logger.debug(
        { address: log.address, topic0: log.topics[0], blockNumber: log.blockNumber },
        'Module log found'
      );
      allLogs.push({ log, priority: 2 });
    }
  }

  // Refresh tracked tokens before querying Transfer events.
  // Tokens can be auto-discovered during step 2 (e.g. via TransactionProposed calldata).
  // Without this refresh, Transfer events for newly-discovered tokens would be missed
  // in the same batch — causing inflows/outflows to go unrecorded.
  if (ctx.refreshTrackedTokens) {
    await ctx.refreshTrackedTokens();
  }

  // 3. Get Transfer events from tracked token contracts (chunked)
  if (ctx.trackedTokens.size > 0 && ctx.trackedWallets.size > 0) {
    const tokenAddresses = Array.from(ctx.trackedTokens.keys());
    const chunkSize = config.indexer.getLogsChunkSize;
    const transferTopic = getTokenTransferTopic();

    for (let i = 0; i < tokenAddresses.length; i += chunkSize) {
      const chunk = tokenAddresses.slice(i, i + chunkSize);
      const tokenLogs = await quai.getLogs(
        chunk,
        [[transferTopic]],
        fromBlock,
        toBlock
      );

      // Client-side filter: only keep logs where from or to is a tracked vault
      for (const log of tokenLogs) {
        if (log.topics.length < 3) continue;
        const from = ('0x' + log.topics[1].slice(26)).toLowerCase();
        const to = ('0x' + log.topics[2].slice(26)).toLowerCase();

        if (ctx.trackedWallets.has(from) || ctx.trackedWallets.has(to)) {
          allLogs.push({ log, priority: 3 });
        }
      }
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
  for (const { log, priority } of allLogs) {
    if (priority === 3) {
      // Token transfer — dispatch directly, bypassing decodeEvent/handleEvent
      const standard = ctx.trackedTokens.get(log.address.toLowerCase());
      if (standard) {
        await handleTokenTransfer(log, standard, ctx.trackedWallets);
      }
    } else {
      const event = decodeEvent(log);
      if (event) {
        await handleEvent(event);
      }
    }
  }
}
