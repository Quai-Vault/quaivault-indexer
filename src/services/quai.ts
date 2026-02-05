import { quais, FetchRequest } from 'quais';
import { config } from '../config.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import {
  validateBlockNumberResponse,
  validateLogsResponse,
  validateCallResponse,
  validateBlockTimestampResponse,
} from '../utils/validation.js';
import { IndexerLog } from '../types/index.js';

class QuaiService {
  private wsProvider: quais.WebSocketProvider | null = null;
  private rpcUrl: string;

  // Rate limiting state
  private requestTimestamps: number[] = [];

  // Block timestamp cache with proper LRU eviction
  // Map maintains insertion order; we re-insert on access to maintain LRU
  private timestampCache: Map<number, number> = new Map();

  constructor() {
    // FetchRequest needs the full URL with shard path, unlike JsonRpcProvider with usePathing
    // Auto-append /cyprus1 if not present (base URL pattern for SDK compatibility)
    const baseUrl = config.quai.rpcUrl;
    if (baseUrl.match(/\/(cyprus|paxos|hydra)\d+\/?$/i)) {
      this.rpcUrl = baseUrl;
    } else {
      this.rpcUrl = baseUrl.replace(/\/$/, '') + '/cyprus1';
    }
    logger.debug({ rpcUrl: this.rpcUrl }, 'QuaiService initialized with RPC URL');
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
    return withRetry(async () => {
      const req = new FetchRequest(this.rpcUrl);
      req.body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'quai_blockNumber',
        params: [],
        id: 1,
      });
      req.setHeader('Content-Type', 'application/json');
      const response = await req.send();
      const json = JSON.parse(response.bodyText);
      return validateBlockNumberResponse(json);
    });
  }

  async getLogs(
    address: string | string[],
    topics: (string | string[] | null)[],
    fromBlock: number,
    toBlock: number
  ): Promise<IndexerLog[]> {
    await this.rateLimit();

    // Normalize addresses to lowercase for RPC compatibility
    // Some RPC providers are case-sensitive when filtering by address
    const normalizedAddress = Array.isArray(address)
      ? address.map(a => a.toLowerCase())
      : address.toLowerCase();

    return withRetry(async () => {
      const req = new FetchRequest(this.rpcUrl);
      const params = {
        address: normalizedAddress,
        topics,
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
      };
      req.body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'quai_getLogs',
        params: [params],
        id: 1,
      });
      req.setHeader('Content-Type', 'application/json');
      const response = await req.send();
      const json = JSON.parse(response.bodyText);

      // Validate and parse response with strict schema validation
      const validatedLogs = validateLogsResponse(json);

      // Convert validated logs to quais.Log format
      return validatedLogs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: parseInt(log.blockNumber, 16),
        transactionHash: log.transactionHash,
        transactionIndex: parseInt(log.transactionIndex, 16),
        blockHash: log.blockHash,
        index: parseInt(log.logIndex, 16),
        removed: log.removed,
      }));
    });
  }

  async callContract(address: string, functionSignature: string): Promise<string> {
    await this.rateLimit();
    return withRetry(async () => {
      const selector = quais.id(functionSignature).slice(0, 10);
      const req = new FetchRequest(this.rpcUrl);
      req.body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'quai_call',
        params: [{ to: address, data: selector }, 'latest'],
        id: 1,
      });
      req.setHeader('Content-Type', 'application/json');
      const response = await req.send();
      const json = JSON.parse(response.bodyText);

      return validateCallResponse(json);
    });
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
    const timestamp = await withRetry(async () => {
      const req = new FetchRequest(this.rpcUrl);
      req.body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'quai_getBlockByNumber',
        params: ['0x' + blockNumber.toString(16), false],
        id: 1,
      });
      req.setHeader('Content-Type', 'application/json');
      const response = await req.send();
      const json = JSON.parse(response.bodyText);

      return validateBlockTimestampResponse(json, blockNumber);
    });

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
