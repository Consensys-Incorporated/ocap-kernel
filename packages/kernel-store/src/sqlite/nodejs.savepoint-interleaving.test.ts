import { describe, it, expect } from 'vitest';

import { makeSQLKernelDatabase } from './nodejs.ts';

/**
 * Why a crank and a savepoint of someone else's must never overlap.
 *
 * `KernelQueue.#runLoop` calls releasing its `crank` savepoint "this crank's one
 * commit point". `releaseAllSavepoints` releases `t0`, which is the outermost
 * savepoint only if the crank opened the first one, and `KernelStore`'s own
 * `createSavepoint` bypasses `ctx.savepoints` and so is invisible to the ordinal
 * numbering. Two production paths use it: `RemoteHandle.handleRemoteMessage` and
 * `RemoteManager.handleIncarnationChange`.
 *
 * Real SQLite through the real driver, one test per interleaving. Each records
 * what SQLite actually does, which is the reason the kernel now serializes the
 * two: `createSavepoint` refuses inside a crank, `startCrank` refuses while a
 * caller holds the store outside one, and callers take their turn through
 * `beginOutOfCrank`. See `crank.out-of-crank.test.ts` for the enforcement.
 */
describe('a savepoint the crank does not know about', () => {
  it('outside the crank, leaves the crank release with nothing to commit', async () => {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kv = kdb.kernelKVStore;

    // RemoteHandle.handleRemoteMessage, parked on its await.
    kdb.createSavepoint('receive_r1_7');

    // The run loop wakes: startCrank, then the two crank savepoints.
    kdb.createSavepoint('t0');
    kdb.createSavepoint('t1');
    kv.set('crankWrite', 'durable');

    // endCrank -> releaseAllSavepoints -> releaseSavepoint('t0'). `t0` is not the
    // outermost savepoint, so this releases into the remote's, not to a commit.
    kdb.releaseSavepoint('t0');

    // The remote message then fails, so RemoteHandle rolls its savepoint back,
    // and takes the whole committed-looking crank with it.
    kdb.rollbackSavepoint('receive_r1_7');

    expect(kv.get('crankWrite')).toBeUndefined();
    kdb.close();
  });

  it('inside the crank, is destroyed by the delivery rollback behind its owner', async () => {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kv = kdb.kernelKVStore;

    // startCrank
    kdb.createSavepoint('t0');
    kdb.createSavepoint('t1');

    // A remote message arrives during `await deliver(queueItem)`.
    kdb.createSavepoint('receive_r1_7');
    kv.set('remoteSeq.r1.highestReceivedSeq', '7');

    // The delivery aborts: rollbackCrank('delivery') issues ROLLBACK TO t1, and
    // SQLite cancels every savepoint started after t1 -- including the remote's.
    kdb.rollbackSavepoint('t1');

    // The remote handler, still inside its own try, reaches its release and
    // finds the savepoint gone along with everything it wrote.
    expect(() => kdb.releaseSavepoint('receive_r1_7')).toThrow(
      'No such savepoint: receive_r1_7',
    );
    expect(kv.get('remoteSeq.r1.highestReceivedSeq')).toBeUndefined();
    kdb.close();
  });

  it('inside a crank that succeeds, is committed under its owner', async () => {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kv = kdb.kernelKVStore;

    // A remote message arrives and gets as far as its await, so the seq row it
    // writes "at the end, within the transaction" is not written yet.
    kdb.createSavepoint('t0');
    kdb.createSavepoint('t1');
    kdb.createSavepoint('receive_r1_7');
    kv.set('remoteHalfDone', 'yes');

    // endCrank releases t0, and with it everything stacked above.
    kdb.releaseSavepoint('t0');

    // The remote handler resumes to find its savepoint gone -- and its
    // half-finished work durable regardless, so it reports a failure for an
    // effect that has landed and the peer retries it.
    expect(() => kdb.releaseSavepoint('receive_r1_7')).toThrow(
      'No such savepoint: receive_r1_7',
    );
    expect(kv.get('remoteHalfDone')).toBe('yes');
    kdb.close();
  });
});
