import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { makeKernelStore } from '@metamask/ocap-kernel';
import type { RunQueueItem } from '@metamask/ocap-kernel';
import { describe, it, expect } from 'vitest';

/**
 * `KernelQueue`'s own tests mock the store, so they prove only that
 * `rollbackCrank` is *called* correctly. These exercise what it does against
 * real SQLite.
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

  it('leaves the database writable after a rolled-back crank', async () => {
    const { kernelStore, kdb } = await makeStore();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    kdb.kernelKVStore.set('discarded', 'yes');
    kernelStore.rollbackCrank('start');
    kernelStore.endCrank();

    kdb.kernelKVStore.set('after', 'yes');
    expect(kdb.kernelKVStore.get('after')).toBe('yes');

    // Survives the commit boundary a later crank draws.
    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    kernelStore.endCrank();
    expect(kdb.kernelKVStore.get('after')).toBe('yes');
    expect(kdb.kernelKVStore.get('discarded')).toBeUndefined();
  });

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

  // Rolling back `crank` is the only way to observe this from here; the run loop
  // never does it.
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

  it('discards GC candidates accumulated by a rolled-back crank', async () => {
    const { kernelStore } = await makeStore();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.createCrankSavepoint('delivery');
    // Born at 1, so this drops it to 0 and leaves `kpid` in `maybeFreeKrefs`.
    const kpid = kernelStore.initKernelPromise()[0];
    kernelStore.decrementRefCount(kpid, 'test');

    kernelStore.rollbackCrank('delivery');
    kernelStore.endCrank();

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    expect(() => kernelStore.collectGarbage()).not.toThrow();
    kernelStore.endCrank();
  });

  it('refuses to roll back a savepoint that was never created', async () => {
    const { kernelStore } = await makeStore();

    kernelStore.startCrank();

    expect(() => kernelStore.rollbackCrank('start')).toThrow(
      'no such savepoint',
    );
    kernelStore.endCrank();
  });
});
