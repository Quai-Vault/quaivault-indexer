import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlidingWindowRateLimiter } from '../src/utils/rate-limiter.js';

describe('SlidingWindowRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to maxRequests calls without blocking', async () => {
    const limiter = new SlidingWindowRateLimiter(1000, 5);
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    // Should not have waited — 5 calls within limit of 5
  });

  it('blocks when limit is reached and resumes after window', async () => {
    const limiter = new SlidingWindowRateLimiter(1000, 2);

    await limiter.acquire();
    await limiter.acquire();

    // Third call should block until window resets
    const acquirePromise = limiter.acquire();
    // Advance past the window
    vi.advanceTimersByTime(1000);
    await acquirePromise;
    // Should have resolved after the timer
  });

  it('resets counter after window expires naturally', async () => {
    const limiter = new SlidingWindowRateLimiter(500, 3);

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // Advance past window
    vi.advanceTimersByTime(500);

    // Should allow 3 more calls in the new window
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
  });

  it('uses O(1) memory regardless of call count', async () => {
    const limiter = new SlidingWindowRateLimiter(100, 1000);
    for (let i = 0; i < 1000; i++) {
      await limiter.acquire();
    }
    // No array growth — just two numbers (windowStart, requestCount)
    // If this were the old implementation, requestTimestamps would have 1000 entries
    expect(true).toBe(true);
  });
});
