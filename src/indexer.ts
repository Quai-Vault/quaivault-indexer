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

// Circuit breaker configuration
const CIRCUIT_BREAKER = {
  failureThreshold: 10,    // Open circuit after this many consecutive failures
  cooldownMs: 60000,       // Wait 1 minute before retrying after circuit opens
};

export class Indexer {
  private isRunning = false;
  // Set of lowercase wallet addresses for tracking
  private trackedWallets: Set<string> = new Set();
  // Retry tracker for poll loop resilience
  private pollRetryTracker = new RetryTracker();
  // Circuit breaker state
  private circuitBreaker = {
    failures: 0,
    isOpen: false,
    openUntil: 0,
  };

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
          const walletLower = walletAddress.toLowerCase();
          const isNew = !this.trackedWallets.has(walletLower);
          this.trackedWallets.add(walletLower);
          health.setTrackedWalletsCount(this.trackedWallets.size);
          logger.info({ wallet: walletAddress, block: event.blockNumber }, 'Discovered new wallet');

          // WalletRegistered signals a pre-existing wallet being added to the factory.
          // Backfill its on-chain history prior to the registration block so no
          // events are missed from before it became tracked.
          if (event.name === 'WalletRegistered' && isNew) {
            const historyEnd = event.blockNumber - 1;
            if (historyEnd >= config.indexer.startBlock) {
              await this.backfillWalletHistory(walletLower, config.indexer.startBlock, historyEnd);
            }
          }
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
      // Check circuit breaker before attempting
      if (!this.checkCircuitBreaker()) {
        const waitTime = this.circuitBreaker.openUntil - Date.now();
        logger.debug({ waitMs: waitTime }, 'Circuit breaker open, waiting');
        await this.sleep(Math.min(waitTime, config.indexer.pollInterval));
        continue;
      }

      try {
        await this.pollOnce();
        this.pollRetryTracker.recordSuccess();
        this.recordCircuitBreakerSuccess();
      } catch (error) {
        const retryDelay = this.pollRetryTracker.recordFailure(
          error as Error,
          'poll'
        );
        this.recordCircuitBreakerFailure();

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
        await this.indexBlockRange(startBlock, safeBlock);
        await supabase.updateIndexerState(safeBlock);
      }
    }
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
            err: error.message
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

  /**
   * Check if circuit breaker allows operation.
   * Returns true if allowed, false if circuit is open.
   */
  private checkCircuitBreaker(): boolean {
    if (this.circuitBreaker.isOpen) {
      if (Date.now() < this.circuitBreaker.openUntil) {
        return false; // Circuit still open, skip attempt
      }
      // Cooldown expired, allow retry (half-open state)
      logger.info('Circuit breaker cooldown expired, attempting recovery');
      this.circuitBreaker.isOpen = false;
      this.circuitBreaker.failures = 0;
      // Keep health service informed - still in half-open state
      // Will be fully reset on success via recordCircuitBreakerSuccess()
    }
    return true;
  }

  /**
   * Record a failure and potentially open the circuit breaker.
   */
  private recordCircuitBreakerFailure(): void {
    this.circuitBreaker.failures++;

    if (this.circuitBreaker.failures >= CIRCUIT_BREAKER.failureThreshold) {
      this.circuitBreaker.isOpen = true;
      this.circuitBreaker.openUntil = Date.now() + CIRCUIT_BREAKER.cooldownMs;
      // Notify health service to avoid hammering RPC during health checks
      health.setRpcCircuitBreakerOpen(true);
      logger.warn(
        {
          failures: this.circuitBreaker.failures,
          cooldownMs: CIRCUIT_BREAKER.cooldownMs,
        },
        'Circuit breaker opened - pausing indexer'
      );
    }
  }

  /**
   * Record a success and reset circuit breaker state.
   */
  private recordCircuitBreakerSuccess(): void {
    if (this.circuitBreaker.failures > 0) {
      logger.info(
        { previousFailures: this.circuitBreaker.failures },
        'Circuit breaker: operation succeeded after failures'
      );
    }
    this.circuitBreaker.failures = 0;
    if (this.circuitBreaker.isOpen) {
      // Notify health service that RPC is healthy again
      health.setRpcCircuitBreakerOpen(false);
    }
    this.circuitBreaker.isOpen = false;
  }
}
