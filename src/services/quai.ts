import { quais, JsonRpcProvider, Shard, Log, ZeroAddress } from 'quais';
import { LRUCache } from 'lru-cache';
import { config } from '../config.js';
import { withRetry } from '../utils/retry.js';
import { SlidingWindowRateLimiter } from '../utils/rate-limiter.js';
import { withTimeout } from '../utils/timeout.js';
import { logger } from '../utils/logger.js';
import { IndexerLog } from '../types/index.js';

// Cached ABI coder instance (avoid re-creating per call)
const abiCoder = quais.AbiCoder.defaultAbiCoder();

// RPC connection health thresholds
const RPC_HEALTH = {
  staleThresholdMs: 60000,     // Consider unhealthy if no success for 1 minute
  failureThreshold: 3,         // Consider unhealthy when >= 3 of last 10 calls failed
  windowSize: 10,              // Sliding window for health assessment
};

class QuaiService {
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
    try {
      logger.debug({ rpcHost: new URL(config.quai.rpcUrl).hostname }, 'QuaiService initialized with JsonRpcProvider');
    } catch {
      logger.debug('QuaiService initialized with JsonRpcProvider');
    }
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
  private async withTrackedRetry<T>(
    fn: () => Promise<T>,
    operation: string,
    retryOpts?: { isRetryable?: (error: Error) => boolean }
  ): Promise<T> {
    try {
      const result = await withRetry(fn, { operation, ...retryOpts });
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
    address: string | string[] | null,
    topics: (string | string[] | null)[],
    fromBlock: number,
    toBlock: number
  ): Promise<IndexerLog[]> {
    await this.rateLimiter.acquire();

    // Normalize addresses to lowercase for downstream DB consistency.
    // null = no address filter (match all contracts) — used for wildcard Transfer scans.
    const normalizedAddress = address === null
      ? undefined
      : Array.isArray(address)
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
    }, 'callContract', {
      // CALL_EXCEPTION is permanent (contract doesn't implement the function) — don't retry
      isRetryable: (err) => (err as { code?: string }).code !== 'CALL_EXCEPTION',
    });
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
      if (!block.hash) {
        logger.error({ blockNumber }, 'Block hash missing');
        return null;
      }
      return {
        hash: block.hash,
        parentHash: block.header.parentHash,
      };
    }, 'getBlock');
  }

  /**
   * Probe a contract for ERC20 metadata by calling symbol(), decimals(), name().
   * Returns null if any call fails (contract is not ERC20 or reverted).
   * Sanitizes returned metadata to prevent malicious contract responses.
   */
  async getERC20Metadata(contractAddress: string): Promise<{
    symbol: string;
    decimals: number;
    name: string;
  } | null> {
    try {
      const [symbolRaw, decimalsRaw, nameRaw] = await Promise.all([
        this.callContract(contractAddress, 'symbol()'),
        this.callContract(contractAddress, 'decimals()'),
        this.callContract(contractAddress, 'name()'),
      ]);

      // Decode ABI-encoded string responses
      const symbol = abiCoder.decode(['string'], symbolRaw)[0] as string;
      const name = abiCoder.decode(['string'], nameRaw)[0] as string;
      const decimals = Number(abiCoder.decode(['uint8'], decimalsRaw)[0]);

      // Sanitize metadata to prevent malicious contract responses.
      // Symbol: alphanumeric + common token chars only (prevents Unicode homograph attacks)
      // Name: printable ASCII (more permissive since names are descriptive, not identifiers)
      const sanitizedSymbol = symbol
        .replace(/[^a-zA-Z0-9.\-_]/g, '')
        .slice(0, 32);
      const sanitizedName = name
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 128);

      if (!sanitizedSymbol || !sanitizedName) {
        logger.debug({ contractAddress }, 'ERC20 probe returned empty symbol or name');
        return null;
      }

      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
        logger.debug({ contractAddress, decimals }, 'ERC20 probe returned invalid decimals');
        return null;
      }

      return { symbol: sanitizedSymbol, decimals, name: sanitizedName };
    } catch {
      // Contract doesn't implement ERC20 metadata or reverted
      return null;
    }
  }

  /**
   * Probe a contract for ERC721 metadata by calling symbol() and name().
   * Returns null if any call fails (contract is not ERC721 or reverted).
   * Sanitizes returned metadata to prevent malicious contract responses.
   */
  async getERC721Metadata(contractAddress: string): Promise<{
    symbol: string;
    name: string;
  } | null> {
    try {
      const [symbolRaw, nameRaw] = await Promise.all([
        this.callContract(contractAddress, 'symbol()'),
        this.callContract(contractAddress, 'name()'),
      ]);

      const symbol = abiCoder.decode(['string'], symbolRaw)[0] as string;
      const name = abiCoder.decode(['string'], nameRaw)[0] as string;

      const sanitizedSymbol = symbol
        .replace(/[^a-zA-Z0-9.\-_]/g, '')
        .slice(0, 32);
      const sanitizedName = name
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 128);

      if (!sanitizedSymbol || !sanitizedName) {
        logger.debug({ contractAddress }, 'ERC721 probe returned empty symbol or name');
        return null;
      }

      return { symbol: sanitizedSymbol, name: sanitizedName };
    } catch {
      // Contract doesn't implement ERC721 metadata or reverted
      return null;
    }
  }

  /**
   * Probe a contract for ERC1155 metadata.
   * ERC1155 contracts use uri(uint256) instead of name()/symbol(), but many
   * implementations (e.g. OpenZeppelin) add optional name()/symbol() extensions.
   * Strategy: try symbol()/name() first, fall back to uri(0) to confirm ERC1155.
   * Returns null if the contract doesn't look like an ERC1155 at all.
   */
  async getERC1155Metadata(contractAddress: string): Promise<{
    symbol: string;
    name: string;
  } | null> {
    // Try symbol()/name() first (many ERC1155s support these as optional extensions)
    try {
      const [symbolRaw, nameRaw] = await Promise.all([
        this.callContract(contractAddress, 'symbol()'),
        this.callContract(contractAddress, 'name()'),
      ]);

      const symbol = abiCoder.decode(['string'], symbolRaw)[0] as string;
      const name = abiCoder.decode(['string'], nameRaw)[0] as string;

      const sanitizedSymbol = symbol
        .replace(/[^a-zA-Z0-9.\-_]/g, '')
        .slice(0, 32);
      const sanitizedName = name
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 128);

      if (sanitizedSymbol && sanitizedName) {
        return { symbol: sanitizedSymbol, name: sanitizedName };
      }
    } catch {
      // symbol()/name() not implemented — try uri() fallback
    }

    // Fallback: call uri(0) to confirm it's an ERC1155 contract.
    // callContract() only handles no-arg signatures, so we encode manually.
    try {
      const selector = quais.id('uri(uint256)').slice(0, 10);
      const encodedArg = abiCoder.encode(['uint256'], [0]);
      const calldata = selector + encodedArg.slice(2);

      await this.rateLimiter.acquire();
      await this.withTrackedRetry(async () => {
        return withTimeout(
          this.provider.call({
            from: ZeroAddress,
            to: contractAddress,
            data: calldata,
          }),
          config.rpcTimeout.callTimeoutMs,
          'getERC1155Metadata/uri'
        );
      }, 'getERC1155Metadata/uri');

      // uri() responded — this is likely an ERC1155. Use address-based fallback names.
      const shortAddr = contractAddress.slice(0, 10);
      return {
        symbol: `ERC1155-${shortAddr}`,
        name: `ERC1155 Token (${contractAddress})`,
      };
    } catch {
      // Not an ERC1155 contract
      return null;
    }
  }

}

export const quai = new QuaiService();
