import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules to re-import config with new env vars
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should use default rate limit values', async () => {
    // Set required env vars
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'test-key';
    process.env.QUAIVAULT_FACTORY_ADDRESS = '0x0000000000000000000000000000000000000001';
    process.env.QUAIVAULT_IMPLEMENTATION_ADDRESS = '0x0000000000000000000000000000000000000002';

    const { config } = await import('../src/config.js');

    expect(config.rateLimit.requestsPerWindow).toBe(50);
    expect(config.rateLimit.windowMs).toBe(1000);
    expect(config.cache.timestampCacheSize).toBe(1000);
  });

  it('should use custom rate limit values from environment', async () => {
    // Set required env vars
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'test-key';
    process.env.QUAIVAULT_FACTORY_ADDRESS = '0x0000000000000000000000000000000000000001';
    process.env.QUAIVAULT_IMPLEMENTATION_ADDRESS = '0x0000000000000000000000000000000000000002';

    // Set custom rate limit values
    process.env.RATE_LIMIT_REQUESTS = '100';
    process.env.RATE_LIMIT_WINDOW_MS = '2000';
    process.env.TIMESTAMP_CACHE_SIZE = '5000';

    const { config } = await import('../src/config.js');

    expect(config.rateLimit.requestsPerWindow).toBe(100);
    expect(config.rateLimit.windowMs).toBe(2000);
    expect(config.cache.timestampCacheSize).toBe(5000);
  });

  it('should throw error for missing required environment variables', async () => {
    // Don't set required env vars
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.QUAIVAULT_FACTORY_ADDRESS;
    delete process.env.QUAIVAULT_IMPLEMENTATION_ADDRESS;

    await expect(import('../src/config.js')).rejects.toThrow(
      'Missing required environment variables'
    );
  });

  it('should use default schema when not provided', async () => {
    // Set required env vars
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'test-key';
    process.env.QUAIVAULT_FACTORY_ADDRESS = '0x0000000000000000000000000000000000000001';
    process.env.QUAIVAULT_IMPLEMENTATION_ADDRESS = '0x0000000000000000000000000000000000000002';

    // Don't set SUPABASE_SCHEMA
    delete process.env.SUPABASE_SCHEMA;

    const { config } = await import('../src/config.js');

    expect(config.supabase.schema).toBe('public');
  });

  it('should use custom schema when provided', async () => {
    // Set required env vars
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'test-key';
    process.env.QUAIVAULT_FACTORY_ADDRESS = '0x0000000000000000000000000000000000000001';
    process.env.QUAIVAULT_IMPLEMENTATION_ADDRESS = '0x0000000000000000000000000000000000000002';
    process.env.SUPABASE_SCHEMA = 'testnet';

    const { config } = await import('../src/config.js');

    expect(config.supabase.schema).toBe('testnet');
  });
});
