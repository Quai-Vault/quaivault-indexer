import { LRUCache } from 'lru-cache';
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
import { runBackfillLoop } from './utils/backfill-loop.js';
import { withTimeout } from './utils/timeout.js';
import type { TokenStandard } from './types/index.js';

class RangeReorgError extends Error {}

export class Indexer {
  private isRunning = false;
  // Set of lowercase wallet addresses for tracking
  private trackedWallets: Set<string> = new Set();
  // Map of lowercase token addresses to their standard (ERC20/ERC721)
  private trackedTokens: Map<string, TokenStandard> = new Map();
  // Addresses confirmed not to be tokens — bounded LRU to prevent unbounded memory growth
  private notTokenCache = new LRUCache<string, boolean>({ max: config.cache.notTokenCacheSize });
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
  // Token refresh throttle — refresh from DB at most once per interval
  private lastTokenRefresh = 0;
  private readonly TOKEN_REFRESH_INTERVAL = 60_000;
  private rebuildPending = false;

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
    let state = await supabase.getIndexerState();
    const currentBlock = await quai.getBlockNumber();

    // Restore persisted block hash for reorg detection across restarts
    this.lastBlockHash = state.lastBlockHash;

    // Validate the persisted checkpoint before catch-up can overwrite its hash.
    // This closes the offline-reorg window between process runs.
    if (state.lastBlockHash && state.lastIndexedBlock > 0) {
      const divergentHash = await this.confirmCheckpointDivergence(
        state.lastIndexedBlock,
        state.lastBlockHash
      );
      if (divergentHash) {
        logger.error(
          {
            block: state.lastIndexedBlock,
            expected: state.lastBlockHash,
            actual: divergentHash,
          },
          'Offline chain reorg detected — rebuilding indexed state from START_BLOCK'
        );
        await this.resetForRebuild(state);
        state = await supabase.getIndexerState();
      }
    }

