import { logger } from './logger.js';

/**
 * Reusable 3-state circuit breaker (closed → open → half-open → closed).
 *
 * - Closed: operations proceed normally
 * - Open: operations are rejected until cooldown expires
 * - Half-open: after cooldown, one operation is allowed to test recovery
 *
 * The optional onStateChange callback allows decoupled notification
 * (e.g., updating a health service) without the breaker depending on it.
 */
export class CircuitBreaker {
  private failures = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private openUntil = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly onStateChange?: (isOpen: boolean) => void
  ) {}

  /**
   * Check if the circuit allows an operation.
   * Returns true if allowed, false if the circuit is open.
   */
  isAllowed(): boolean {
    if (this.state === 'open') {
      if (Date.now() < this.openUntil) {
        return false;
      }
      // Cooldown expired — transition to half-open (allow one attempt)
      logger.info('Circuit breaker cooldown expired, attempting recovery');
      this.state = 'half-open';
      this.failures = 0;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.failures > 0) {
      logger.info(
        { previousFailures: this.failures },
        'Circuit breaker: operation succeeded after failures'
      );
    }
    const wasOpen = this.state !== 'closed';
    this.failures = 0;
    this.state = 'closed';
    if (wasOpen) {
      this.onStateChange?.(false);
    }
  }

  recordFailure(): void {
    this.failures++;

    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openUntil = Date.now() + this.cooldownMs;
      this.onStateChange?.(true);
      logger.warn(
        { failures: this.failures, cooldownMs: this.cooldownMs },
        'Circuit breaker opened — pausing operations'
      );
    }
  }
}
