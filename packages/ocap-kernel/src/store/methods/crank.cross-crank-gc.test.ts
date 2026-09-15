import { describe, it, expect, beforeEach } from 'vitest';

import { makeMapKernelDatabase } from '../../../test/storage.ts';
import { makeKernelStore } from '../index.ts';

/**
 * Only `collectGarbage` empties `maybeFreeKrefs`, so a candidate added while no
 * crank was open is still owed a collection and has to survive an unrelated
 * crank's rollback. A peer restart is the real producer: it runs from a network
 * callback, `forgetEndpointImports` adds every export the peer abandoned, and
 * nothing collects them until the next crank harvests.
 *
 * Discarding them would leave those objects orphaned, undeleted, and invisible
 * even to the reference count audit, which reads an orphan with no holders and
 * a count of zero as consistent.
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
    kernelStore.forgetEndpointImports('r1');
    return kref;
  }

  /**
   * Run one crank, optionally rolling its delivery back.
   *
   * @param options - How the crank ends.
   * @param options.rollback - Whether the delivery aborts.
   * @param options.harvest - Whether the crank reaches `collectGarbage`. The
   * run loop's own catch rolls back and rethrows, so an aborted crank does not.
   */
  function runCrank({
    rollback = false,
    harvest = true,
  }: { rollback?: boolean; harvest?: boolean } = {}): void {
    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('start');
    if (rollback) {
      kernelStore.rollbackCrank('start');
    }
    if (harvest) {
      kernelStore.collectGarbage();
    }
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

    runCrank({ rollback: true, harvest: false });
    for (let crank = 0; crank < 5; crank += 1) {
      runCrank();
    }

    expect(kernelStore.kernelRefExists(kref)).toBe(false);
  });
});
