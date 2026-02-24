import { config } from '../config.js';
import { logger } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  /** Add jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
  /** Operation name for logging */
  operation?: string;
}

/**
 * Execute a function with retry and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = config.retry.maxRetries,
    delayMs = config.retry.baseDelayMs,
    backoffMultiplier = 2,
    maxDelayMs = config.retry.maxDelayMs,
    jitter = true,
    operation = 'operation',
  } = options;

  let lastError: Error | undefined;
  let currentDelay = delayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxAttempts) {
        break;
      }

      // Add jitter: random 0-25% reduction to prevent thundering herd
      const jitteredDelay = jitter
        ? currentDelay * (0.75 + Math.random() * 0.25)
        : currentDelay;

      logger.warn(
        {
          operation,
          attempt,
          maxAttempts,
          nextRetryMs: Math.round(jitteredDelay),
          err: lastError,
        },
        'Retrying after error'
      );

      await sleep(jitteredDelay);
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Retry state tracker for continuous polling loops
 * Tracks consecutive failures and provides appropriate delays
 */
export class RetryTracker {
  private consecutiveFailures = 0;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly errorThreshold: number;

  constructor(options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    errorThreshold?: number;
  } = {}) {
    this.maxRetries = options.maxRetries ?? config.retry.maxRetries;
    this.baseDelayMs = options.baseDelayMs ?? config.retry.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs ?? config.retry.maxDelayMs;
    this.errorThreshold = options.errorThreshold ?? config.retry.errorThreshold;
  }

  /**
   * Record a successful operation - resets failure counter
   */
  recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      logger.info(
        { previousFailures: this.consecutiveFailures },
        'Recovered after consecutive failures'
      );
    }
    this.consecutiveFailures = 0;
  }

  /**
   * Record a failed operation - increments failure counter
   * @returns The delay to wait before retrying
   */
  recordFailure(error: Error, operation: string): number {
    this.consecutiveFailures++;

    const delay = this.getBackoffDelay();

    // Log at appropriate level based on failure count
    const logData = {
      operation,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryMs: delay,
      err: error,
    };

    if (this.consecutiveFailures >= this.errorThreshold) {
      logger.error(logData, 'Repeated failures - may need intervention');
    } else {
      logger.warn(logData, 'Operation failed, will retry');
    }

    return delay;
  }

  /**
   * Check if we've exceeded max retries
   */
  isExhausted(): boolean {
    return this.consecutiveFailures >= this.maxRetries;
  }

  /**
   * Get current failure count
   */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Calculate backoff delay with jitter
   */
  private getBackoffDelay(): number {
    const exponentialDelay = this.baseDelayMs * Math.pow(2, this.consecutiveFailures - 1);
    const cappedDelay = Math.min(exponentialDelay, this.maxDelayMs);
    // Add 0-25% jitter
    return Math.round(cappedDelay * (0.75 + Math.random() * 0.25));
  }

  /**
   * Reset the tracker (e.g., after manual intervention)
   */
  reset(): void {
    this.consecutiveFailures = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
