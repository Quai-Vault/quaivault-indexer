/**
 * Per-IP rate limiter for HTTP endpoints.
 *
 * Each IP maps to a fixed-size { windowStart, count } object (16 bytes)
 * instead of an ever-growing number[] array. Periodic cleanup removes
 * stale entries to bound memory usage.
 */
export class IpRateLimiter {
  private buckets: Map<string, { windowStart: number; count: number }> =
    new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
    private readonly maxIPs: number,
    private readonly cleanupIntervalMs: number
  ) {}

  /**
   * Check if a request from the given IP is allowed.
   * Returns true if allowed, false if rate limited.
   */
  check(ip: string): boolean {
    // Enforce IP cap to prevent memory exhaustion from many unique IPs
    if (!this.buckets.has(ip) && this.buckets.size >= this.maxIPs) {
      return false;
    }

    const now = Date.now();
    let bucket = this.buckets.get(ip);

    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { windowStart: now, count: 0 };
    }

    if (bucket.count >= this.maxRequests) {
      this.buckets.set(ip, bucket);
      return false;
    }

    bucket.count++;
    this.buckets.set(ip, bucket);
    return true;
  }

  startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, bucket] of this.buckets) {
        if (now - bucket.windowStart >= this.windowMs) {
          this.buckets.delete(ip);
        }
      }
    }, this.cleanupIntervalMs);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  clear(): void {
    this.buckets.clear();
  }
}
