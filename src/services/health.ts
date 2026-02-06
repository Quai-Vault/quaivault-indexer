import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { quai } from './quai.js';
import { supabase } from './supabase.js';
import { logger } from '../utils/logger.js';

// Allowed CORS origins for health check endpoint
const ALLOWED_ORIGINS = [
  'http://localhost:5173',         // Local dev
  'https://testnet.quaivault.org', // Testnet production
  'https://quaivault.org',         // Mainnet production
];

// Rate limiting configuration
const RATE_LIMIT = {
  windowMs: 60000,           // 1 minute window
  maxRequests: 60,           // 60 requests per minute per IP
  cleanupIntervalMs: 300000, // Clean up old entries every 5 minutes
  maxIPs: 10000,             // Cap on unique IPs tracked (prevents memory DoS)
};

// Health check timeout (prevents hanging health checks)
// Increased to 10s to handle slow/congested RPC endpoints
const HEALTH_CHECK_TIMEOUT_MS = 10000;

/**
 * Wraps a promise with a timeout.
 * Rejects if the promise doesn't resolve within the specified time.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${name} timeout after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  checks: {
    quaiRpc: CheckResult;
    supabase: CheckResult;
    indexer: CheckResult;
  };
  details: {
    currentBlock: number | null;
    lastIndexedBlock: number | null;
    blocksBehind: number | null;
    isSyncing: boolean;
    trackedWallets: number;
  };
}

interface CheckResult {
  status: 'pass' | 'fail';
  message?: string;
}

class HealthService {
  private server: Server | null = null;
  private trackedWalletsCount = 0;
  private isIndexerRunning = false;
  private rpcCircuitBreakerOpen = false;

  // Rate limiting: Map of IP -> array of request timestamps
  private rateLimitMap: Map<string, number[]> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  setTrackedWalletsCount(count: number): void {
    this.trackedWalletsCount = count;
  }

  setIndexerRunning(running: boolean): void {
    this.isIndexerRunning = running;
  }

  /**
   * Set the RPC circuit breaker state.
   * When open, health checks will report degraded status without hammering the RPC.
   */
  setRpcCircuitBreakerOpen(isOpen: boolean): void {
    if (this.rpcCircuitBreakerOpen !== isOpen) {
      logger.info({ isOpen }, 'RPC circuit breaker state changed');
    }
    this.rpcCircuitBreakerOpen = isOpen;
  }

  /**
   * Extract client IP from request, handling proxies
   */
  private getClientIp(req: IncomingMessage): string {
    // Check X-Forwarded-For header (for reverse proxies)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      // Take the first IP (original client)
      return ips.split(',')[0].trim();
    }

    // Fallback to socket remote address
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * Check if request should be rate limited
   * Returns true if request is allowed, false if rate limited
   */
  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT.windowMs;

    // Enforce size cap to prevent memory DoS
    if (this.rateLimitMap.size >= RATE_LIMIT.maxIPs && !this.rateLimitMap.has(ip)) {
      // Evict oldest entry (first in Map iteration order)
      const oldestIp = this.rateLimitMap.keys().next().value;
      if (oldestIp) {
        this.rateLimitMap.delete(oldestIp);
      }
    }

    // Get or create request history for this IP
    let requests = this.rateLimitMap.get(ip) || [];

    // Filter out requests outside the current window
    requests = requests.filter(timestamp => timestamp > windowStart);

    // Check if we're over the limit
    if (requests.length >= RATE_LIMIT.maxRequests) {
      // Update the map with filtered requests
      this.rateLimitMap.set(ip, requests);
      return false;
    }

    // Add current request and update map
    requests.push(now);
    this.rateLimitMap.set(ip, requests);
    return true;
  }

  /**
   * Send rate limit exceeded response
   */
  private sendRateLimitResponse(res: ServerResponse, headers: Record<string, string>): void {
    const retryAfter = Math.ceil(RATE_LIMIT.windowMs / 1000);
    res.writeHead(429, {
      ...headers,
      'Retry-After': String(retryAfter),
    });
    res.end(JSON.stringify({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Maximum ${RATE_LIMIT.maxRequests} requests per minute.`,
      retryAfter,
    }));
  }

  /**
   * Clean up old rate limit entries to prevent memory growth
   */
  private cleanupRateLimitMap(): void {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT.windowMs;

    for (const [ip, requests] of this.rateLimitMap.entries()) {
      const validRequests = requests.filter(ts => ts > windowStart);
      if (validRequests.length === 0) {
        this.rateLimitMap.delete(ip);
      } else {
        this.rateLimitMap.set(ip, validRequests);
      }
    }
  }

  private getCorsHeaders(origin: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
    }

    return headers;
  }

  async start(): Promise<void> {
    if (!config.health.enabled) {
      logger.info('Health check endpoint disabled');
      return;
    }

    // Start rate limit cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupRateLimitMap();
    }, RATE_LIMIT.cleanupIntervalMs);

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Generate unique request ID for tracing
      const requestId = randomUUID();
      const origin = req.headers.origin;
      const corsHeaders = this.getCorsHeaders(origin);
      const clientIp = this.getClientIp(req);

      // Add request ID to all responses for tracing
      const headersWithTracing = {
        ...corsHeaders,
        'X-Request-Id': requestId,
      };

      // Handle CORS preflight requests (don't rate limit these)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, headersWithTracing);
        res.end();
        return;
      }

      // Apply rate limiting
      if (!this.checkRateLimit(clientIp)) {
        logger.warn({ requestId, ip: clientIp, url: req.url }, 'Rate limit exceeded');
        this.sendRateLimitResponse(res, headersWithTracing);
        return;
      }

      if (req.url === '/health' && req.method === 'GET') {
        await this.handleHealthCheck(res, headersWithTracing, requestId);
      } else if (req.url === '/ready' && req.method === 'GET') {
        await this.handleReadinessCheck(res, headersWithTracing, requestId);
      } else if (req.url === '/live' && req.method === 'GET') {
        this.handleLivenessCheck(res, headersWithTracing, requestId);
      } else {
        res.writeHead(404, headersWithTracing);
        res.end(JSON.stringify({ error: 'Not found', requestId }));
      }
    });

    this.server.listen(config.health.port, () => {
      logger.info({ port: config.health.port }, 'Health check server started with rate limiting');
    });
  }

  async stop(): Promise<void> {
    // Clear rate limit cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Clear rate limit map
    this.rateLimitMap.clear();

    if (this.server) {
      return new Promise((resolve) => {
        // Set a timeout to force close if graceful shutdown takes too long
        const timeout = setTimeout(() => {
          logger.warn('Health check server close timeout, forcing shutdown');
          resolve();
        }, 5000);

        this.server!.close(() => {
          clearTimeout(timeout);
          logger.info('Health check server stopped');
          resolve();
        });

        // Close all active connections (Node 18.2+)
        if (typeof this.server!.closeAllConnections === 'function') {
          this.server!.closeAllConnections();
        }
      });
    }
  }

  private async handleHealthCheck(res: ServerResponse, headers: Record<string, string>, requestId: string): Promise<void> {
    const health = await this.getHealthStatus();
    const statusCode = health.status === 'healthy' ? 200 : 503;

    res.writeHead(statusCode, headers);
    res.end(JSON.stringify({ ...health, requestId }, null, 2));
  }

  private async handleReadinessCheck(res: ServerResponse, headers: Record<string, string>, requestId: string): Promise<void> {
    const health = await this.getHealthStatus();
    const isReady =
      health.checks.quaiRpc.status === 'pass' &&
      health.checks.supabase.status === 'pass' &&
      health.checks.indexer.status === 'pass';

    const statusCode = isReady ? 200 : 503;
    res.writeHead(statusCode, headers);
    res.end(JSON.stringify({ ready: isReady, requestId }));
  }

  private handleLivenessCheck(res: ServerResponse, headers: Record<string, string>, requestId: string): void {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ alive: true, requestId }));
  }

  private async getHealthStatus(): Promise<HealthStatus> {
    // Fetch block number and indexer state in parallel, caching results for reuse
    const { quaiRpcCheck, currentBlock } = await this.checkQuaiRpc();
    const { supabaseCheck, indexerState } = await this.checkSupabase();
    let indexerCheck: CheckResult = { status: 'pass' };

    let lastIndexedBlock: number | null = null;
    let blocksBehind: number | null = null;
    let isSyncing = false;

    if (indexerState) {
      lastIndexedBlock = indexerState.lastIndexedBlock;
      isSyncing = indexerState.isSyncing;
    }

    // Calculate blocks behind
    if (currentBlock !== null && lastIndexedBlock !== null) {
      blocksBehind = currentBlock - lastIndexedBlock - config.indexer.confirmations;
      blocksBehind = Math.max(0, blocksBehind);

      // Check if indexer is too far behind
      if (blocksBehind > config.health.maxBlocksBehind && !isSyncing) {
        indexerCheck = {
          status: 'fail',
          message: `Indexer is ${blocksBehind} blocks behind (max: ${config.health.maxBlocksBehind})`,
        };
      }
    }

    // Check if indexer is running
    if (!this.isIndexerRunning) {
      indexerCheck = {
        status: 'fail',
        message: 'Indexer is not running',
      };
    }

    const checks = {
      quaiRpc: quaiRpcCheck,
      supabase: supabaseCheck,
      indexer: indexerCheck,
    };

    const allPassing = Object.values(checks).every((c) => c.status === 'pass');

    return {
      status: allPassing ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks,
      details: {
        currentBlock,
        lastIndexedBlock,
        blocksBehind,
        isSyncing,
        trackedWallets: this.trackedWalletsCount,
      },
    };
  }

  private async checkQuaiRpc(): Promise<{ quaiRpcCheck: CheckResult; currentBlock: number | null }> {
    // If circuit breaker is open, skip RPC check to avoid hammering a failing endpoint
    // Report degraded status instead of making another failing call
    if (this.rpcCircuitBreakerOpen) {
      return {
        quaiRpcCheck: {
          status: 'fail',
          message: 'RPC circuit breaker open - recovering',
        },
        currentBlock: null,
      };
    }

    try {
      const currentBlock = await withTimeout(
        quai.getBlockNumber(),
        HEALTH_CHECK_TIMEOUT_MS,
        'RPC check'
      );
      return { quaiRpcCheck: { status: 'pass' }, currentBlock };
    } catch (err) {
      // Log detailed error internally, return generic message to clients
      // Use 'err' property - pino auto-serializes Error objects with this key
      logger.error({ err }, 'RPC health check failed');
      return {
        quaiRpcCheck: {
          status: 'fail',
          message: 'RPC connection error',
        },
        currentBlock: null,
      };
    }
  }

  private async checkSupabase(): Promise<{
    supabaseCheck: CheckResult;
    indexerState: { lastIndexedBlock: number; isSyncing: boolean } | null;
  }> {
    try {
      const state = await withTimeout(
        supabase.getIndexerState(),
        HEALTH_CHECK_TIMEOUT_MS,
        'Database check'
      );
      return {
        supabaseCheck: { status: 'pass' },
        indexerState: {
          lastIndexedBlock: state.lastIndexedBlock,
          isSyncing: state.isSyncing,
        },
      };
    } catch (err) {
      // Log detailed error internally, return generic message to clients
      // Use 'err' property - pino auto-serializes Error objects with this key
      logger.error({ err }, 'Database health check failed');
      return {
        supabaseCheck: {
          status: 'fail',
          message: 'Database connection error',
        },
        indexerState: null,
      };
    }
  }
}

export const health = new HealthService();
