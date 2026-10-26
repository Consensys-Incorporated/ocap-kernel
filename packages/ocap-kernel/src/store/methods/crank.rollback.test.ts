import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, it, expect, beforeEach } from 'vitest';

import { asKRef, asVatId } from '../../../test/branded.ts';
import { makeGCAction } from '../../types.ts';
import { makeKernelStore } from '../index.ts';

/**
 * A real database, because the map store's `rollbackSavepoint` is a no-op and
 * so cannot tell a reverted cache from a stale one.
 */
describe('what a crank rollback reverts beyond the database', () => {
  let kernelStore: ReturnType<typeof makeKernelStore>;

  beforeEach(async () => {
    kernelStore = makeKernelStore(
      await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
    );
  });

  /**
   * Run the abandoned crank the way the run loop does.
   *
   * @param work - What the crank does before it aborts.
   */
  function crankThenRollBack(work: () => void): void {
    kernelStore.startCrank();
    try {
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      work();
      kernelStore.rollbackCrank('delivery');
    } finally {
      kernelStore.endCrank();
    }
  }

  it.each([
    {
      cache: 'terminatedVats',
      write: (store: ReturnType<typeof makeKernelStore>) =>
        store.markVatAsTerminated(asVatId('v1')),
      read: (store: ReturnType<typeof makeKernelStore>) =>
        store.getTerminatedVats(),
    },
    {
      cache: 'gcActions',
      write: (store: ReturnType<typeof makeKernelStore>) =>
        store.addGCActions([
          makeGCAction(asVatId('v1'), 'dropExport', asKRef('ko1')),
        ]),
      read: (store: ReturnType<typeof makeKernelStore>) => [
        ...store.getGCActions(),
      ],
    },
  ])('forgets what the abandoned crank wrote to $cache', ({ write, read }) => {
    crankThenRollBack(() => write(kernelStore));

    expect(read(kernelStore)).toStrictEqual([]);
  });

  it('drops a collection candidate the abandoned crank created', () => {
    crankThenRollBack(() => {
      const [kpid] = kernelStore.initKernelPromise();
      kernelStore.decrementRefCount(kpid, 'test');
    });

    // The next crank harvests the candidate set. A promise the rollback
    // deleted is not there to be read, so a stale candidate throws here and
    // kills the run loop over work that no longer exists.
    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.createCrankSavepoint('delivery');
    const [collectable] = kernelStore.initKernelPromise();
    kernelStore.decrementRefCount(collectable, 'test');
    kernelStore.collectGarbage();
    kernelStore.endCrank();

    expect(kernelStore.kernelRefExists(collectable)).toBe(false);
  });
});

describe('a crank whose release finds SQLite already ended its transaction', () => {
  it('leaves the caches and `reset` matching the store', async () => {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kernelStore = makeKernelStore(kdb);
    kdb.kernelKVStore.set('keySeed', 'seed');

    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.addGCActions([
      makeGCAction(asVatId('v1'), 'dropExport', asKRef('ko1')),
    ]);
    kdb.executeQuery('PRAGMA max_page_count = 1');
    expect(() => kdb.kernelKVStore.set('big', 'x'.repeat(100_000))).toThrow(
      'database or disk is full',
    );
    kdb.executeQuery('PRAGMA max_page_count = 1073741823');
    expect(() => kernelStore.endCrank()).toThrow(
      'SQLite already ended the transaction holding savepoint t0',
    );

    expect([...kernelStore.getGCActions()]).toStrictEqual([]);
    kernelStore.reset({ except: ['keySeed'] });
    expect(kdb.kernelKVStore.get('keySeed')).toBe('seed');
  });
});
