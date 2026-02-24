import { quais, JsonRpcProvider, Shard, Log, ZeroAddress } from 'quais';
import { config } from '../config.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { IndexerLog } from '../types/index.js';

// RPC connection health thresholds
const RPC_HEALTH = {
  staleThresholdMs: 60000,     // Consider unhealthy if no success for 1 minute
  failureThreshold: 3,         // Consider unhealthy after 3 consecutive failures
};

class QuaiService {
  private wsProvider: quais.WebSocketProvider | null = null;
  private provider: JsonRpcProvider;

  // Rate limiting state
  private requestTimestamps: number[] = [];

  // Block timestamp cache with proper LRU eviction
  // Map maintains insertion order; we re-insert on access to maintain LRU
  private timestampCache: Map<number, number> = new Map();

  // RPC connection state tracking
  private lastSuccessfulCall: number = Date.now(); // Assume healthy at start
  private consecutiveFailures: number = 0;

  constructor() {
    this.provider = new JsonRpcProvider(config.quai.rpcUrl, undefined, {
      usePathing: true,
      batchMaxCount: 1,   // Disable batching — preserve 1:1 rate limiting
      cacheTimeout: -1,   // Disable caching — health checks need fresh block numbers
    });
    logger.debug({ rpcUrl: config.quai.rpcUrl }, 'QuaiService initialized with JsonRpcProvider');
  }

  /**
   * Check if the RPC connection appears healthy based on recent activity.
   * Returns true if we've had a successful call recently or haven't hit failure threshold.
   */
  isHealthy(): boolean {
    const timeSinceSuccess = Date.now() - this.lastSuccessfulCall;
    const isStale = timeSinceSuccess > RPC_HEALTH.staleThresholdMs;
    const tooManyFailures = this.consecutiveFailures >= RPC_HEALTH.failureThreshold;

    return !isStale && !tooManyFailures;
  }

  /**
   * Get RPC connection statistics for health reporting.
   */
  getConnectionStats(): {
    lastSuccessfulCall: number;
    consecutiveFailures: number;
    isHealthy: boolean;
    msSinceLastSuccess: number;
  } {
    return {
      lastSuccessfulCall: this.lastSuccessfulCall,
      consecutiveFailures: this.consecutiveFailures,
      isHealthy: this.isHealthy(),
      msSinceLastSuccess: Date.now() - this.lastSuccessfulCall,
    };
  }

  /**
   * Record a successful RPC call - resets failure counter and updates timestamp.
   */
  private recordSuccess(): void {
    this.lastSuccessfulCall = Date.now();
    this.consecutiveFailures = 0;
  }

  /**
   * Record a failed RPC call (after all retries exhausted).
   */
  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === RPC_HEALTH.failureThreshold) {
      logger.warn(
        {
          consecutiveFailures: this.consecutiveFailures,
          msSinceLastSuccess: Date.now() - this.lastSuccessfulCall,
        },
        'RPC connection degraded - multiple consecutive failures'
      );
    }
  }

  /**
   * Execute an RPC operation with retry, tracking success/failure for health monitoring.
   */
  private async withTrackedRetry<T>(fn: () => Promise<T>, operation: string): Promise<T> {
    try {
      const result = await withRetry(fn, { operation });
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  // Rate limiter: ensures we don't exceed RPC rate limits
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const windowMs = config.rateLimit.windowMs;
    const maxRequests = config.rateLimit.requestsPerWindow;

    // Remove timestamps outside the current window
    this.requestTimestamps = this.requestTimestamps.filter(
      (ts) => now - ts < windowMs
    );

    if (this.requestTimestamps.length >= maxRequests) {
      // Wait until the oldest request exits the window
      const waitTime = windowMs - (now - this.requestTimestamps[0]);
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.requestTimestamps.push(Date.now());
  }

  async getBlockNumber(): Promise<number> {
    await this.rateLimit();
    return this.withTrackedRetry(
      () => this.provider.getBlockNumber(Shard.Cyprus1),
      'getBlockNumber'
    );
  }

  async getLogs(
    address: string | string[],
    topics: (string | string[] | null)[],
    fromBlock: number,
    toBlock: number
  ): Promise<IndexerLog[]> {
    await this.rateLimit();

    // Normalize addresses to lowercase for downstream DB consistency
    const normalizedAddress = Array.isArray(address)
      ? address.map(a => a.toLowerCase())
      : address.toLowerCase();

    return this.withTrackedRetry(async () => {
      const logs = await this.provider.getLogs({
        address: normalizedAddress,
        topics,
        fromBlock,
        toBlock,
        nodeLocation: [0, 0],  // Cyprus1
      });
      return logs.map((log: Log) => ({
        address: log.address.toLowerCase(),
        topics: Array.from(log.topics),
        data: log.data,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        blockHash: log.blockHash,
        index: log.index,
        removed: log.removed,
      }));
    }, 'getLogs');
  }

  async callContract(address: string, functionSignature: string): Promise<string> {
    await this.rateLimit();
    return this.withTrackedRetry(async () => {
      const selector = quais.id(functionSignature).slice(0, 10);
      return this.provider.call({ from: ZeroAddress, to: address, data: selector });
    }, 'callContract');
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    // Check cache first
    const cached = this.timestampCache.get(blockNumber);
    if (cached !== undefined) {
      // Re-insert to maintain LRU order (moves to end of Map)
      this.timestampCache.delete(blockNumber);
      this.timestampCache.set(blockNumber, cached);
      return cached;
    }

    await this.rateLimit();
    const timestamp = await this.withTrackedRetry(async () => {
      const block = await this.provider.getBlock(Shard.Cyprus1, blockNumber);
      if (!block) {
        throw new Error(`Block ${blockNumber} not found`);
      }
      // woHeader.timestamp is a number at runtime (SDK parses it during formatBlock),
      // despite the type declaration saying string
      const raw = block.woHeader.timestamp;
      const ts = typeof raw === 'string' ? parseInt(raw, 16) : Number(raw);
      if (!Number.isFinite(ts) || ts < 0) {
        throw new Error(`Invalid timestamp for block ${blockNumber}: ${raw}`);
      }
      return ts;
    }, 'getBlockTimestamp');

    // Cache the result (with LRU eviction)
    if (this.timestampCache.size >= config.cache.timestampCacheSize) {
      // Delete the oldest entry (first key in Map)
      const oldestKey = this.timestampCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.timestampCache.delete(oldestKey);
      }
    }
    this.timestampCache.set(blockNumber, timestamp);

    return timestamp;
  }

  async subscribeToEvents(
    addresses: string[],
    topics: string[],
    callback: (log: IndexerLog) => void
  ): Promise<void> {
    if (!this.wsProvider) {
      this.wsProvider = new quais.WebSocketProvider(config.quai.wsUrl, undefined, {
        usePathing: true,
      });
    }

    const filter = {
      address: addresses,
      topics: [topics],
    };

    this.wsProvider.on(filter, callback);
    logger.info({ addresses: addresses.length, topics }, 'Subscribed to events');
  }

  async unsubscribe(): Promise<void> {
    if (this.wsProvider) {
      await this.wsProvider.destroy();
      this.wsProvider = null;
    }
  }
}

export const quai = new QuaiService();
