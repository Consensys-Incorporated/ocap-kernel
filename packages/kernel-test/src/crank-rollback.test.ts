import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { makeKernelStore } from '@metamask/ocap-kernel';
import type { RunQueueItem } from '@metamask/ocap-kernel';
import { describe, it, expect } from 'vitest';

/**
 * The run loop rolls back the crank it died in, so that a restart resumes from a
 * consistent boundary rather than from a half-finished crank. `KernelQueue`'s own
 * tests mock the store, so they prove only that `rollbackCrank` is *called*
 * correctly. These exercise what it actually does against real SQLite: the
 * savepoint, the run queue and its length cache, and the release that `endCrank`
 * performs afterwards.
 */

/**
 * Make a kernel store over a fresh in-memory database.
 *
 * @returns The store and the database beneath it.
 */
const makeStore = async (): Promise<{
  kernelStore: ReturnType<typeof makeKernelStore>;
  kdb: KernelDatabase;
}> => {
  const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  return { kernelStore: makeKernelStore(kdb), kdb };
};

const makeItem = (target: string): RunQueueItem =>
  ({
    type: 'send',
    target,
    message: { methargs: { body: '#[]', slots: [] } },
  }) as unknown as RunQueueItem;

describe('crank rollback against a real database', () => {
  // The claim the changelog makes: because the killing crank is rolled back, the
  // item it dequeued is still there to be re-dequeued after a restart. With the
  // store mocked this is unobservable.
  it('returns the dequeued item to the run queue', async () => {
    const { kernelStore } = await makeStore();
    kernelStore.enqueueRun(makeItem('ko1'));

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    const dequeued = kernelStore.dequeueRun();
    expect(dequeued).toBeDefined();
    expect(kernelStore.runQueueLength()).toBe(0);

    kernelStore.rollbackCrank('start');
    kernelStore.endCrank();

    expect(kernelStore.runQueueLength()).toBe(1);
    expect(kernelStore.dequeueRun()).toStrictEqual(dequeued);
  });

  // `rollbackCrank` invalidates the length cache precisely because the rollback
  // restored rows the cache no longer knows about. Reading the length *before*
  // the rollback primes that cache, which is what makes the invalidation matter.
  it('recomputes the run queue length after a rollback', async () => {
    const { kernelStore } = await makeStore();
    kernelStore.enqueueRun(makeItem('ko1'));
    kernelStore.enqueueRun(makeItem('ko2'));

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    kernelStore.dequeueRun();
    kernelStore.dequeueRun();
    // Prime the cache at 0 so a stale read would be visible below.
    expect(kernelStore.runQueueLength()).toBe(0);

    kernelStore.rollbackCrank('start');
    kernelStore.endCrank();

    expect(kernelStore.runQueueLength()).toBe(2);
  });

  // `endCrank` releases savepoints unconditionally, and releasing the savepoint a
  // rollback abandoned would commit the crank being discarded. It cannot, because
  // `rollbackCrank` forgets the savepoint — but that reasoning is about SQLite's
  // savepoint stack, so it is worth pinning against a real one.
  it('does not commit the abandoned crank when endCrank releases afterwards', async () => {
    const { kernelStore, kdb } = await makeStore();
    kdb.kernelKVStore.set('before', 'yes');

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    kdb.kernelKVStore.set('during', 'yes');
    kdb.kernelKVStore.delete('before');

    kernelStore.rollbackCrank('start');
    kernelStore.endCrank();

    expect(kdb.kernelKVStore.get('during')).toBeUndefined();
    expect(kdb.kernelKVStore.get('before')).toBe('yes');
  });

  // A rollback that left the transaction open would swallow every later write on
  // the connection, including the ones `Kernel.stop()` makes on the way out.
  it('leaves the database writable after a rolled-back crank', async () => {
    const { kernelStore, kdb } = await makeStore();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    kdb.kernelKVStore.set('discarded', 'yes');
    kernelStore.rollbackCrank('start');
    kernelStore.endCrank();

    kdb.kernelKVStore.set('after', 'yes');
    expect(kdb.kernelKVStore.get('after')).toBe('yes');

    // Survives the commit boundary a subsequent crank draws, so the write really
    // landed rather than sitting in a transaction that never resolves.
    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    kernelStore.endCrank();
    expect(kdb.kernelKVStore.get('after')).toBe('yes');
    expect(kdb.kernelKVStore.get('discarded')).toBeUndefined();
  });

  // The abort path rolls back mid-crank and the run loop then keeps going, so the
  // next crank has to be able to create its own savepoint and commit normally.
  it('commits a later crank after an earlier one rolled back', async () => {
    const { kernelStore, kdb } = await makeStore();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    kdb.kernelKVStore.set('first', 'yes');
    kernelStore.rollbackCrank('start');
    kernelStore.endCrank();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    kdb.kernelKVStore.set('second', 'yes');
    kernelStore.endCrank();

    expect(kdb.kernelKVStore.get('first')).toBeUndefined();
    expect(kdb.kernelKVStore.get('second')).toBe('yes');
  });

  // An aborted crank still owes work after the rollback — terminating the vat,
  // collecting garbage — whose writes have to survive it.
  it('keeps the writes a crank makes after rolling its delivery back', async () => {
    const { kernelStore, kdb } = await makeStore();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.createCrankSavepoint('delivery');
    kdb.kernelKVStore.set('delivered', 'yes');

    kernelStore.rollbackCrank('delivery');
    kdb.kernelKVStore.set('terminated', 'yes');
    kernelStore.endCrank();

    expect(kdb.kernelKVStore.get('delivered')).toBeUndefined();
    expect(kdb.kernelKVStore.get('terminated')).toBe('yes');
  });

  // And survive it *inside the crank's transaction*, not as autocommitted
  // statements. Rolling back `crank` is the only way to observe that from here;
  // the run loop never does it.
  it('holds those writes in the transaction rather than autocommitting them', async () => {
    const { kernelStore, kdb } = await makeStore();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.createCrankSavepoint('delivery');
    kernelStore.rollbackCrank('delivery');
    kdb.kernelKVStore.set('terminated', 'yes');

    kernelStore.rollbackCrank('crank');
    kernelStore.endCrank();

    expect(kdb.kernelKVStore.get('terminated')).toBeUndefined();
  });

  // Every `provideCachedStoredValue` keeps its value in a closure and writes
  // through to kv, so a rollback that only reverts the database leaves the cache
  // holding the abandoned crank's value — and the next `set` persists it. The GC
  // action set is the case that matters: `processGCActionSet` consumes an action
  // before delivering it, so losing the rollback loses the action outright.
  it('restores the GC action set consumed by a rolled-back crank', async () => {
    const { kernelStore } = await makeStore();
    kernelStore.addGCActions(['v1 dropExport ko1']);

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.createCrankSavepoint('delivery');
    // Consume the action the way `processGCActionSet` does.
    kernelStore.setGCActions(new Set());

    kernelStore.rollbackCrank('delivery');
    kernelStore.endCrank();

    expect([...kernelStore.getGCActions()]).toStrictEqual([
      'v1 dropExport ko1',
    ]);
  });

  // Same closure, same failure: a reap scheduled and then consumed by a crank
  // that rolls back must still be pending afterwards.
  it('restores the reap queue consumed by a rolled-back crank', async () => {
    const { kernelStore } = await makeStore();
    kernelStore.scheduleReap('v1');

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.createCrankSavepoint('delivery');
    expect(kernelStore.nextReapAction()).toBeDefined();

    kernelStore.rollbackCrank('delivery');
    kernelStore.endCrank();

    expect(kernelStore.nextReapAction()).toBeDefined();
  });

  // `maybeFreeKrefs` is RAM-only, so nothing rolls it back. Left populated, the
  // next crank's `collectGarbage` visits krefs whose decrements were undone —
  // and `getKernelPromise` throws outright for one the rollback deleted, which
  // kills the run loop.
  it('discards GC candidates accumulated by a rolled-back crank', async () => {
    const { kernelStore } = await makeStore();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.createCrankSavepoint('delivery');
    // Born at 1, so this drops it to 0 and leaves `kpid` in `maybeFreeKrefs`
    // while the rollback removes the promise record it names.
    const kpid = kernelStore.initKernelPromise()[0];
    kernelStore.decrementRefCount(kpid, 'test');

    kernelStore.rollbackCrank('delivery');
    kernelStore.endCrank();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    expect(() => kernelStore.collectGarbage()).not.toThrow();
    kernelStore.endCrank();
  });

  // `createCrankSavepoint` records the name only once the database has the
  // savepoint. Asking to roll back one that was never created must therefore say
  // so, rather than releasing someone else's savepoint.
  it('refuses to roll back a savepoint that was never created', async () => {
    const { kernelStore } = await makeStore();

    kernelStore.startCrank();

    expect(() => kernelStore.rollbackCrank('start')).toThrow(
      'no such savepoint',
    );
    kernelStore.endCrank();
  });
});
