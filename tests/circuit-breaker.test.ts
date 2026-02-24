import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../src/utils/circuit-breaker.js';

// Mock the logger
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays closed below failure threshold', () => {
    const cb = new CircuitBreaker(3, 5000);

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isAllowed()).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    const cb = new CircuitBreaker(3, 5000);

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isAllowed()).toBe(false);
  });

  it('rejects calls while open and cooldown has not expired', () => {
    const cb = new CircuitBreaker(2, 10000);

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isAllowed()).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(cb.isAllowed()).toBe(false);
  });

  it('transitions to half-open after cooldown expires', () => {
    const cb = new CircuitBreaker(2, 5000);

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isAllowed()).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(cb.isAllowed()).toBe(true);
  });

  it('resets to closed on success', () => {
    const cb = new CircuitBreaker(2, 5000);

    cb.recordFailure();
    cb.recordFailure();

    vi.advanceTimersByTime(5000);
    cb.isAllowed(); // half-open
    cb.recordSuccess();

    // Should now be fully closed — failures reset
    cb.recordFailure(); // 1 failure, below threshold of 2
    expect(cb.isAllowed()).toBe(true);
  });

  it('fires onStateChange callback when opening', () => {
    const onChange = vi.fn();
    const cb = new CircuitBreaker(2, 5000, onChange);

    cb.recordFailure();
    expect(onChange).not.toHaveBeenCalled();

    cb.recordFailure();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('fires onStateChange callback when closing via success', () => {
    const onChange = vi.fn();
    const cb = new CircuitBreaker(1, 1000, onChange);

    cb.recordFailure(); // opens
    expect(onChange).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(1000);
    cb.isAllowed(); // half-open
    cb.recordSuccess(); // closes
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
