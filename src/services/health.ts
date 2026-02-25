import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { quai } from './quai.js';
import { supabase } from './supabase.js';
import { IpRateLimiter } from '../utils/ip-rate-limiter.js';
import { withTimeout } from '../utils/timeout.js';
import { logger } from '../utils/logger.js';

// Allowed CORS origins for health check endpoint (from CORS_ALLOWED_ORIGINS env var)
const ALLOWED_ORIGINS = config.cors.allowedOrigins;

// Health check timeout (prevents hanging health checks)
// Increased to 10s to handle slow/congested RPC endpoints
const HEALTH_CHECK_TIMEOUT_MS = 10000;

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

  // O(1) per-IP rate limiter (replaces the old Map<string, number[]>)
  private rateLimiter = new IpRateLimiter(
    config.healthRateLimit.windowMs,
    config.healthRateLimit.maxRequests,
    config.healthRateLimit.maxIPs,
    config.healthRateLimit.cleanupIntervalMs
  );

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
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return ips.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * Send rate limit exceeded response
   */
  private sendRateLimitResponse(res: ServerResponse, headers: Record<string, string>): void {
    const retryAfter = Math.ceil(config.healthRateLimit.windowMs / 1000);
    res.writeHead(429, {
      ...headers,
      'Retry-After': String(retryAfter),
    });
    res.end(JSON.stringify({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Maximum ${config.healthRateLimit.maxRequests} requests per minute.`,
      retryAfter,
    }));
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

    this.rateLimiter.startCleanup();

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const requestId = randomUUID();
      const origin = req.headers.origin;
      const corsHeaders = this.getCorsHeaders(origin);
      const clientIp = this.getClientIp(req);

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
      if (!this.rateLimiter.check(clientIp)) {
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
    this.rateLimiter.stopCleanup();
    this.rateLimiter.clear();

    if (this.server) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('Health check server close timeout, forcing shutdown');
          resolve();
        }, 5000);

        this.server!.close(() => {
          clearTimeout(timeout);
          logger.info('Health check server stopped');
          resolve();
        });

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

    if (currentBlock !== null && lastIndexedBlock !== null) {
      blocksBehind = currentBlock - lastIndexedBlock - config.indexer.confirmations;
      blocksBehind = Math.max(0, blocksBehind);

      if (blocksBehind > config.health.maxBlocksBehind && !isSyncing) {
        indexerCheck = {
          status: 'fail',
          message: `Indexer is ${blocksBehind} blocks behind (max: ${config.health.maxBlocksBehind})`,
        };
      }
    }

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
