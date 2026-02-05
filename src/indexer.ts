import { config } from './config.js';
import { quai } from './services/quai.js';
import { supabase } from './services/supabase.js';
import { health } from './services/health.js';
import {
  decodeEvent,
  getAllEventTopics,
  getModuleEventTopics,
  EVENT_SIGNATURES,
} from './services/decoder.js';
import { handleEvent } from './events/index.js';
import { logger } from './utils/logger.js';
import { getModuleContractAddresses } from './utils/modules.js';
import { withRetry, RetryTracker } from './utils/retry.js';

// Maximum addresses per getLogs call to avoid RPC limits
const GET_LOGS_ADDRESS_CHUNK_SIZE = 100;

export class Indexer {
  private isRunning = false;
  // Set of lowercase wallet addresses for tracking
  private trackedWallets: Set<string> = new Set();
  // Retry tracker for poll loop resilience
  private pollRetryTracker = new RetryTracker();

  async start(): Promise<void> {
    logger.info('Starting indexer...');

    // Start health check server
    await health.start();

    // Load tracked wallets (lowercase for consistency)
    const wallets = await supabase.getAllWalletAddresses();
    wallets.forEach((w) => this.trackedWallets.add(w.toLowerCase()));
    logger.info({ count: this.trackedWallets.size }, 'Loaded tracked wallets');

    // Update health service with wallet count
    health.setTrackedWalletsCount(this.trackedWallets.size);

    // Log module contracts being watched
    const moduleContracts = getModuleContractAddresses();
    logger.info(
      { modules: moduleContracts.length },
      'Watching module contracts'
    );

    // Get current state
    const state = await supabase.getIndexerState();
    const currentBlock = await quai.getBlockNumber();
    const startBlock = Math.max(
      state.lastIndexedBlock + 1,
      config.indexer.startBlock
    );

    logger.info(
      {
        lastIndexed: state.lastIndexedBlock,
        currentBlock,
        startBlock,
      },
      'Indexer state'
    );

    // Backfill if needed
    if (startBlock < currentBlock - config.indexer.confirmations) {
      await this.backfill(
        startBlock,
        currentBlock - config.indexer.confirmations
      );
    }

    // Start real-time indexing
    this.isRunning = true;
    health.setIndexerRunning(true);
    this.poll();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    health.setIndexerRunning(false);
    await health.stop();
    await quai.unsubscribe();
    logger.info('Indexer stopped');
  }

  private async backfill(fromBlock: number, toBlock: number): Promise<void> {
    logger.info({ fromBlock, toBlock }, 'Starting backfill');
    await supabase.setIsSyncing(true);

    const batchSize = config.indexer.batchSize;

    for (let start = fromBlock; start <= toBlock; start += batchSize) {
      const end = Math.min(start + batchSize - 1, toBlock);

      // Use retry with backoff for each batch
      await withRetry(
        async () => {
          await this.indexBlockRange(start, end);
          await supabase.updateIndexerState(end);
        },
        { operation: `backfill-batch-${start}-${end}` }
      );

      const totalBlocks = toBlock - fromBlock;
      const progress = totalBlocks > 0
        ? (((end - fromBlock) / totalBlocks) * 100).toFixed(1)
        : '100.0';
      logger.info(
        { start, end, progress: `${progress}%` },
        'Backfill progress'
      );
    }

    await supabase.setIsSyncing(false);
    logger.info('Backfill complete');
  }

  private async indexBlockRange(
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    // 1. Get and process factory events FIRST (new wallet deployments/registrations)
    // This ensures new wallets are tracked before we fetch their events
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
          this.trackedWallets.add(walletAddress.toLowerCase());
          health.setTrackedWalletsCount(this.trackedWallets.size);
          logger.info({ wallet: walletAddress, block: event.blockNumber }, 'Discovered new wallet');
        }
      }
    }

    // 2. Now fetch wallet and module events (new wallets are now tracked)
    const allLogs: Array<{
      log: Awaited<ReturnType<typeof quai.getLogs>>[number];
      priority: number;
    }> = [];

    // Get events from all tracked wallets (chunked to avoid RPC limits)
    // Note: topics must be [[sig1, sig2, ...]] to match ANY signature in topic0
    if (this.trackedWallets.size > 0) {
      const walletAddresses = Array.from(this.trackedWallets);

      // Chunk addresses to avoid RPC provider limits
      for (let i = 0; i < walletAddresses.length; i += GET_LOGS_ADDRESS_CHUNK_SIZE) {
        const chunk = walletAddresses.slice(i, i + GET_LOGS_ADDRESS_CHUNK_SIZE);
        const walletLogs = await quai.getLogs(
          chunk,
          [getAllEventTopics()],
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

      for (const log of moduleLogs) {
        // Debug log each module event with its topic
        logger.debug(
          { address: log.address, topic0: log.topics[0], blockNumber: log.blockNumber },
          'Module log found'
        );
        allLogs.push({ log, priority: 2 });
      }
    }

    // Sort by block number, then log index, then priority
    allLogs.sort((a, b) => {
      if (a.log.blockNumber !== b.log.blockNumber) {
        return a.log.blockNumber - b.log.blockNumber;
      }
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.log.index - b.log.index;
    });

    // Process wallet and module events
    for (const { log } of allLogs) {
      const event = decodeEvent(log);
      if (event) {
        await handleEvent(event);
      }
    }
  }

  private async poll(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.pollOnce();
        this.pollRetryTracker.recordSuccess();
      } catch (error) {
        const retryDelay = this.pollRetryTracker.recordFailure(
          error as Error,
          'poll'
        );

        // If exhausted, log critical and reset (keep trying but ops should investigate)
        if (this.pollRetryTracker.isExhausted()) {
          logger.error(
            { consecutiveFailures: this.pollRetryTracker.getFailureCount() },
            'Poll retry limit reached - continuing but intervention may be needed'
          );
          this.pollRetryTracker.reset();
        }

        // Use backoff delay instead of fixed poll interval after failure
        await this.sleep(retryDelay);
        continue;
      }

      await this.sleep(config.indexer.pollInterval);
    }
  }

  private async pollOnce(): Promise<void> {
    const state = await supabase.getIndexerState();
    const currentBlock = await quai.getBlockNumber();
    const safeBlock = currentBlock - config.indexer.confirmations;

    // Honor START_BLOCK config (e.g., after database reset)
    const startBlock = Math.max(
      state.lastIndexedBlock + 1,
      config.indexer.startBlock
    );

    if (startBlock <= safeBlock) {
      const blocksToIndex = safeBlock - startBlock + 1;

      // If gap exceeds batch size, use backfill (handles database resets)
      if (blocksToIndex > config.indexer.batchSize) {
        logger.info(
          {
            lastIndexed: state.lastIndexedBlock,
            startBlock,
            safeBlock,
            blocksToIndex,
          },
          'Large gap detected, triggering backfill'
        );

        // Reload tracked wallets (may have been cleared by database reset)
        const wallets = await supabase.getAllWalletAddresses();
        this.trackedWallets.clear();
        wallets.forEach((w) => this.trackedWallets.add(w.toLowerCase()));
        health.setTrackedWalletsCount(this.trackedWallets.size);

        await this.backfill(startBlock, safeBlock);
      } else {
        await this.indexBlockRange(startBlock, safeBlock);
        await supabase.updateIndexerState(safeBlock);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
