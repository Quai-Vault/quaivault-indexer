/**
 * Health check response from the indexer
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  checks: {
    quaiRpc: { status: 'pass' | 'fail' };
    supabase: { status: 'pass' | 'fail' };
    indexer: { status: 'pass' | 'fail' };
  };
  details: {
    currentBlock: number;
    lastIndexedBlock: number;
    blocksBehind: number;
    isSyncing: boolean;
    trackedWallets: number;
  };
}

/**
 * Helper for waiting on indexer sync and checking health
 */
export class IndexerHelper {
  constructor(
    private healthCheckUrl: string,
    private pollInterval: number
  ) {}

  /**
   * Get current indexer health status
   * Note: Health endpoint may return 503 with valid JSON when unhealthy
   */
  async getHealth(): Promise<HealthStatus> {
    const response = await fetch(`${this.healthCheckUrl}/health`);

    // Parse JSON even for non-2xx responses (health endpoint returns JSON for 503)
    const body = await response.json() as HealthStatus;
    return body;
  }

  /**
   * Verify indexer is healthy and connected
   * For E2E tests, we only require RPC and Supabase to be working.
   * We warn but don't fail if the indexer is behind on blocks.
   */
  async verifyHealthy(): Promise<void> {
    try {
      const health = await this.getHealth();

      // Critical checks - must pass
      if (health.checks.quaiRpc.status === 'fail') {
        throw new Error('Indexer cannot connect to Quai RPC');
      }
      if (health.checks.supabase.status === 'fail') {
        throw new Error('Indexer cannot connect to Supabase');
      }

      // Warn if indexer is behind but don't fail
      if (health.checks.indexer.status === 'fail') {
        console.warn(`⚠️  Indexer is ${health.details.blocksBehind} blocks behind - tests may need to wait longer`);
      }

      // Log sync status
      if (health.details.blocksBehind > 0) {
        console.log(`   Current block: ${health.details.currentBlock}, Indexed: ${health.details.lastIndexedBlock}`);
      }
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new Error(
          `Cannot connect to indexer at ${this.healthCheckUrl}. Make sure the indexer is running.`
        );
      }
      throw error;
    }
  }

  /**
   * Wait for indexer to process up to a specific block
   */
  async waitForBlock(blockNumber: number, timeout = 60000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const health = await this.getHealth();

        if (health.details.lastIndexedBlock >= blockNumber) {
          return;
        }
      } catch {
        // Ignore errors during polling
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }

    throw new Error(
      `Indexer did not reach block ${blockNumber} within ${timeout}ms`
    );
  }

  /**
   * Wait for indexer to be synced (no blocks behind)
   */
  async waitForSync(timeout = 60000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const health = await this.getHealth();

        if (health.details.blocksBehind === 0 && !health.details.isSyncing) {
          return;
        }
      } catch {
        // Ignore errors during polling
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }

    throw new Error(`Indexer did not sync within ${timeout}ms`);
  }

  /**
   * Generic wait until a condition is met
   * @param checkFn Function that returns non-null when condition is met
   * @param description Description for error messages
   * @param timeout Maximum time to wait in milliseconds
   */
  async waitUntil<T>(
    checkFn: () => Promise<T | null | undefined>,
    description: string,
    timeout = 60000
  ): Promise<T> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const result = await checkFn();

        if (result !== null && result !== undefined) {
          return result;
        }
      } catch {
        // Ignore errors during polling
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }

    throw new Error(`Timeout waiting for: ${description} (${timeout}ms)`);
  }

  /**
   * Wait for a condition with a custom check interval
   */
  async waitUntilWithInterval<T>(
    checkFn: () => Promise<T | null | undefined>,
    description: string,
    interval: number,
    timeout = 60000
  ): Promise<T> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const result = await checkFn();

        if (result !== null && result !== undefined) {
          return result;
        }
      } catch {
        // Ignore errors during polling
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`Timeout waiting for: ${description} (${timeout}ms)`);
  }
}
