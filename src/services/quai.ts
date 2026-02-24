import { quais, JsonRpcProvider, Shard, Log, ZeroAddress } from 'quais';
import { LRUCache } from 'lru-cache';
import { config } from '../config.js';
import { withRetry } from '../utils/retry.js';
import { SlidingWindowRateLimiter } from '../utils/rate-limiter.js';
import { withTimeout } from '../utils/timeout.js';
import { logger } from '../utils/logger.js';
import { IndexerLog } from '../types/index.js';

// RPC connection health thresholds
const RPC_HEALTH = {
  staleThresholdMs: 60000,     // Consider unhealthy if no success for 1 minute
  failureThreshold: 3,         // Consider unhealthy when >= 3 of last 10 calls failed
  windowSize: 10,              // Sliding window for health assessment
};

class QuaiService {
  private wsProvider: quais.WebSocketProvider | null = null;
  private provider: JsonRpcProvider;

  // O(1) rate limiter (replaces the old requestTimestamps[] array)
  private rateLimiter: SlidingWindowRateLimiter;

  // Block timestamp cache
  private timestampCache: LRUCache<number, number>;

  // RPC health tracking with sliding window (not just consecutive failures)
  private lastSuccessfulCall: number = Date.now();
  private recentOutcomes: boolean[] = [];
  private outcomeIndex = 0;

  constructor() {
    this.provider = new JsonRpcProvider(config.quai.rpcUrl, undefined, {
      usePathing: true,
    });
    this.rateLimiter = new SlidingWindowRateLimiter(
      config.rateLimit.windowMs,
      config.rateLimit.requestsPerWindow
    );
    this.timestampCache = new LRUCache<number, number>({
      max: config.cache.timestampCacheSize,
    });
    logger.debug({ rpcUrl: config.quai.rpcUrl }, 'QuaiService initialized with JsonRpcProvider');
  }

  /**
   * Check if the RPC connection appears healthy based on recent activity.
   * Uses a sliding window of recent outcomes rather than just consecutive failures,
   * so a single success after many failures doesn't immediately report healthy.
   */
  isHealthy(): boolean {
    const timeSinceSuccess = Date.now() - this.lastSuccessfulCall;
    const isStale = timeSinceSuccess > RPC_HEALTH.staleThresholdMs;

    const failureCount = this.recentOutcomes.filter((o) => !o).length;
    const tooManyFailures = failureCount >= RPC_HEALTH.failureThreshold;

    return !isStale && !tooManyFailures;
  }

  getConnectionStats(): {
    lastSuccessfulCall: number;
    recentFailures: number;
    isHealthy: boolean;
    msSinceLastSuccess: number;
  } {
    return {
      lastSuccessfulCall: this.lastSuccessfulCall,
      recentFailures: this.recentOutcomes.filter((o) => !o).length,
      isHealthy: this.isHealthy(),
      msSinceLastSuccess: Date.now() - this.lastSuccessfulCall,
    };
  }

  private recordOutcome(success: boolean): void {
    this.recentOutcomes[this.outcomeIndex % RPC_HEALTH.windowSize] = success;
    this.outcomeIndex++;
    if (success) {
      this.lastSuccessfulCall = Date.now();
    } else {
      const failures = this.recentOutcomes.filter((o) => !o).length;
      if (failures === RPC_HEALTH.failureThreshold) {
        logger.warn(
          {
            recentFailures: failures,
            msSinceLastSuccess: Date.now() - this.lastSuccessfulCall,
          },
          'RPC connection degraded - multiple recent failures'
        );
      }
    }
  }

  /**
   * Execute an RPC operation with retry, tracking success/failure for health monitoring.
   */
  private async withTrackedRetry<T>(fn: () => Promise<T>, operation: string): Promise<T> {
    try {
      const result = await withRetry(fn, { operation });
      this.recordOutcome(true);
      return result;
    } catch (err) {
      this.recordOutcome(false);
      throw err;
    }
  }

  async getBlockNumber(): Promise<number> {
    await this.rateLimiter.acquire();
    return this.withTrackedRetry(
      () => withTimeout(
        this.provider.getBlockNumber(Shard.Cyprus1),
        config.rpcTimeout.callTimeoutMs,
        'getBlockNumber'
      ),
      'getBlockNumber'
    );
  }

  async getLogs(
    address: string | string[],
    topics: (string | string[] | null)[],
    fromBlock: number,
    toBlock: number
  ): Promise<IndexerLog[]> {
    await this.rateLimiter.acquire();

    // Normalize addresses to lowercase for downstream DB consistency
    const normalizedAddress = Array.isArray(address)
      ? address.map(a => a.toLowerCase())
      : address.toLowerCase();

    return this.withTrackedRetry(async () => {
      const logs = await withTimeout(
        this.provider.getLogs({
          address: normalizedAddress,
          topics,
          fromBlock,
          toBlock,
          nodeLocation: [0, 0],  // Cyprus1
        }),
        config.rpcTimeout.callTimeoutMs,
        'getLogs'
      );
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
    await this.rateLimiter.acquire();
    return this.withTrackedRetry(async () => {
      const selector = quais.id(functionSignature).slice(0, 10);
      return withTimeout(
        this.provider.call({ from: ZeroAddress, to: address, data: selector }),
        config.rpcTimeout.callTimeoutMs,
        'callContract'
      );
    }, 'callContract');
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    const cached = this.timestampCache.get(blockNumber);
    if (cached !== undefined) {
      return cached;
    }

    await this.rateLimiter.acquire();
    const timestamp = await this.withTrackedRetry(async () => {
      const block = await withTimeout(
        this.provider.getBlock(Shard.Cyprus1, blockNumber),
        config.rpcTimeout.callTimeoutMs,
        'getBlockTimestamp'
      );
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

    this.timestampCache.set(blockNumber, timestamp);
    return timestamp;
  }

  /**
   * Fetch a block by number, returning its hash for reorg detection.
   */
  async getBlock(blockNumber: number): Promise<{ hash: string; parentHash: string[] } | null> {
    await this.rateLimiter.acquire();
    return this.withTrackedRetry(async () => {
      const block = await withTimeout(
        this.provider.getBlock(Shard.Cyprus1, blockNumber),
        config.rpcTimeout.callTimeoutMs,
        'getBlock'
      );
      if (!block) return null;
      return {
        hash: block.hash!,
        parentHash: block.header.parentHash,
      };
    }, 'getBlock');
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
