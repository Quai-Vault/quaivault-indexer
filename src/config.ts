import 'dotenv/config';
import { isQuaiAddress } from 'quais';

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
    socialRecoveryModule: process.env.SOCIAL_RECOVERY_MODULE_ADDRESS,
    multiSend: process.env.MULTISEND_ADDRESS,
  },

  // Indexer settings
  indexer: {
    batchSize: parseIntWithBounds(process.env.BATCH_SIZE, 1000, 10, 10000, 'BATCH_SIZE'),
    pollInterval: parseIntWithBounds(process.env.POLL_INTERVAL, 5000, 1000, 60000, 'POLL_INTERVAL'),
    startBlock: parseIntWithBounds(process.env.START_BLOCK, 0, 0, Number.MAX_SAFE_INTEGER, 'START_BLOCK'),
    confirmations: parseIntWithBounds(process.env.CONFIRMATIONS, 2, 0, 100, 'CONFIRMATIONS'),
    getLogsChunkSize: parseIntWithBounds(process.env.GET_LOGS_CHUNK_SIZE, 100, 10, 1000, 'GET_LOGS_CHUNK_SIZE'),
    walletWarningThreshold: parseIntWithBounds(process.env.WALLET_WARNING_THRESHOLD, 500000, 1000, 10000000, 'WALLET_WARNING_THRESHOLD'),
    reorgRollbackBlocks: parseIntWithBounds(process.env.REORG_ROLLBACK_BLOCKS, 10, 1, 1000, 'REORG_ROLLBACK_BLOCKS'),
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

  // Circuit breaker
  circuitBreaker: {
    failureThreshold: parseIntWithBounds(process.env.CB_FAILURE_THRESHOLD, 10, 1, 100, 'CB_FAILURE_THRESHOLD'),
    cooldownMs: parseIntWithBounds(process.env.CB_COOLDOWN_MS, 60000, 1000, 600000, 'CB_COOLDOWN_MS'),
  },

  // RPC call timeout
  rpcTimeout: {
    callTimeoutMs: parseIntWithBounds(process.env.RPC_CALL_TIMEOUT_MS, 30000, 5000, 120000, 'RPC_CALL_TIMEOUT_MS'),
  },

  // Health endpoint rate limiting
  healthRateLimit: {
    windowMs: parseIntWithBounds(process.env.HEALTH_RATE_LIMIT_WINDOW_MS, 60000, 1000, 300000, 'HEALTH_RATE_LIMIT_WINDOW_MS'),
    maxRequests: parseIntWithBounds(process.env.HEALTH_RATE_LIMIT_MAX, 60, 1, 1000, 'HEALTH_RATE_LIMIT_MAX'),
    maxIPs: parseIntWithBounds(process.env.HEALTH_RATE_LIMIT_MAX_IPS, 10000, 100, 100000, 'HEALTH_RATE_LIMIT_MAX_IPS'),
    cleanupIntervalMs: parseIntWithBounds(process.env.HEALTH_RATE_LIMIT_CLEANUP_MS, 300000, 10000, 3600000, 'HEALTH_RATE_LIMIT_CLEANUP_MS'),
  },

  // CORS
  cors: {
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Token tracking
  tokens: {
    seedAddresses: (process.env.SEED_TOKEN_ADDRESSES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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

  // Validate schema name (prevents malformed names reaching PostgREST)
  const schema = process.env.SUPABASE_SCHEMA || 'public';
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) {
    throw new Error(
      `Invalid SUPABASE_SCHEMA: "${schema}" — must be lowercase alphanumeric with underscores, starting with a letter.`
    );
  }

  // Validate required contract addresses are valid Quai addresses
  const requiredContracts: Array<[string, string]> = [
    ['QUAIVAULT_FACTORY_ADDRESS', process.env.QUAIVAULT_FACTORY_ADDRESS!],
    ['QUAIVAULT_IMPLEMENTATION_ADDRESS', process.env.QUAIVAULT_IMPLEMENTATION_ADDRESS!],
  ];
  for (const [name, address] of requiredContracts) {
    if (!isQuaiAddress(address)) {
      throw new Error(`Invalid ${name}: "${address}" is not a valid Quai address.`);
    }
  }

  // Validate optional contract addresses if provided
  const optionalContracts: Array<[string, string | undefined]> = [
    ['SOCIAL_RECOVERY_MODULE_ADDRESS', process.env.SOCIAL_RECOVERY_MODULE_ADDRESS],
    ['MULTISEND_ADDRESS', process.env.MULTISEND_ADDRESS],
  ];
  for (const [name, address] of optionalContracts) {
    if (address && !isQuaiAddress(address)) {
      throw new Error(`Invalid ${name}: "${address}" is not a valid Quai address.`);
    }
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
