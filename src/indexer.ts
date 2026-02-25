import { config } from './config.js';
import { quai } from './services/quai.js';
import { supabase } from './services/supabase.js';
import { health } from './services/health.js';
import { decodeEvent, getAllEventTopics } from './services/decoder.js';
import { handleEvent } from './events/index.js';
import { processBlockRange } from './services/block-processor.js';
import { logger } from './utils/logger.js';
import { getModuleContractAddresses } from './utils/modules.js';
import { withRetry, RetryTracker } from './utils/retry.js';
import { CircuitBreaker } from './utils/circuit-breaker.js';
import type { TokenStandard } from './types/index.js';

export class Indexer {
  private isRunning = false;
  // Set of lowercase wallet addresses for tracking
  private trackedWallets: Set<string> = new Set();
  // Map of lowercase token addresses to their standard (ERC20/ERC721)
  private trackedTokens: Map<string, TokenStandard> = new Map();
  // Retry tracker for poll loop resilience
  private pollRetryTracker = new RetryTracker();
  // Circuit breaker for RPC failures
  private circuitBreaker = new CircuitBreaker(
    config.circuitBreaker.failureThreshold,
    config.circuitBreaker.cooldownMs,
    (isOpen) => health.setRpcCircuitBreakerOpen(isOpen)
  );
  // In-flight work promise for graceful shutdown
  private currentWork: Promise<{ caughtUp: boolean }> | null = null;
  // Last indexed block hash for reorg detection (persisted in indexer_state)
  private lastBlockHash: string | null = null;

