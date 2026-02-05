import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
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

  setTrackedWalletsCount(count: number): void {
    this.trackedWalletsCount = count;
  }

  setIndexerRunning(running: boolean): void {
    this.isIndexerRunning = running;
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

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const origin = req.headers.origin;
      const corsHeaders = this.getCorsHeaders(origin);

      // Handle CORS preflight requests
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      if (req.url === '/health' && req.method === 'GET') {
        await this.handleHealthCheck(res, corsHeaders);
      } else if (req.url === '/ready' && req.method === 'GET') {
        await this.handleReadinessCheck(res, corsHeaders);
      } else if (req.url === '/live' && req.method === 'GET') {
        this.handleLivenessCheck(res, corsHeaders);
      } else {
        res.writeHead(404, corsHeaders);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.server.listen(config.health.port, () => {
      logger.info({ port: config.health.port }, 'Health check server started');
    });
  }

  async stop(): Promise<void> {
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

  private async handleHealthCheck(res: ServerResponse, headers: Record<string, string>): Promise<void> {
    const health = await this.getHealthStatus();
    const statusCode = health.status === 'healthy' ? 200 : 503;

    res.writeHead(statusCode, headers);
    res.end(JSON.stringify(health, null, 2));
  }

  private async handleReadinessCheck(res: ServerResponse, headers: Record<string, string>): Promise<void> {
    const health = await this.getHealthStatus();
    const isReady =
      health.checks.quaiRpc.status === 'pass' &&
      health.checks.supabase.status === 'pass' &&
      health.checks.indexer.status === 'pass';

    const statusCode = isReady ? 200 : 503;
    res.writeHead(statusCode, headers);
    res.end(JSON.stringify({ ready: isReady }));
  }

  private handleLivenessCheck(res: ServerResponse, headers: Record<string, string>): void {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ alive: true }));
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
    try {
      const currentBlock = await quai.getBlockNumber();
      return { quaiRpcCheck: { status: 'pass' }, currentBlock };
    } catch (error) {
      return {
        quaiRpcCheck: {
          status: 'fail',
          message: `RPC error: ${(error as Error).message}`,
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
      const state = await supabase.getIndexerState();
      return {
        supabaseCheck: { status: 'pass' },
        indexerState: {
          lastIndexedBlock: state.lastIndexedBlock,
          isSyncing: state.isSyncing,
        },
      };
    } catch (error) {
      return {
        supabaseCheck: {
          status: 'fail',
          message: `Database error: ${(error as Error).message}`,
        },
        indexerState: null,
      };
    }
  }
}

export const health = new HealthService();
