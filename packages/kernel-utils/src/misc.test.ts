import { AbortError } from '@metamask/kernel-errors';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  abortableDelay,
  delay,
  ifDefined,
  makeCounter,
  raceAbort,
} from './misc.ts';

describe('ifDefined', () => {
  it('removes undefined values', () => {
    expect(ifDefined({ a: 1, b: undefined, c: 3 })).toStrictEqual({
      a: 1,
      c: 3,
    });
  });

  it('returns empty object when all values are undefined', () => {
    expect(ifDefined({ a: undefined, b: undefined })).toStrictEqual({});
  });

  it('preserves all values when none are undefined', () => {
    expect(ifDefined({ a: 1, b: 'two', c: null })).toStrictEqual({
      a: 1,
      b: 'two',
      c: null,
    });
  });

  it('returns empty object for empty input', () => {
    expect(ifDefined({})).toStrictEqual({});
  });
});

describe('misc utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('makeCounter', () => {
    it('starts at 1 by default', () => {
      const counter = makeCounter();
      expect(counter()).toBe(1);
    });

    it('starts counting from the supplied argument', () => {
      const start = 50;
      const counter = makeCounter(start);
      expect(counter()).toStrictEqual(start + 1);
    });

    it('increments convincingly', () => {
      const counter = makeCounter();
      const first = counter();
      expect(counter()).toStrictEqual(first + 1);
      expect(counter()).toStrictEqual(first + 2);
      expect(counter()).toStrictEqual(first + 3);
    });
  });

  describe('delay', () => {
    it('delays execution by the specified number of milliseconds', async () => {
      const delayTime = 100;
      const delayP = delay(delayTime);
      vi.advanceTimersByTime(delayTime);
      expect(await delayP).toBeUndefined();
    });

    it('delays execution by the default number of milliseconds', async () => {
      const delayP = delay();
      vi.advanceTimersByTime(1);
      expect(await delayP).toBeUndefined();
    });
  });

  describe('raceAbort', () => {
    it.each([
      ['no signal', undefined],
      ['a signal that never aborts', new AbortController().signal],
    ])('settles as the promise does given %s', async (_, signal) => {
      expect(await raceAbort(Promise.resolve('done'), signal)).toBe('done');
      await expect(
        raceAbort(Promise.reject(new Error('failed')), signal),
      ).rejects.toThrow('failed');
    });

    it('rejects with the reason of a signal already aborted', async () => {
      await expect(
        raceAbort(
          Promise.resolve('done'),
          AbortSignal.abort(new Error('gave up')),
        ),
      ).rejects.toThrow('gave up');
    });

    it('rejects with the reason when the signal aborts first', async () => {
      const controller = new AbortController();
      const raced = raceAbort(new Promise(() => undefined), controller.signal);
      controller.abort(new Error('gave up'));
      await expect(raced).rejects.toThrow('gave up');
    });

    it('stops listening once the promise settles', async () => {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      await raceAbort(Promise.resolve('done'), controller.signal);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });
  });

  describe('abortableDelay', () => {
    it('delays execution by the specified number of milliseconds', async () => {
      const delayTime = 100;
      const delayP = abortableDelay(delayTime);
      vi.advanceTimersByTime(delayTime);
      expect(await delayP).toBeUndefined();
    });

    it('returns immediately when ms is 0', async () => {
      const result = await abortableDelay(0);
      expect(result).toBeUndefined();
    });

    it('returns immediately when ms is negative', async () => {
      const result = await abortableDelay(-100);
      expect(result).toBeUndefined();
    });

    it('throws AbortError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(abortableDelay(100, controller.signal)).rejects.toThrow(
        AbortError,
      );
      await expect(abortableDelay(100, controller.signal)).rejects.toThrow(
        'Operation aborted.',
      );
    });

    it('throws AbortError when signal is aborted during delay', async () => {
      const controller = new AbortController();
      const delayP = abortableDelay(1000, controller.signal);
      vi.advanceTimersByTime(50);
      controller.abort();
      await expect(delayP).rejects.toThrow(AbortError);
      await expect(delayP).rejects.toThrow('Operation aborted.');
    });

    it('clears timeout when aborted', async () => {
      const controller = new AbortController();
      const delayP = abortableDelay(1000, controller.signal);
      controller.abort();
      await expect(delayP).rejects.toThrow(AbortError);
      vi.advanceTimersByTime(2000);
      await expect(delayP).rejects.toThrow(AbortError);
    });

    it('works without signal parameter', async () => {
      const delayP = abortableDelay(100);
      vi.advanceTimersByTime(100);
      expect(await delayP).toBeUndefined();
    });

    it('completes normally if signal is provided but not aborted', async () => {
      const controller = new AbortController();
      const delayP = abortableDelay(100, controller.signal);
      vi.advanceTimersByTime(100);
      expect(await delayP).toBeUndefined();
    });

    it.each([
      { name: 'very short delay', ms: 1 },
      { name: 'short delay', ms: 10 },
      { name: 'medium delay', ms: 500 },
      { name: 'long delay', ms: 5000 },
    ])('handles $name correctly', async ({ ms }) => {
      const delayP = abortableDelay(ms);
      vi.advanceTimersByTime(ms);
      expect(await delayP).toBeUndefined();
    });

    it('works in real-time environment', async () => {
      vi.useRealTimers();
      const start = Date.now();
      await abortableDelay(50);
      const elapsed = Date.now() - start;
      // Should have delayed approximately 50ms (with some tolerance)
      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(100);
    });

    it('can be aborted in real-time environment', async () => {
      vi.useRealTimers();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      await expect(abortableDelay(1000, controller.signal)).rejects.toThrow(
        AbortError,
      );
    });
  });
});
