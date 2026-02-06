import 'dotenv/config';

/**
 * Parse an integer from environment variable with bounds validation.
 * Throws on invalid values to fail fast at startup.
 */
function parseIntWithBounds(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  name: string
): number {
  const parsed = parseInt(value || String(defaultValue), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: expected integer, got "${value}"`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${parsed} outside range [${min}, ${max}]`);
  }
  return parsed;
}

export const config = {
  // Quai Network - base URL without shard path (usePathing: true handles routing)
  quai: {
    rpcUrl: process.env.QUAI_RPC_URL || 'https://rpc.quai.network',
    wsUrl: process.env.QUAI_WS_URL || 'wss://rpc.quai.network',
    chainId: 9,
  },

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_KEY!,
    // Schema for multi-network support (testnet, mainnet, or public for legacy)
    schema: process.env.SUPABASE_SCHEMA || 'public',
  },

  // Contracts
  contracts: {
    quaiVaultFactory: process.env.QUAIVAULT_FACTORY_ADDRESS!,
    quaiVaultImplementation: process.env.QUAIVAULT_IMPLEMENTATION_ADDRESS!,
    dailyLimitModule: process.env.DAILY_LIMIT_MODULE_ADDRESS,
    whitelistModule: process.env.WHITELIST_MODULE_ADDRESS,
    socialRecoveryModule: process.env.SOCIAL_RECOVERY_MODULE_ADDRESS,
    multiSend: process.env.MULTISEND_ADDRESS,
  },

  // Indexer settings
  indexer: {
    batchSize: parseIntWithBounds(process.env.BATCH_SIZE, 1000, 10, 10000, 'BATCH_SIZE'),
    pollInterval: parseIntWithBounds(process.env.POLL_INTERVAL, 5000, 1000, 60000, 'POLL_INTERVAL'),
    startBlock: parseIntWithBounds(process.env.START_BLOCK, 0, 0, Number.MAX_SAFE_INTEGER, 'START_BLOCK'),
    confirmations: parseIntWithBounds(process.env.CONFIRMATIONS, 2, 0, 100, 'CONFIRMATIONS'),
  },

  // Health check settings
  health: {
    enabled: process.env.HEALTH_CHECK_ENABLED !== 'false',
    port: parseIntWithBounds(process.env.HEALTH_CHECK_PORT, 8080, 1, 65535, 'HEALTH_CHECK_PORT'),
    maxBlocksBehind: parseIntWithBounds(process.env.HEALTH_MAX_BLOCKS_BEHIND, 100, 1, 10000, 'HEALTH_MAX_BLOCKS_BEHIND'),
  },

  // RPC rate limiting
  rateLimit: {
    requestsPerWindow: parseIntWithBounds(process.env.RATE_LIMIT_REQUESTS, 50, 1, 1000, 'RATE_LIMIT_REQUESTS'),
    windowMs: parseIntWithBounds(process.env.RATE_LIMIT_WINDOW_MS, 1000, 100, 60000, 'RATE_LIMIT_WINDOW_MS'),
  },

  // Caching
  cache: {
    timestampCacheSize: parseIntWithBounds(process.env.TIMESTAMP_CACHE_SIZE, 1000, 10, 100000, 'TIMESTAMP_CACHE_SIZE'),
  },

  // Retry settings for resilience
  retry: {
    maxRetries: parseIntWithBounds(process.env.RETRY_MAX_RETRIES, 5, 1, 20, 'RETRY_MAX_RETRIES'),
    baseDelayMs: parseIntWithBounds(process.env.RETRY_BASE_DELAY_MS, 1000, 100, 30000, 'RETRY_BASE_DELAY_MS'),
    maxDelayMs: parseIntWithBounds(process.env.RETRY_MAX_DELAY_MS, 60000, 1000, 300000, 'RETRY_MAX_DELAY_MS'),
    // After this many consecutive failures, log at error level
    errorThreshold: parseIntWithBounds(process.env.RETRY_ERROR_THRESHOLD, 3, 1, 10, 'RETRY_ERROR_THRESHOLD'),
  },
};

// Validate required configuration at startup
function validateConfig(): void {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'QUAIVAULT_FACTORY_ADDRESS',
    'QUAIVAULT_IMPLEMENTATION_ADDRESS',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please check your .env file or environment configuration.'
    );
  }
}

validateConfig();

// Deep freeze config to prevent accidental runtime mutations
function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  }
  return obj;
}
deepFreeze(config);