  async start(): Promise<void> {
    logger.info('Starting indexer...');

    // Start health check server
    await health.start();

    // Wait for RPC connection before proceeding
    await this.waitForRpcConnection();

    // Load tracked wallets (lowercase for consistency)
    const wallets = await supabase.getAllWalletAddresses();
    wallets.forEach((w) => this.trackedWallets.add(w.toLowerCase()));
    logger.info({ count: this.trackedWallets.size }, 'Loaded tracked wallets');

    // Update health service with wallet count
    health.setTrackedWalletsCount(this.trackedWallets.size);

    // Seed known tokens from config (resolve metadata via RPC)
    await this.seedTokens();

    // Load tracked tokens from database
    await this.refreshTrackedTokens();
    logger.info({ count: this.trackedTokens.size }, 'Loaded tracked tokens');

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

    // Restore persisted block hash for reorg detection across restarts
    this.lastBlockHash = state.lastBlockHash;

    logger.info(
      {
        lastIndexed: state.lastIndexedBlock,
        lastBlockHash: state.lastBlockHash ? state.lastBlockHash.slice(0, 18) + '...' : null,
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
    this.poll().catch((err) => {
      logger.error({ err }, 'Poll loop crashed unexpectedly');
      process.exit(1);
    });
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    health.setIndexerRunning(false);

    // Wait for in-flight work to finish before tearing down
    if (this.currentWork) {
      logger.info('Waiting for in-flight poll work to complete...');
      try {
        await this.currentWork;
      } catch {
        // Already handled in poll loop
      }
    }

    await health.stop();
    await quai.unsubscribe();
    logger.info('Indexer stopped');
  }

  private async backfill(fromBlock: number, toBlock: number): Promise<void> {
    logger.info({ fromBlock, toBlock }, 'Starting backfill');
    await supabase.setIsSyncing(true);

    try {
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
    } finally {
      await supabase.setIsSyncing(false);
    }

    logger.info('Backfill complete');
  }

  private async indexBlockRange(
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    await processBlockRange(fromBlock, toBlock, {
      trackedWallets: this.trackedWallets,
      trackedTokens: this.trackedTokens,
      onWalletDiscovered: (walletAddress, event) => {
        const walletLower = walletAddress.toLowerCase();
        const isNew = !this.trackedWallets.has(walletLower);

        if (isNew && this.trackedWallets.size >= config.indexer.walletWarningThreshold) {
          logger.warn(
            { wallet: walletAddress, count: this.trackedWallets.size, threshold: config.indexer.walletWarningThreshold },
            'Tracked wallet count exceeds warning threshold'
          );
        }

        this.trackedWallets.add(walletLower);
        health.setTrackedWalletsCount(this.trackedWallets.size);
        logger.info({ wallet: walletAddress, block: event.blockNumber }, 'Discovered new wallet');

        // WalletRegistered signals a pre-existing wallet being added to the factory.
        // Backfill its on-chain history prior to the registration block so no
        // events are missed from before it became tracked.
        if (event.name === 'WalletRegistered' && isNew) {
          const historyEnd = event.blockNumber - 1;
          if (historyEnd >= config.indexer.startBlock) {
            // Async backfill with retry — runs in background, errors are logged
            withRetry(
              () => this.backfillWalletHistory(walletLower, config.indexer.startBlock, historyEnd),
              { operation: `backfillWalletHistory(${walletLower})` }
            ).catch((err) => logger.error({ err, wallet: walletLower }, 'Wallet history backfill failed after retries'));
          }
        }
      },
    });
  }

  private async poll(): Promise<void> {
    logger.info('Poll loop started');

    while (this.isRunning) {
      // Check circuit breaker before attempting
      if (!this.circuitBreaker.isAllowed()) {
        logger.debug('Circuit breaker open, waiting');
        await this.sleep(config.indexer.pollInterval);
        continue;
      }

      try {
        this.currentWork = this.pollOnce();
        const { caughtUp } = await this.currentWork;
        this.currentWork = null;
        this.pollRetryTracker.recordSuccess();
        this.circuitBreaker.recordSuccess();

        // Backpressure: only sleep when caught up; otherwise loop immediately
        if (caughtUp) {
          await this.sleep(config.indexer.pollInterval);
        }
      } catch (error) {
        const retryDelay = this.pollRetryTracker.recordFailure(
          error as Error,
          'poll'
        );
        this.circuitBreaker.recordFailure();

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
      }
    }
  }

  private async pollOnce(): Promise<{ caughtUp: boolean }> {
    // Refresh tracked tokens every poll cycle (lightweight, few rows)
    await this.refreshTrackedTokens();

    const state = await supabase.getIndexerState();
    const currentBlock = await quai.getBlockNumber();
    const safeBlock = currentBlock - config.indexer.confirmations;

    // Honor START_BLOCK config (e.g., after database reset)
    const startBlock = Math.max(
      state.lastIndexedBlock + 1,
      config.indexer.startBlock
    );

    // Chain reorg detection: verify the last indexed block hash still matches
    // lastBlockHash is persisted in indexer_state so detection works across restarts
    if (this.lastBlockHash && state.lastIndexedBlock > 0) {
      const block = await quai.getBlock(state.lastIndexedBlock);
      if (block && block.hash !== this.lastBlockHash) {
        const rollbackTo = Math.max(
          state.lastIndexedBlock - config.indexer.reorgRollbackBlocks,
          config.indexer.startBlock
        );
        logger.warn(
          {
            block: state.lastIndexedBlock,
            expected: this.lastBlockHash,
            actual: block.hash,
            rollbackTo,
          },
          'Chain reorg detected — rolling back indexer state'
        );
        await supabase.updateIndexerState(rollbackTo, undefined);
        this.lastBlockHash = null;
        return { caughtUp: false };
      }
    }

    if (startBlock > safeBlock) {
      logger.info(
        { lastIndexed: state.lastIndexedBlock, currentBlock, safeBlock, startBlock },
        'Caught up, waiting for new blocks'
      );
      return { caughtUp: true };
    }

    const blocksToIndex = safeBlock - startBlock + 1;

    // If gap exceeds batch size, use backfill (handles database resets)
    if (blocksToIndex > config.indexer.batchSize) {
      logger.info(
        {
          lastIndexed: state.lastIndexedBlock,
          startBlock,
          safeBlock,
          blocksToIndex,
          walletsBeforeRefresh: this.trackedWallets.size,
          batchSize: config.indexer.batchSize,
        },
        'Large gap detected, triggering backfill'
      );

      // Reload tracked wallets using atomic swap pattern
      // Build new set first, then replace to avoid race condition
      const wallets = await supabase.getAllWalletAddresses();
      const newSet = new Set(wallets.map((w) => w.toLowerCase()));
      this.trackedWallets = newSet;  // Atomic swap
      health.setTrackedWalletsCount(this.trackedWallets.size);

      await this.backfill(startBlock, safeBlock);
    } else {
      logger.info(
        { startBlock, safeBlock, blocksToIndex },
        'Indexing block range'
      );
      await this.indexBlockRange(startBlock, safeBlock);

      // Persist block hash alongside state for reorg detection across restarts
      const lastBlock = await quai.getBlock(safeBlock);
      const blockHash = lastBlock?.hash ?? null;
      await supabase.updateIndexerState(safeBlock, blockHash ?? undefined);
      this.lastBlockHash = blockHash;
    }

    return { caughtUp: false };
  }

  /**
   * Backfill historical events for a single wallet address over a block range.
   * Used when a WalletRegistered event is detected for a pre-existing wallet
   * that has on-chain history prior to its registration with the factory.
   */
  private async backfillWalletHistory(walletAddress: string, fromBlock: number, toBlock: number): Promise<void> {
    if (fromBlock > toBlock) return;

    logger.info(
      { wallet: walletAddress, fromBlock, toBlock },
      'Backfilling history for newly registered wallet'
    );

    const batchSize = config.indexer.batchSize;
    for (let start = fromBlock; start <= toBlock; start += batchSize) {
      const end = Math.min(start + batchSize - 1, toBlock);
      const logs = await quai.getLogs(
        walletAddress,
        [getAllEventTopics()],
        start,
        end
      );

      const sorted = logs.slice().sort((a, b) =>
        a.blockNumber !== b.blockNumber
          ? a.blockNumber - b.blockNumber
          : a.index - b.index
      );

      for (const log of sorted) {
        const event = decodeEvent(log);
        if (event) {
          await handleEvent(event);
        }
      }
    }

    logger.info({ wallet: walletAddress }, 'Wallet history backfill complete');
  }

  /**
   * Seed known tokens from SEED_TOKEN_ADDRESSES env var.
   * Probes each address via RPC for ERC20 metadata and upserts to DB.
   */
  private async seedTokens(): Promise<void> {
    const seedAddresses = config.tokens.seedAddresses;
    if (seedAddresses.length === 0) return;

    logger.info({ count: seedAddresses.length }, 'Seeding tokens from config');
    for (const address of seedAddresses) {
      try {
        const metadata = await quai.getERC20Metadata(address);
        if (metadata) {
          await supabase.upsertToken({
            address,
            standard: 'ERC20',
            ...metadata,
            discoveredVia: 'seed',
          });
          logger.info({ address, symbol: metadata.symbol }, 'Seeded token');
        } else {
          logger.warn({ address }, 'Seed token RPC probe returned no metadata, skipping');
        }
      } catch (err) {
        logger.warn({ err, address }, 'Failed to seed token, skipping');
      }
    }
  }

  /**
   * Reload tracked tokens from the database (atomic swap).
   */
  private async refreshTrackedTokens(): Promise<void> {
    const tokens = await supabase.getAllTokens();
    this.trackedTokens = new Map(
      tokens.map((t) => [t.address.toLowerCase(), t.standard])
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wait for RPC connection to be available before starting indexer.
   * Retries with exponential backoff to handle temporary RPC outages at startup.
   */
  private async waitForRpcConnection(maxAttempts = 30, initialDelayMs = 2000): Promise<void> {
    let delay = initialDelayMs;
    const maxDelay = 30000; // Cap at 30 seconds between attempts

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const block = await quai.getBlockNumber();
        logger.info({ block, attempts: attempt }, 'RPC connection established');
        return;
      } catch (err) {
        const error = err as Error;
        logger.warn(
          {
            attempt,
            maxAttempts,
            nextRetryMs: delay,
            err: error
          },
          'Waiting for RPC connection...'
        );

        if (attempt === maxAttempts) {
          throw new Error(
            `Failed to connect to RPC after ${maxAttempts} attempts: ${error.message}`
          );
        }

        await this.sleep(delay);
        // Exponential backoff with cap
        delay = Math.min(delay * 1.5, maxDelay);
      }
    }
  }

}
