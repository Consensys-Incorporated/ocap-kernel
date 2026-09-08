import type { KernelDatabase, KVStore } from '@metamask/kernel-store';
import { describe, it, expect, beforeEach } from 'vitest';

import { makeMapKernelDatabase } from '../../../test/storage.ts';
import type { KRef, VatConfig, VatId } from '../../types.ts';
import { makeKernelStore } from '../index.ts';

describe('reference count audit', () => {
  let kernelDatabase: KernelDatabase;
  let kernelStore: ReturnType<typeof makeKernelStore>;

  /**
   * The raw KV store, for writing rows the store's own methods never would.
   * Read through a function because the cases below are built before
   * `beforeEach` has made a database.
   *
   * @returns The KV store the running test is using.
   */
  const kv = (): KVStore => kernelDatabase.kernelKVStore;

  /**
   * Corrupt a row by overwriting it with a value the store would not produce.
   *
   * @param value - The raw value to write.
   * @returns A function that writes it at a given key.
   */
  const setValue =
    (value: string) =>
    (key: string): void => {
      kv().set(key, value);
    };

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

  /**
   * Overwrite a kref's stored count, going around the store's own arithmetic so
   * that drift can be introduced in either direction regardless of what the
   * current count happens to be.
   *
   * @param kref - The kref whose count to overwrite.
   * @param counts - The count text, in the store's encoding.
   */
  function setStoredCount(kref: KRef, counts: string): void {
    kv().set(`${kref}.refCount`, counts);
  }

  /**
   * Shift every component of a count by the same amount.
   *
   * @param counts - The count text, in the store's encoding.
   * @param delta - How far to shift each component.
   * @returns The shifted count text.
   */
  function shift(counts: string, delta: number): string {
    return counts
      .split(',')
      .map((part) => `${Number(part) + delta}`)
      .join(',');
  }

  beforeEach(() => {
    kernelDatabase = makeMapKernelDatabase();
    kernelStore = makeKernelStore(kernelDatabase);
    kernelStore.markInitialized();
    givenVats('v1', 'v2', 'v3');
  });

  describe('auditRefCounts', () => {
    it('finds nothing wrong in an empty store', () => {
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    it.each([
      {
        what: 'an export',
        act: (kref: KRef) => kref,
      },
      {
        what: 'an export plus one importer',
        act: (kref: KRef) => {
          kernelStore.translateRefKtoE('v2', kref, true);
          return kref;
        },
      },
      {
        what: 'an export plus two importers',
        act: (kref: KRef) => {
          kernelStore.translateRefKtoE('v2', kref, true);
          kernelStore.translateRefKtoE('v3', kref, true);
          return kref;
        },
      },
      {
        what: 'a dropped import',
        act: (kref: KRef) => {
          kernelStore.translateRefKtoE('v2', kref, true);
          kernelStore.clearReachableFlag('v2', kref);
          return kref;
        },
      },
      {
        what: 'a retired import',
        act: (kref: KRef) => {
          kernelStore.translateRefKtoE('v2', kref, true);
          kernelStore.clearReachableFlag('v2', kref);
          kernelStore.forgetKref('v2', kref);
          return kref;
        },
      },
      {
        what: 'a pin',
        act: (kref: KRef) => {
          kernelStore.pinObject(kref);
          return kref;
        },
      },
      {
        what: 'a queued message',
        act: (kref: KRef) => {
          kernelStore.enqueueRun({
            type: 'send',
            target: kref,
            message: { methargs: { body: '#[]', slots: [kref] }, result: null },
          });
          kernelStore.incrementRefCount(kref, 'queue|target');
          kernelStore.incrementRefCount(kref, 'queue|slot');
          return kref;
        },
      },
    ])('holds for $what', ({ act }) => {
      act(kernelStore.exportFromEndpoint('v1', 'o+1'));

      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    it('holds for a queued notification', () => {
      const kpid = kernelStore.exportFromEndpoint('v1', 'p+1');
      kernelStore.enqueueRun({ type: 'notify', endpointId: 'v2', kpid });
      kernelStore.incrementRefCount(kpid, 'notify');

      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    it('holds for an unsettled promise with importers', () => {
      const kpid = kernelStore.exportFromEndpoint('v1', 'p+1');
      kernelStore.translateRefKtoE('v2', kpid, true);

      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
      expect(kernelStore.getRefCount(kpid)).toBe(3);
    });

    it('holds for a settled promise whose value carries a slot', () => {
      const koid = kernelStore.exportFromEndpoint('v1', 'o+1');
      const kpid = kernelStore.exportFromEndpoint('v1', 'p+1');
      kernelStore.incrementRefCount(koid, 'resolve|slot');
      kernelStore.resolveKernelPromise(kpid, false, {
        body: '#"$0"',
        slots: [koid],
      });

      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    // `gc.ts` and `getKpidsToRetire` both tolerate a settled promise whose
    // value cannot be read, so the audit has to: the slot's holder is gone,
    // which is drift to report, not a reason to take the whole sweep down. A
    // `slots` that parses but is not an array is the dangerous one — iterating
    // a string would credit krefs that were never there, and a wrong audit is
    // worse than a loud one.
    it.each([
      {
        what: 'no value row at all',
        corrupt: (key: string) => kv().delete(key),
      },
      { what: 'a value that is not JSON', corrupt: setValue('{') },
      { what: 'a value of null', corrupt: setValue('null') },
      { what: 'a value that is not an object', corrupt: setValue('"gone"') },
      {
        what: 'an object carrying no slots',
        corrupt: setValue('{"body":"#null"}'),
      },
      {
        what: 'a slots that is a string',
        corrupt: setValue('{"body":"#null","slots":"ko1"}'),
      },
    ])(
      'reports a settled promise with $what rather than throwing',
      ({ corrupt }) => {
        const koid = kernelStore.exportFromEndpoint('v1', 'o+1');
        const kpid = kernelStore.exportFromEndpoint('v1', 'p+1');
        kernelStore.incrementRefCount(koid, 'resolve|slot');
        kernelStore.resolveKernelPromise(kpid, false, {
          body: '#"$0"',
          slots: [koid],
        });

        corrupt(`${kpid}.value`);

        expect(kernelStore.auditRefCounts()).toStrictEqual([
          {
            kind: 'mismatch',
            kref: koid,
            stored: '1,1',
            expected: '0,0',
            holders: [],
          },
        ]);
      },
    );

    it('reports counts that are too low', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.setObjectRefCount(kref, { reachable: 0, recognizable: 0 });

      expect(kernelStore.auditRefCounts()).toStrictEqual([
        {
          kind: 'mismatch',
          kref,
          stored: '0,0',
          expected: '1,1',
          holders: ['v2 c-list import o-1'],
        },
      ]);
    });

    it('reports counts that are too high even though nothing underflowed', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.setObjectRefCount(kref, { reachable: 1, recognizable: 1 });

      expect(kernelStore.auditRefCounts()).toStrictEqual([
        { kind: 'mismatch', kref, stored: '1,1', expected: '0,0', holders: [] },
      ]);
    });

    it('reports a reference to a kref that has been deleted', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.deleteKernelObject(kref);

      expect(kernelStore.auditRefCounts()).toStrictEqual([
        {
          kind: 'dangling',
          kref,
          expected: '1,1',
          holders: ['v2 c-list import o-1'],
        },
      ]);
    });

    it.each([
      { what: 'more reachable than recognizable', row: '3,1' },
      { what: 'not a pair of numbers', row: 'NaN,0' },
      { what: 'a promise count on an object', row: '1' },
    ])('reports a row that is $what', ({ row }) => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      // Written past the store's own guards, as a store drifted by an earlier
      // kernel would arrive: `getObjectRefCount` throws on all three, so
      // reading the row through it would take the whole sweep down with the
      // one violation it exists to report.
      setStoredCount(kref, row);

      expect(kernelStore.auditRefCounts()).toStrictEqual([
        {
          kind: 'mismatch',
          kref,
          stored: row,
          expected: '1,1',
          holders: ['v2 c-list import o-1'],
        },
      ]);
    });

    it('does not mistake an owner for a referrer', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');

      expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });
  });

  // The clean-audit cases above prove each rule agrees with whatever the store
  // did, which stays true if a rule and the code it mirrors are wrong by the
  // same constant. These pin each credit source to a literal count and holder
  // label, and check drift in both directions: too low collects a live
  // capability, too high leaks it.
  describe('each credit source, on its own', () => {
    const sources: {
      what: string;
      hold: () => KRef;
      expected: string;
      holders: string[];
    }[] = [
      {
        what: 'an object import a vat still reaches',
        hold: () => {
          const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
          kernelStore.translateRefKtoE('v2', kref, true);
          return kref;
        },
        expected: '1,1',
        holders: ['v2 c-list import o-1'],
      },
      {
        what: 'an object import a vat has dropped but not retired',
        hold: () => {
          const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
          kernelStore.translateRefKtoE('v2', kref, true);
          kernelStore.clearReachableFlag('v2', kref);
          return kref;
        },
        expected: '0,1',
        holders: ['v2 c-list import o-1'],
      },
      {
        what: 'a pinned object',
        hold: () => {
          const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
          kernelStore.pinObject(kref);
          return kref;
        },
        expected: '1,1',
        holders: ['pin'],
      },
      {
        what: "a run-queue send's target and slot",
        hold: () => {
          const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
          kernelStore.enqueueRun({
            type: 'send',
            target: kref,
            message: { methargs: { body: '#[]', slots: [kref] }, result: null },
          });
          kernelStore.incrementRefCount(kref, 'queue|target');
          kernelStore.incrementRefCount(kref, 'queue|slot');
          return kref;
        },
        expected: '2,2',
        holders: ['run queue #1 send target', 'run queue #1 send slot'],
      },
      {
        what: "a run-queue send's result promise",
        hold: () => {
          const target = kernelStore.exportFromEndpoint('v1', 'o+1');
          const kpid = kernelStore.initKernelPromise()[0];
          kernelStore.enqueueRun({
            type: 'send',
            target,
            message: { methargs: { body: '#[]', slots: [] }, result: kpid },
          });
          kernelStore.incrementRefCount(target, 'queue|target');
          kernelStore.incrementRefCount(kpid, 'queue|result');
          return kpid;
        },
        expected: '2',
        holders: ['unsettled promise', 'run queue #1 send result'],
      },
      {
        what: 'a queued notification',
        hold: () => {
          const kpid = kernelStore.exportFromEndpoint('v1', 'p+1');
          kernelStore.enqueueRun({ type: 'notify', endpointId: 'v2', kpid });
          kernelStore.incrementRefCount(kpid, 'notify');
          return kpid;
        },
        expected: '3',
        holders: [
          'unsettled promise',
          'run queue #1 notify',
          'v1 c-list export p+1',
        ],
      },
      {
        // `enqueuePromiseMessage` takes the references itself, which is the
        // point of the transfer-don't-duplicate fix; incrementing here too
        // would be the double-count it exists to prevent.
        what: 'a message parked on an unresolved promise',
        hold: () => {
          const target = kernelStore.exportFromEndpoint('v1', 'o+1');
          const kpid = kernelStore.initKernelPromise()[0];
          kernelStore.enqueuePromiseMessage(kpid, {
            methargs: { body: '#[]', slots: [target] },
            result: null,
          });
          return kpid;
        },
        expected: '2',
        holders: ['unsettled promise', 'kp1 queue #1 target'],
      },
      {
        what: 'a promise nobody has settled yet',
        hold: () => kernelStore.initKernelPromise()[0],
        expected: '1',
        holders: ['unsettled promise'],
      },
      {
        what: "a settled promise's resolution slot",
        hold: () => {
          const koid = kernelStore.exportFromEndpoint('v1', 'o+1');
          const kpid = kernelStore.exportFromEndpoint('v1', 'p+1');
          kernelStore.incrementRefCount(koid, 'resolve|slot');
          kernelStore.resolveKernelPromise(kpid, false, {
            body: '#"$0"',
            slots: [koid],
          });
          return koid;
        },
        expected: '1,1',
        holders: ['kp1 resolution slot'],
      },
      {
        what: "a promise's own c-list entries",
        hold: () => {
          const kpid = kernelStore.exportFromEndpoint('v1', 'p+1');
          kernelStore.translateRefKtoE('v2', kpid, true);
          return kpid;
        },
        expected: '3',
        holders: [
          'unsettled promise',
          'v1 c-list export p+1',
          'v2 c-list import p-1',
        ],
      },
    ];

    it.each(sources)('credits $what exactly', ({ hold, expected, holders }) => {
      const kref = hold();

      expect(kernelStore.auditRefCounts()).toStrictEqual([]);

      for (const delta of [1, -1]) {
        const stored = shift(expected, delta);
        setStoredCount(kref, stored);
        expect(kernelStore.auditRefCounts()).toStrictEqual([
          { kind: 'mismatch', kref, stored, expected, holders },
        ]);
      }
    });
  });

  describe('assertRefCountsIfAuditing', () => {
    it('does nothing while auditing is off', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.setObjectRefCount(kref, { reachable: 9, recognizable: 9 });

      expect(() => kernelStore.assertRefCountsIfAuditing()).not.toThrow();
    });

    it('throws with the offending krefs once auditing is on', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.setObjectRefCount(kref, { reachable: 9, recognizable: 9 });
      kernelStore.setRefCountAuditing(true);

      expect(() => kernelStore.assertRefCountsIfAuditing()).toThrow(
        `${kref}: stored 9,9, expected 0,0`,
      );
    });

    it('stays quiet when the counts agree', () => {
      kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.setRefCountAuditing(true);

      expect(() => kernelStore.assertRefCountsIfAuditing()).not.toThrow();
    });
  });

  describe('recomputeRefCounts', () => {
    it('rebuilds counts written under the old accounting', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.translateRefKtoE('v3', kref, true);
      // As the pre-fix kernel would have left it: born (1,1), with neither
      // importer's c-list entry taking a reference. Two importers is the
      // smallest topology where that disagrees with the truth — with one, the
      // phantom baseline happens to come out to the right number.
      kernelStore.setObjectRefCount(kref, { reachable: 1, recognizable: 1 });

      const { corrected, unfixable } = kernelStore.recomputeRefCounts();

      expect(corrected).toStrictEqual([
        {
          kind: 'mismatch',
          kref,
          stored: '1,1',
          expected: '2,2',
          holders: ['v2 c-list import o-1', 'v3 c-list import o-1'],
        },
      ]);
      expect(unfixable).toStrictEqual([]);
      expect(kernelStore.getObjectRefCount(kref)).toStrictEqual({
        reachable: 2,
        recognizable: 2,
      });
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    it('reports references it cannot repair', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.deleteKernelObject(kref);

      const { corrected, unfixable } = kernelStore.recomputeRefCounts();

      expect(corrected).toStrictEqual([]);
      expect(unfixable).toHaveLength(1);
      expect(unfixable[0]?.kref).toBe(kref);
    });

    it('rebuilds a promise count', () => {
      const kpid = kernelStore.exportFromEndpoint('v1', 'p+1');
      kernelStore.translateRefKtoE('v2', kpid, true);
      // A promise has one undifferentiated count, so its repair goes down a
      // different path from an object's pair.
      kernelStore.incrementRefCount(kpid, 'phantom');
      kernelStore.incrementRefCount(kpid, 'phantom');

      const { corrected, unfixable } = kernelStore.recomputeRefCounts();

      expect(corrected).toStrictEqual([
        {
          kind: 'mismatch',
          kref: kpid,
          stored: '5',
          expected: '3',
          holders: [
            'unsettled promise',
            'v1 c-list export p+1',
            'v2 c-list import p-1',
          ],
        },
      ]);
      expect(unfixable).toStrictEqual([]);
      expect(kernelStore.getRefCount(kpid)).toBe(3);
      expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    });

    it('queues krefs it zeroes for collection', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.setObjectRefCount(kref, { reachable: 1, recognizable: 1 });

      kernelStore.recomputeRefCounts();
      kernelStore.collectGarbage();

      expect([...kernelStore.getGCActions()]).toStrictEqual([
        `v1 dropExport ${kref}`,
        `v1 retireExport ${kref}`,
      ]);
    });
  });

  describe('formatRefCountViolations', () => {
    it('names the holders behind a mismatch', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.setObjectRefCount(kref, { reachable: 0, recognizable: 0 });

      expect(
        kernelStore.formatRefCountViolations(kernelStore.auditRefCounts()),
      ).toBe(
        `${kref}: stored 0,0, expected 1,1 (held by: v2 c-list import o-1)`,
      );
    });

    it('says so when a mismatch has no holders at all', () => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.setObjectRefCount(kref, { reachable: 1, recognizable: 1 });

      expect(
        kernelStore.formatRefCountViolations(kernelStore.auditRefCounts()),
      ).toBe(`${kref}: stored 1,1, expected 0,0 (held by: nothing)`);
    });
  });
});
