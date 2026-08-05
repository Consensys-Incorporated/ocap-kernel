import { describe, it, expect, beforeEach } from 'vitest';

import { makeMapKernelDatabase } from '../../../test/storage.ts';
import type { VatConfig, VatId } from '../../types.ts';
import { makeKernelStore } from '../index.ts';

/**
 * Regressions for the asymmetry described in
 * https://github.com/Consensys-Incorporated/ocap-kernel/issues/1006: creating
 * an import c-list entry changed no refcount while tearing one down decremented
 * both, and `initKernelObject` compensated by minting every object at (1, 1).
 * That constant came out right for exactly one importer, which is why nothing
 * noticed.
 */
describe('c-list reference accounting', () => {
  let kernelStore: ReturnType<typeof makeKernelStore>;

  /**
   * Register and initialize an endpoint so it can hold c-list entries.
   *
   * @param vatIds - The vats to bring into existence.
   */
  function givenVats(...vatIds: VatId[]): void {
    for (const vatId of vatIds) {
      kernelStore.setVatConfig(vatId, { sourceSpec: 'x' } as VatConfig);
      kernelStore.initEndpoint(vatId);
    }
  }

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
    kernelStore.markInitialized();
    kernelStore.setRefCountAuditing(true);
    givenVats('v1', 'v2', 'v3');
  });

  it('releases an endpoint c-list entry rather than dropping it', () => {
    kernelStore.initEndpoint('r1');
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
    kernelStore.translateRefKtoE('r1', kref, true);

    kernelStore.deleteEndpoint('r1');

    // A bare key delete would leave the count behind, pinning the object alive
    // on the strength of a holder that no longer exists.
    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 0,
      recognizable: 0,
    });
    expect(kernelStore.krefToEref('r1', kref)).toBeUndefined();
    expect(kernelStore.auditRefCounts()).toStrictEqual([]);
  });

  it('counts each importer separately', () => {
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');

    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 0,
      recognizable: 0,
    });

    kernelStore.translateRefKtoE('v2', kref, true);
    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 1,
      recognizable: 1,
    });

    kernelStore.translateRefKtoE('v3', kref, true);
    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 2,
      recognizable: 2,
    });
  });

  it('keeps an object alive for a second importer after the first lets go', () => {
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
    kernelStore.translateRefKtoE('v2', kref, true);
    kernelStore.translateRefKtoE('v3', kref, true);

    kernelStore.clearReachableFlag('v2', kref);
    kernelStore.forgetKref('v2', kref);
    kernelStore.collectGarbage();

    // v3 still holds it, so the owner must not be told to drop or retire
    expect([...kernelStore.getGCActions()]).toStrictEqual([]);
    expect(kernelStore.getReachableFlag('v3', kref)).toBe(true);
    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 1,
      recognizable: 1,
    });
    expect(kernelStore.auditRefCounts()).toStrictEqual([]);
  });

  it('drops an object once the last of several importers lets go', () => {
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
    for (const vatId of ['v2', 'v3'] as VatId[]) {
      kernelStore.translateRefKtoE(vatId, kref, true);
      kernelStore.clearReachableFlag(vatId, kref);
      kernelStore.forgetKref(vatId, kref);
    }
    kernelStore.collectGarbage();

    expect([...kernelStore.getGCActions()]).toStrictEqual([
      `v1 dropExport ${kref}`,
      `v1 retireExport ${kref}`,
    ]);
  });

  it('cleans up a terminated owner whose importer had already dropped', () => {
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
    kernelStore.translateRefKtoE('v2', kref, true);
    kernelStore.clearReachableFlag('v2', kref);
    kernelStore.markVatAsTerminated('v1');

    // Previously the owner's baseline decrement drove this below zero and threw
    // out of the middle of the export loop, leaving the vat half-cleaned
    expect(kernelStore.cleanupTerminatedVat('v1')).toStrictEqual({
      exports: 1,
      imports: 0,
      promises: 0,
      kv: 0,
    });
    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 0,
      recognizable: 1,
    });
    expect(kernelStore.auditRefCounts()).toStrictEqual([]);
  });

  it('restores reachability when a dropped import is handed over again', () => {
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
    const eref = kernelStore.translateRefKtoE('v2', kref, true);
    kernelStore.clearReachableFlag('v2', kref);

    expect(kernelStore.getReachableFlag('v2', kref)).toBe(false);
    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 0,
      recognizable: 1,
    });

    expect(kernelStore.translateRefKtoE('v2', kref, true)).toBe(eref);
    expect(kernelStore.getReachableFlag('v2', kref)).toBe(true);
    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 1,
      recognizable: 1,
    });
  });

  it('does not inflate the count when the same import is translated twice', () => {
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
    kernelStore.translateRefKtoE('v2', kref, true);
    kernelStore.translateRefKtoE('v2', kref, true);
    kernelStore.translateRefKtoE('v2', kref, true);

    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 1,
      recognizable: 1,
    });
  });

  it('collects an object whose only reference went splat', () => {
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
    kernelStore.incrementRefCount(kref, 'queue|slot');
    kernelStore.decrementRefCount(kref, 'deliver|splat|slot');

    // Previously this settled at (1,1) with no holder, forever
    expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 0,
      recognizable: 0,
    });
    kernelStore.collectGarbage();
    expect([...kernelStore.getGCActions()]).toStrictEqual([
      `v1 dropExport ${kref}`,
      `v1 retireExport ${kref}`,
    ]);
    expect(kernelStore.getImporters(kref)).toStrictEqual([]);
  });

  describe('an owner that gives up its own export', () => {
    it('frees the object once the last importer lets go', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.clearReachableFlag('v2', kref);
      kernelStore.collectGarbage();

      // The owner is told to drop, which clears its flag, and it then retires
      // the export itself — leaving nothing naming the object from its side.
      kernelStore.clearReachableFlag('v1', kref);
      kernelStore.forgetKref('v1', kref);
      kernelStore.orphanKernelObject(kref);

      kernelStore.forgetKref('v2', kref);
      kernelStore.collectGarbage();

      expect(kernelStore.kernelRefExists(kref)).toBe(false);
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    it('collects an orphan that no importer ever recognized', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');

      kernelStore.forgetKref('v1', kref);
      kernelStore.orphanKernelObject(kref);
      kernelStore.collectGarbage();

      expect(kernelStore.getOwner(kref)).toBeUndefined();
      expect(kernelStore.kernelRefExists(kref)).toBe(false);
    });

    it('retires stragglers that still recognize an orphaned object', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.clearReachableFlag('v2', kref);

      kernelStore.clearReachableFlag('v1', kref);
      kernelStore.forgetKref('v1', kref);
      kernelStore.orphanKernelObject(kref);
      kernelStore.collectGarbage();

      // v2 can still recognize it, so it has to be told the name is dead
      expect([...kernelStore.getGCActions()]).toStrictEqual([
        `v2 retireImport ${kref}`,
      ]);
    });

    it('survives an owner mapping left behind without a c-list entry', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.clearReachableFlag('v2', kref);
      kernelStore.clearReachableFlag('v1', kref);
      // Tear the owner's side down but leave the ownership record, the shape
      // that used to make the next collection read a key that wasn't there.
      kernelStore.forgetKref('v1', kref);
      kernelStore.forgetKref('v2', kref);

      expect(() => kernelStore.collectGarbage()).not.toThrow();
      expect(kernelStore.getOwner(kref)).toBeUndefined();
      expect(kernelStore.kernelRefExists(kref)).toBe(false);
    });
  });

  describe('cleanupTerminatedVat', () => {
    it('does nothing for a vat that is not terminated', () => {
      expect(kernelStore.cleanupTerminatedVat('v1')).toStrictEqual({
        exports: 0,
        imports: 0,
        promises: 0,
        kv: 0,
      });
    });

    it('orphans exports, releases imports, and forgets the vat', () => {
      const mine = kernelStore.exportFromEndpoint('v1', 'o+1');
      const theirs = kernelStore.exportFromEndpoint('v2', 'o+1');
      kernelStore.translateRefKtoE('v1', theirs, true);
      kernelStore.translateRefKtoE('v3', mine, true);
      kernelStore.markVatAsTerminated('v1');

      const work = kernelStore.cleanupTerminatedVat('v1');

      expect(work).toMatchObject({ exports: 1, imports: 1, promises: 0 });
      // v1's export is orphaned but still recognized by v3
      expect(kernelStore.getOwner(mine)).toBeUndefined();
      expect(kernelStore.getObjectRefCount(mine)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });
      // v1's import of v2's object is released
      expect(kernelStore.getObjectRefCount(theirs)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });
      expect(kernelStore.hasCListEntry('v1', mine)).toBe(false);
      expect(kernelStore.hasCListEntry('v1', theirs)).toBe(false);
      expect(kernelStore.isVatTerminated('v1')).toBe(false);
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    it('releases the c-list entry of a promise the vat was deciding', () => {
      const kpid = kernelStore.exportFromEndpoint('v1', 'p+1');
      kernelStore.setPromiseDecider(kpid, 'v1');
      kernelStore.translateRefKtoE('v2', kpid, true);
      // The caller rejects the orphans first, which is what releases the
      // unsettled-promise reference and clears the decider
      expect([...kernelStore.getPromisesByDecider('v1')]).toStrictEqual([kpid]);
      kernelStore.resolveKernelPromise(kpid, true, {
        body: '#"gone"',
        slots: [],
      });
      kernelStore.markVatAsTerminated('v1');

      const work = kernelStore.cleanupTerminatedVat('v1');

      expect(work).toMatchObject({ exports: 0, imports: 0, promises: 1 });
      expect(kernelStore.getRefCount(kpid)).toBe(1);
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    it('tolerates an importer entry that outlives the object it names', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v3', kref, true);
      // v3 has let go of the object but can still recognize the name
      kernelStore.clearReachableFlag('v3', kref);
      kernelStore.markVatAsTerminated('v1');
      kernelStore.cleanupTerminatedVat('v1');

      kernelStore.collectGarbage();

      // The collector deletes the object and queues the retirement together, so
      // v3's entry names a kref the kernel has already dropped until that action
      // is delivered. Counting it as a holder fails the end-of-crank audit on a
      // state the collector itself just created, which kills the run loop.
      expect([...kernelStore.getGCActions()]).toStrictEqual([
        `v3 retireImport ${kref}`,
      ]);
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    it('leaves a live vat that shares the object untouched', () => {
      const kref = kernelStore.exportFromEndpoint('v2', 'o+1');
      kernelStore.translateRefKtoE('v1', kref, true);
      kernelStore.translateRefKtoE('v3', kref, true);
      kernelStore.markVatAsTerminated('v1');

      kernelStore.cleanupTerminatedVat('v1');
      kernelStore.collectGarbage();

      expect(kernelStore.getReachableFlag('v3', kref)).toBe(true);
      expect([...kernelStore.getGCActions()]).toStrictEqual([]);
      expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });
    });
  });

  describe('three endpoints sharing one object', () => {
    it('accounts for every hand-off and release in turn', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      const importers = ['v2', 'v3'] as VatId[];

      for (const vatId of importers) {
        kernelStore.translateRefKtoE(vatId, kref, true);
      }
      expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
        reachable: 2,
        recognizable: 2,
      });
      expect(kernelStore.getImporters(kref)).toStrictEqual(importers);
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);

      // v2 drops but still recognizes
      kernelStore.clearReachableFlag('v2', kref);
      expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
        reachable: 1,
        recognizable: 2,
      });
      kernelStore.collectGarbage();
      expect([...kernelStore.getGCActions()]).toStrictEqual([]);

      // v2 retires; v3 keeps it alive
      kernelStore.forgetKref('v2', kref);
      kernelStore.collectGarbage();
      expect([...kernelStore.getGCActions()]).toStrictEqual([]);
      expect(kernelStore.getImporters(kref)).toStrictEqual(['v3']);

      // v3 lets go too, and only now is the owner told
      kernelStore.clearReachableFlag('v3', kref);
      kernelStore.forgetKref('v3', kref);
      kernelStore.collectGarbage();
      expect([...kernelStore.getGCActions()]).toStrictEqual([
        `v1 dropExport ${kref}`,
        `v1 retireExport ${kref}`,
      ]);
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });
  });
});
