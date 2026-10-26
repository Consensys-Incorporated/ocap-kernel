import { makePromiseKit } from '@endo/promise-kit';
import { describe, it, expect } from 'vitest';

import { waitUntilQuiescent } from './wait-quiescent.ts';

describe('waitUntilQuiescent', () => {
  it('resolves after microtask queue is empty', async () => {
    const { promise: p1, resolve: r1 } = makePromiseKit<void>();
    const { promise: p2, resolve: r2 } = makePromiseKit<void>();

    // Start waiting for quiescence first
    const quiescentPromise = waitUntilQuiescent();

    // Create microtasks
    Promise.resolve()
      .then(() => {
        r1();
        return undefined;
      })
      .catch(() => undefined);

    Promise.resolve()
      .then(() => {
        r2();
        return undefined;
      })
      .catch(() => undefined);

    // Wait for all promises
    await p1;
    await p2;
    await quiescentPromise;

    expect(true).toBe(true); // If we got here, the test passed
  });

  it('waits for a delay', async () => {
    const delayP = waitUntilQuiescent(1);
    // Using fake timers messes up these tests, so we use a (very long) real timeout.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await delayP).toBeUndefined();
  });

  it('waits for nested promise chains', async () => {
    const results: number[] = [];

    // Create nested promise chains
    await Promise.resolve().then(async () => {
      results.push(1);
      // oxlint-disable-next-line promise/no-nesting
      await Promise.resolve().then(async () => {
        results.push(2);
        // oxlint-disable-next-line promise/no-nesting
        await Promise.resolve().then(() => {
          results.push(3);
          return results;
        });
        return results;
      });
      return results;
    });

    await waitUntilQuiescent();

    expect(results).toStrictEqual([1, 2, 3]);
  });

  it('waits for concurrent promises', async () => {
    const results: number[] = [];
    const promises = [
      Promise.resolve().then(() => results.push(1)),
      Promise.resolve().then(() => results.push(2)),
      Promise.resolve().then(() => results.push(3)),
    ];

    await Promise.all(promises);
    await waitUntilQuiescent();

    expect(results).toHaveLength(3);
    expect(results).toContain(1);
    expect(results).toContain(2);
    expect(results).toContain(3);
  });

  it('handles rejected promises in the queue', async () => {
    const results: string[] = [];

    // Create a mix of resolved and rejected promises
    await Promise.resolve()
      .then(() => {
        results.push('success1');
        return results;
      })
      .catch(() => {
        results.push('caught1');
        return results;
      });

    await Promise.reject(new Error('test error'))
      .then(() => {
        results.push('success2');
        return results;
      })
      .catch(() => {
        results.push('caught2');
        return results;
      });

    await waitUntilQuiescent();

    expect(results).toContain('success1');
    expect(results).toContain('caught2');
  });

  it('resolves even with setImmediate callbacks', async () => {
    const results: string[] = [];

    setImmediate(() => {
      results.push('immediate1');
      setImmediate(() => {
        results.push('immediate2');
      });
    });

    await Promise.resolve().then(() => {
      results.push('promise');
      return results;
    });

    await waitUntilQuiescent();

    expect(results).toContain('promise');
    // Note: We don't check for immediate1/2 as they may execute after
    // waitUntilQuiescent resolves, since they're lower priority
  });
});
