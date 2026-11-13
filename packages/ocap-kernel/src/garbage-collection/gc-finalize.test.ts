import { delay } from '@metamask/kernel-utils';
import { describe, it, expect, onTestFinished, vi } from 'vitest';

import { makeGCAndFinalize } from './gc-finalize.ts';

const gcAndFinalize = makeGCAndFinalize();

describe('Garbage Collection', () => {
  it('should clean up unreachable objects', async () => {
    // Set up a WeakRef to track an object
    let obj = { test: 'value' };
    const weakRef = new WeakRef(obj);
    expect(weakRef.deref()).toBe(obj);
    // @ts-expect-error - Remove the reference to the object
    obj = null;
    expect(weakRef.deref()).toBeDefined();
    await gcAndFinalize();
    expect(weakRef.deref()).toBeUndefined();
  });

  it('should trigger FinalizationRegistry callbacks', async () => {
    // Set up a finalization registry with a callback
    const finalizationCallback = vi.fn();
    const registry = new FinalizationRegistry(finalizationCallback);
    // Register an object for finalization
    let obj = { test: 'finalize me' };
    registry.register(obj, 'test token');
    // Remove reference to the object
    // @ts-expect-error - Null assignment
    obj = null;
    // Trigger garbage collection
    await gcAndFinalize();
    // Wait a bit more to ensure finalization callbacks run
    await delay(50);
    // The callback should have been called at least once
    expect(finalizationCallback).toHaveBeenCalled();
  });

  it('should work with circular references', async () => {
    // Create objects with circular references
    type CircularObj = { name: string; ref: CircularObj | null };
    const objA: CircularObj = { name: 'A', ref: null };
    let objB: CircularObj = { name: 'B', ref: null };
    objA.ref = objB;
    objB.ref = objA;
    // Create a weak reference to track objB
    const weakRef = new WeakRef(objB);
    expect(weakRef.deref()).toBe(objB);
    // Break circular reference and remove our reference
    objA.ref = null;
    // @ts-expect-error - Null assignment
    objB = null;
    expect(weakRef.deref()).toBeDefined();
    await gcAndFinalize();
    expect(weakRef.deref()).toBeUndefined();
  });

  it('drains pending work before the first collection', async () => {
    const order: string[] = [];
    // `gc-engine.ts` leaves `--expose_gc` on process-wide, so a worker thread
    // started after any test that reaches it has a `gc` global, which is
    // writable but not configurable: `vi.stubGlobal` would throw on it.
    const realGC = globalThis.gc;
    onTestFinished(() => {
      globalThis.gc = realGC;
    });
    globalThis.gc = (() => {
      order.push('collect');
    }) as typeof globalThis.gc;

    const gcAndFinalizeWithStub = makeGCAndFinalize();
    setTimeout(() => {
      order.push('pending');
      setTimeout(() => order.push('chained'), 0);
    }, 0);
    await gcAndFinalizeWithStub();

    expect(order).toStrictEqual(['pending', 'chained', 'collect', 'collect']);
  });
});