    const startBlock = Math.max(
      state.lastIndexedBlock + 1,
      config.indexer.startBlock
    );

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
    logger.info('Indexer stopped');
  }

  private async backfill(fromBlock: number, toBlock: number): Promise<void> {
    logger.info({ fromBlock, toBlock }, 'Starting backfill');
    await supabase.setIsSyncing(true);

    try {
      await runBackfillLoop({
        fromBlock,
        toBlock,
        batchSize: config.indexer.batchSize,
        processBatch: async (start, end) => {
          await withRetry(
            async () => {
              const result = await this.indexBlockRange(start, end);
              await supabase.updateIndexerState(end, result.blockHash);
              this.lastBlockHash = result.blockHash;
            },
            {
              operation: `backfill-batch-${start}-${end}`,
              isRetryable: (error) => !(error instanceof RangeReorgError),
            }
          );
        },
        onProgress: (start, end, pct) => {
          logger.info({ start, end, progress: `${pct}%` }, 'Backfill progress');
        },
      });
      this.rebuildPending = false;
      await supabase.setIsSyncing(false);
    } catch (error) {
      if (!this.rebuildPending) await supabase.setIsSyncing(false);
      throw error;
    }

    logger.info('Backfill complete');
  }

  private async indexBlockRange(
    fromBlock: number,
    toBlock: number
  ): Promise<{ tokensDiscovered: boolean; blockHash: string }> {
    const checkpoint = await supabase.getIndexerState();
    const before = await quai.getBlock(toBlock);
    const result = await processBlockRange(fromBlock, toBlock, {
      trackedWallets: this.trackedWallets,
      trackedTokens: this.trackedTokens,
      notTokenCache: this.notTokenCache,
      onWalletDiscovered: async (walletAddress, event) => {
        const walletLower = walletAddress.toLowerCase();
        const isNew = !this.trackedWallets.has(walletLower);

        if (isNew && this.trackedWallets.size >= config.indexer.walletWarningThreshold) {
          logger.warn(
            { wallet: walletAddress, count: this.trackedWallets.size, threshold: config.indexer.walletWarningThreshold },
            'Tracked wallet count exceeds warning threshold'
          );
        }

        // WalletRegistered signals a pre-existing wallet being added to the factory.
        // Await its earlier history before making the current range checkpointable.
        // This deliberately replays on a batch retry: the writes are idempotent,
        // while a fire-and-forget failure would have no durable retry marker.
        if (event.name === 'WalletRegistered') {
          const historyEnd = event.blockNumber - 1;
          if (historyEnd >= config.indexer.startBlock) {
            await withRetry(
              () => this.backfillWalletHistory(walletLower, config.indexer.startBlock, historyEnd),
              { operation: `registeredWalletHistory(${walletLower})` }
            );
          }
        }

        this.trackedWallets.add(walletLower);
        logger.info({ wallet: walletAddress, block: event.blockNumber, isNew }, 'Discovered wallet');
      },
    });

    const after = await quai.getBlock(toBlock);
    if (before.hash !== after.hash) {
      logger.error(
        { fromBlock, toBlock, beforeHash: before.hash, afterHash: after.hash },
        'Chain changed while processing a block range; discarding derived state'
      );
      await this.resetForRebuild(checkpoint);
      throw new RangeReorgError(`Chain changed while processing blocks ${fromBlock}-${toBlock}`);
    }
    return { ...result, blockHash: after.hash };
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
    // Throttled token refresh — only hit DB if interval elapsed
    if (Date.now() - this.lastTokenRefresh > this.TOKEN_REFRESH_INTERVAL) {
      await this.refreshTrackedTokens();
      this.lastTokenRefresh = Date.now();
    }

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
      const divergentHash = await this.confirmCheckpointDivergence(
        state.lastIndexedBlock,
        this.lastBlockHash
      );
      if (divergentHash) {
        logger.error(
          {
            block: state.lastIndexedBlock,
            expected: this.lastBlockHash,
            actual: divergentHash,
            rebuildFrom: config.indexer.startBlock,
          },
          'Chain reorg detected — rebuilding indexed state from START_BLOCK'
        );

        // Mutable projections outside the module lifecycle are not fully event-sourced,
        // so a partial rollback cannot restore every pre-reorg value safely. Wait for
        // in-flight work, atomically clear derived data, then let the normal
        // backfill path rebuild from the configured start block.
        await this.resetForRebuild(state);
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

      // Reload tracked wallets: merge DB state with in-memory discoveries
      // to avoid losing wallets discovered during the async DB fetch
      const wallets = await supabase.getAllWalletAddresses();
      const newSet = new Set(wallets.map((w) => w.toLowerCase()));
      for (const w of this.trackedWallets) {
        newSet.add(w);
      }
      this.trackedWallets = newSet;

      await this.backfill(startBlock, safeBlock);
    } else {
      logger.info(
        { startBlock, safeBlock, blocksToIndex },
        'Indexing block range'
      );
      const result = await this.indexBlockRange(startBlock, safeBlock);

      // Force-refresh tokens from DB when new tokens were discovered,
      // so the next poll cycle includes them immediately
      if (result.tokensDiscovered) {
        await this.refreshTrackedTokens();
        this.lastTokenRefresh = Date.now();
      }

      // Persist the post-processing fence hash alongside the checkpoint.
      await supabase.updateIndexerState(safeBlock, result.blockHash);
      this.lastBlockHash = result.blockHash;
      if (this.rebuildPending) {
        this.rebuildPending = false;
        await supabase.setIsSyncing(false);
      }
    }

    return { caughtUp: false };
  }

  private async resetForRebuild(
    expected: { lastIndexedBlock: number; lastBlockHash: string | null }
  ): Promise<void> {
    await supabase.resetIndexedData(config.indexer.startBlock, expected);
    this.trackedWallets.clear();
    this.trackedTokens.clear();
    this.notTokenCache.clear();
    await this.seedTokens();
    await this.refreshTrackedTokens();
    this.lastBlockHash = null;
    this.rebuildPending = true;
  }

  private async confirmCheckpointDivergence(
    blockNumber: number,
    expectedHash: string
  ): Promise<string | null> {
    const observed = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt++) {
      const block = await quai.getBlock(blockNumber);
      if (block.hash.toLowerCase() === expectedHash.toLowerCase()) return null;
      observed.add(block.hash);
      if (attempt < 2) await this.sleep(200);
    }
    if (observed.size !== 1) {
      throw new Error(`RPC returned inconsistent hashes for checkpoint block ${blockNumber}`);
    }
    return observed.values().next().value ?? null;
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
      const logs = await withTimeout(
        quai.getLogs(walletAddress, [getAllEventTopics()], start, end),
        config.rpcTimeout.callTimeoutMs,
        `walletBackfill(${walletAddress}, ${start}-${end})`
      );

      logs.sort((a, b) =>
        a.blockNumber !== b.blockNumber
          ? a.blockNumber - b.blockNumber
          : a.index - b.index
      );

      for (const log of logs) {
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
   * Reload tracked tokens from the database, mutating the existing Map in-place.
   * Must mutate (not replace) so that processBlockRange's ctx.trackedTokens reference
   * stays valid when this is called via the refreshTrackedTokens callback mid-batch.
   */
  private async refreshTrackedTokens(): Promise<void> {
    const tokens = await supabase.getAllTokens();
    this.trackedTokens.clear();
    tokens.forEach((t) => this.trackedTokens.set(t.address.toLowerCase(), t.standard));
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
