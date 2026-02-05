import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../src/utils/retry.js';

// Mock the logger to avoid console output during tests
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const resultPromise = withRetry(fn);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const resultPromise = withRetry(fn, { maxAttempts: 3, delayMs: 100 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));

    // Start the retry and immediately attach a catch handler to prevent unhandled rejection
    const resultPromise = withRetry(fn, { maxAttempts: 3, delayMs: 100 }).catch(
      (e) => e
    );
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('persistent failure');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should use exponential backoff', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    const resultPromise = withRetry(fn, {
      maxAttempts: 3,
      delayMs: 1000,
      backoffMultiplier: 2,
    });

    // First call happens immediately
    expect(fn).toHaveBeenCalledTimes(1);

    // After 1000ms, second attempt
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    // After 2000ms more (backoff), third attempt
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(3);

    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('should respect maxDelayMs cap', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    const resultPromise = withRetry(fn, {
      maxAttempts: 4,
      delayMs: 10000,
      backoffMultiplier: 10,
      maxDelayMs: 15000, // Should cap at 15s, not 100s
    });

    // First call happens immediately
    expect(fn).toHaveBeenCalledTimes(1);

    // After 10s, second attempt
    await vi.advanceTimersByTimeAsync(10000);
    expect(fn).toHaveBeenCalledTimes(2);

    // Backoff would be 100s but capped at 15s
    await vi.advanceTimersByTimeAsync(15000);
    expect(fn).toHaveBeenCalledTimes(3);

    // Still capped at 15s
    await vi.advanceTimersByTimeAsync(15000);
    expect(fn).toHaveBeenCalledTimes(4);

    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('should use default options when none provided', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const resultPromise = withRetry(fn);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
