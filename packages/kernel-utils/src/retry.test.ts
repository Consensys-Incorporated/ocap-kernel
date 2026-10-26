import { AbortError } from '@metamask/kernel-errors';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  calculateReconnectionBackoff,
  retry,
  retryWithBackoff,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
} from './retry.ts';

describe('calculateReconnectionBackoff', () => {
  it('returns exponential backoff without jitter', () => {
    const delay1 = calculateReconnectionBackoff(1, { jitter: false });
    const delay2 = calculateReconnectionBackoff(2, { jitter: false });
    const delay3 = calculateReconnectionBackoff(3, { jitter: false });

    expect(delay1).toBe(DEFAULT_BASE_DELAY_MS); // 500
    expect(delay2).toBe(DEFAULT_BASE_DELAY_MS * 2); // 1000
    expect(delay3).toBe(DEFAULT_BASE_DELAY_MS * 4); // 2000
  });

  it('caps delay at maxDelayMs', () => {
    const delay = calculateReconnectionBackoff(10, {
      jitter: false,
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
    });
    expect(delay).toBe(DEFAULT_MAX_DELAY_MS);
  });

  it('returns jittered value in [0, calculated) when jitter is true', () => {
    const delay = calculateReconnectionBackoff(1, { jitter: true });
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(DEFAULT_BASE_DELAY_MS);
  });

  it('uses custom base and max delays', () => {
    const delay = calculateReconnectionBackoff(1, {
      baseDelayMs: 100,
      maxDelayMs: 500,
      jitter: false,
    });
    expect(delay).toBe(100);
  });
});

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on first attempt with no delay', async () => {
    const op = vi.fn(async () => 'ok');
    const result = await retry(op, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 100,
      jitter: false,
    });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on third attempt', async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`fail-${attempts}`);
      }
      return 'done';
    });

    const promise = retry(op, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 100,
      jitter: false,
    });

    // First failure schedules a delay
    await Promise.resolve();
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(op).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe('done');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('respects shouldRetry and stops early', async () => {
    const op = vi.fn(async () => {
      throw new Error('fatal');
    });

    await expect(
      retry(op, {
        maxAttempts: 5,
        baseDelayMs: 50,
        maxDelayMs: 50,
        jitter: false,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('fatal');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('invokes onRetry with jitter-computed delay', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('fail');
      }
      return 'ok';
    });

    const onRetry = vi.fn();

    const promise = retry(op, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitter: true,
      onRetry,
    });

    // After first failure: attempt 1 → delay with jitter
    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledTimes(1);
    const firstCall = onRetry.mock.calls[0]?.[0];
    expect(firstCall?.attempt).toBe(1);
    expect(firstCall?.maxAttempts).toBe(5);

    await vi.advanceTimersByTimeAsync(firstCall?.delayMs ?? 0);
    await Promise.resolve();

    // After second failure: attempt 2 → jittered delay
    expect(onRetry).toHaveBeenCalledTimes(2);
    const secondCall = onRetry.mock.calls[1]?.[0];
    expect(secondCall?.attempt).toBe(2);

    await vi.advanceTimersByTimeAsync(secondCall?.delayMs ?? 0);
    const result = await promise;
    expect(result).toBe('ok');

    randomSpy.mockRestore();
  });

  it('computes exponential backoff without jitter', async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('f');
      }
      return 'ok';
    });

    const onRetry = vi.fn();
    const promise = retry(op, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitter: false,
      onRetry,
    });

    // After first failure: attempt 1 → delay = 100 (base * 2^0)
    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 1, delayMs: 100, maxAttempts: 5 }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    // After second failure: attempt 2 → delay = 200 (base * 2^1)
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 2, delayMs: 200, maxAttempts: 5 }),
    );
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result).toBe('ok');
  });

  it('caps exponential growth at maxDelayMs', async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 4) {
        throw new Error('f');
      }
      return 'ok';
    });

    const onRetry = vi.fn();
    const promise = retry(op, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 250, // Cap at 250
      jitter: false,
      onRetry,
    });

    await Promise.resolve();
    // Attempt 1: delay = min(250, 100 * 2^0) = 100
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 1, delayMs: 100, maxAttempts: 5 }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    // Attempt 2: delay = min(250, 100 * 2^1) = 200
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 2, delayMs: 200, maxAttempts: 5 }),
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Attempt 3: delay = min(250, 100 * 2^2) = 250 (capped)
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 3, delayMs: 250, maxAttempts: 5 }),
    );
    await vi.advanceTimersByTimeAsync(250);

    const result = await promise;
    expect(result).toBe('ok');
  });

  it('retries infinitely when maxAttempts is 0', async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 10) {
        throw new Error('not yet');
      }
      return 'finally';
    });

    const promise = retry(op, {
      maxAttempts: 0, // infinite
      baseDelayMs: 10,
      maxDelayMs: 10,
      jitter: false,
    });

    // Let it retry several times
    for (let i = 0; i < 9; i += 1) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
    }

    const result = await promise;
    expect(result).toBe('finally');
    expect(op).toHaveBeenCalledTimes(10);
  });

  it('uses DEFAULT_MAX_RETRY_ATTEMPTS when maxAttempts is not provided', async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 5) {
        throw new Error('not yet');
      }
      return 'finally';
    });

    // Call retry without maxAttempts option (should default to 0 = infinite)
    const promise = retry(op, {
      baseDelayMs: 10,
      maxDelayMs: 10,
      jitter: false,
    });

    // Let it retry several times (infinite retries)
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
    }

    const result = await promise;
    expect(result).toBe('finally');
    expect(op).toHaveBeenCalledTimes(5);
  });

  it('uses defaults when options is undefined', async () => {
    const op = vi.fn(async () => 'ok');

    // Call retry with no options at all
    const result = await retry(op);

    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('uses default baseDelayMs, maxDelayMs, and jitter when not provided', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error('fail');
      }
      return 'ok';
    });

    const onRetry = vi.fn();

    // Call retry without baseDelayMs, maxDelayMs, or jitter
    // Should use DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS, and jitter: true
    const promise = retry(op, {
      maxAttempts: 3,
      onRetry,
    });

    // After first failure
    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledTimes(1);
    const firstCall = onRetry.mock.calls[0]?.[0];
    expect(firstCall?.attempt).toBe(1);
    // Should use default baseDelayMs (500) with jitter, so delay should be in [0, 500)
    expect(firstCall?.delayMs).toBeGreaterThanOrEqual(0);
    expect(firstCall?.delayMs).toBeLessThan(DEFAULT_BASE_DELAY_MS);

    await vi.advanceTimersByTimeAsync(firstCall?.delayMs ?? 0);
    await Promise.resolve();

    const result = await promise;
    expect(result).toBe('ok');

    randomSpy.mockRestore();
  });

  it('uses default baseDelayMs when undefined', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error('fail');
      }
      return 'ok';
    });

    const onRetry = vi.fn();

    // Provide maxDelayMs and jitter, but not baseDelayMs
    const promise = retry(op, {
      maxAttempts: 3,
      maxDelayMs: 1000,
      jitter: true,
      onRetry,
    });

    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledTimes(1);
    const firstCall = onRetry.mock.calls[0]?.[0];
    // Should use DEFAULT_BASE_DELAY_MS (500) with jitter
    expect(firstCall?.delayMs).toBeGreaterThanOrEqual(0);
    expect(firstCall?.delayMs).toBeLessThan(DEFAULT_BASE_DELAY_MS);

    await vi.advanceTimersByTimeAsync(firstCall?.delayMs ?? 0);
    await Promise.resolve();

    const result = await promise;
    expect(result).toBe('ok');

    randomSpy.mockRestore();
  });

  it('uses default maxDelayMs when undefined', async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('fail');
      }
      return 'ok';
    });

    const onRetry = vi.fn();

    // Provide baseDelayMs and jitter, but not maxDelayMs
    const promise = retry(op, {
      maxAttempts: 5,
      baseDelayMs: 100,
      jitter: false,
      onRetry,
    });

    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Third attempt should cap at DEFAULT_MAX_DELAY_MS (10000)
    expect(onRetry).toHaveBeenCalledTimes(2);
    const secondCall = onRetry.mock.calls[1]?.[0];
    expect(secondCall?.delayMs).toBe(200); // 100 * 2^1

    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result).toBe('ok');
  });

  it('uses default jitter (true) when undefined', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error('fail');
      }
      return 'ok';
    });

    const onRetry = vi.fn();

    // Provide baseDelayMs and maxDelayMs, but not jitter (should default to true)
    const promise = retry(op, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      onRetry,
    });

    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledTimes(1);
    const firstCall = onRetry.mock.calls[0]?.[0];
    // Should use jitter (default true), so delay should be in [0, 100)
    expect(firstCall?.delayMs).toBeGreaterThanOrEqual(0);
    expect(firstCall?.delayMs).toBeLessThan(100);

    await vi.advanceTimersByTimeAsync(firstCall?.delayMs ?? 0);
    await Promise.resolve();

    const result = await promise;
    expect(result).toBe('ok');

    randomSpy.mockRestore();
  });

  it('throws AbortError when signal is aborted before operation', async () => {
    const controller = new AbortController();
    controller.abort();

    const op = vi.fn(async () => 'ok');

    await expect(
      retry(op, {
        maxAttempts: 3,
        signal: controller.signal,
      }),
    ).rejects.toThrow(AbortError);

    expect(op).not.toHaveBeenCalled();
  });

  it('throws AbortError when signal is aborted during retry', async () => {
    const controller = new AbortController();

    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 5) {
        throw new Error('fail');
      }
      return 'ok';
    });

    const promise = retry(op, {
      maxAttempts: 10,
      baseDelayMs: 100,
      maxDelayMs: 100,
      jitter: false,
      signal: controller.signal,
    });

    // First failure
    await Promise.resolve();
    expect(op).toHaveBeenCalledTimes(1);

    // Abort during delay
    controller.abort();

    await expect(promise).rejects.toThrow(AbortError);
  });

  it('passes non-Error throw values through', async () => {
    const op = vi.fn(async () => {
      // oxlint-disable-next-line typescript/only-throw-error
      throw 'string error';
    });

    const promise = retry(op, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 10,
      jitter: false,
    }).catch((error) => error); // Handle rejection to prevent unhandled warnings

    // First attempt fails
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    expect(await promise).toBe('string error');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('throws after reaching maxAttempts', async () => {
    const op = vi.fn(async () => {
      throw new Error('always fails');
    });

    const promise = retry(op, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 10,
      jitter: false,
    }).catch((error) => error); // Handle rejection to prevent unhandled warnings

    // Run through all attempts
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('always fails');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: 'shouldRetry returns false',
      shouldRetry: () => false,
      expectedCalls: 1,
    },
    {
      name: 'shouldRetry returns true for first error',
      shouldRetry: (error: unknown) => (error as Error).message !== 'stop',
      expectedCalls: 2,
    },
  ])(
    'respects shouldRetry when $name',
    async ({ shouldRetry, expectedCalls }) => {
      let attempts = 0;
      const op = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('retry this');
        }
        throw new Error('stop');
      });

      const promise = retry(op, {
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 10,
        jitter: false,
        shouldRetry,
      }).catch((error) => error); // Handle rejection to prevent unhandled warnings

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);

      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect(op).toHaveBeenCalledTimes(expectedCalls);
    },
  );
});

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is an alias for retry', async () => {
    const op = vi.fn(async () => 'result');
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 100,
      jitter: false,
    });
    expect(result).toBe('result');
    expect(op).toHaveBeenCalledOnce();
  });
});
