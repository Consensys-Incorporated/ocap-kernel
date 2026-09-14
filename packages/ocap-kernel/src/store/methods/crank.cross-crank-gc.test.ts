import { describe, it, expect, beforeEach } from 'vitest';

import { makeMapKernelDatabase } from '../../../test/storage.ts';
import { makeKernelStore } from '../index.ts';

/**
 * `revertStateBeneathRollback` reverts `maybeFreeKrefs`, which nothing else
 * rolls back. The set is not per-crank: only `collectGarbage` empties it, so a
 * candidate added while no crank was open is still owed a collection and has to
 * survive an unrelated crank's rollback.
 *
 * `RemoteManager.#handlePeerIncarnation` is one such producer. It runs from a
 * network callback with no crank open, under its own `peerIncarnation_<peerId>`
 * savepoint, and `persistPeerRestart` -> `forgetEndpointImports` adds every
 * export the restarting peer abandoned. It calls no `collectGarbage` of its own,
 * so those krefs wait for the next crank's harvest -- and their kv state is
 * already committed by the time it comes. A rollback that discarded them would
 * leave the objects orphaned, undeleted, and invisible even to the reference
 * count audit, which sees an orphan with no holders and a count of zero as
 * consistent.
 */
describe('a GC candidate produced outside a crank', () => {
  let kernelStore: ReturnType<typeof makeKernelStore>;

  /**
   * Abandon a remote's export the way a peer restart does.
   *
   * @returns The kref of the now-ownerless object.
   */
  function orphanARemoteExport(): string {
    const kref = kernelStore.initKernelObject('r1');
    kernelStore.addCListEntry('r1', kref, 'o+1');
    // RemoteManager.#handlePeerIncarnation, inside its own savepoint, no crank.
    kernelStore.forgetEndpointImports('r1');
    return kref;
  }

  /**
   * Run one crank, optionally rolling its delivery back.
   *
   * @param options - How the crank ends.
   * @param options.rollback - Whether the delivery aborts.
   */
  function runCrank({ rollback = false }: { rollback?: boolean } = {}): void {
    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.createCrankSavepoint('delivery');
    if (rollback) {
      kernelStore.rollbackCrank('delivery');
    }
    kernelStore.collectGarbage();
    kernelStore.endCrank();
  }

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
  });

  it('is collected by the next crank that succeeds', () => {
    const kref = orphanARemoteExport();

    runCrank();

    expect(kernelStore.kernelRefExists(kref)).toBe(false);
  });

  it('is collected by the next crank that rolls back', () => {
    const kref = orphanARemoteExport();

    runCrank({ rollback: true });

    expect(kernelStore.kernelRefExists(kref)).toBe(false);
  });

  it('survives a rollback of a crank that never touched it', () => {
    const kref = orphanARemoteExport();

    runCrank({ rollback: true });
    for (let crank = 0; crank < 5; crank += 1) {
      runCrank();
    }

    expect(kernelStore.kernelRefExists(kref)).toBe(false);
  });
});
