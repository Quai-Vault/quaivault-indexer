/**
 * O(1) memory sliding-window rate limiter.
 *
 * Replaces the previous requestTimestamps[] array approach which leaked memory
 * under sustained load (~4.3M entries/day). This uses a simple counter that
 * resets when the window expires — constant memory regardless of throughput.
 */
export class SlidingWindowRateLimiter {
  private windowStart = 0;
  private requestCount = 0;

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number
  ) {}

  /**
   * Wait until a request slot is available in the current window.
   *
   * Trade-off: a burst of requests arriving just before the window resets can
   * be followed by another full window immediately after the reset, allowing up
   * to 2× maxRequests in a short period. This is acceptable for RPC rate
   * limiting where the goal is amortized throughput, not strict per-second caps.
   */
  async acquire(): Promise<void> {
    const now = Date.now();

    // Reset counter if we've moved past the current window
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.requestCount = 0;
    }

    // If at limit, wait for the window to expire then reset
    if (this.requestCount >= this.maxRequests) {
      const waitTime = this.windowMs - (now - this.windowStart);
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      this.windowStart = Date.now();
      this.requestCount = 0;
    }

    this.requestCount++;
  }
}
