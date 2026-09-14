import { describe, it, expect, beforeEach } from 'vitest';

import { makeMapKernelDatabase } from '../../../test/storage.ts';
import type { KRef, EndpointId } from '../../types.ts';
import { makeGCAction } from '../../types.ts';
import { makeKernelStore } from '../index.ts';

describe('GC methods', () => {
  let kernelStore: ReturnType<typeof makeKernelStore>;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
  });

  describe('GC actions', () => {
    it('manages all valid GC action types', () => {
      const v1Object = kernelStore.initKernelObject('v1');
      const v2Object = kernelStore.initKernelObject('v1');
      const v3Object = kernelStore.initKernelObject('v2');

      const validActions = [
        makeGCAction('v1' as EndpointId, 'dropExport', v1Object),
        makeGCAction('v1' as EndpointId, 'retireExport', v2Object),
        makeGCAction('v2' as EndpointId, 'retireImport', v3Object),
      ];

      kernelStore.addGCActions(validActions);

      const actions = kernelStore.getGCActions();
      expect(actions.size).toBe(3);
      expect(actions).toStrictEqual(new Set(validActions));
    });

    it('manages GC actions for remote endpoints', () => {
      const r0Object = kernelStore.initKernelObject('r0');
      const r1Object = kernelStore.initKernelObject('r1');

      const remoteActions = [
        makeGCAction('r0' as EndpointId, 'dropExport', r0Object),
        makeGCAction('r1' as EndpointId, 'retireExport', r1Object),
      ];

      kernelStore.addGCActions(remoteActions);

      const actions = kernelStore.getGCActions();
      expect(actions.size).toBe(2);
      expect(actions).toStrictEqual(new Set(remoteActions));
    });

    it('rejects promise krefs at construction time', () => {
      expect(() => makeGCAction('v1', 'dropExport', 'kp1' as KRef)).toThrow(
        'GC actions only apply to objects',
      );
    });

    it('maintains action order when storing', () => {
      const v1Object = kernelStore.initKernelObject('v1');
      const v2Object = kernelStore.initKernelObject('v2');
      const v3Object = kernelStore.initKernelObject('v3');

      const actions = [
        makeGCAction('v3' as EndpointId, 'retireImport', v3Object),
        makeGCAction('v1' as EndpointId, 'dropExport', v1Object),
        makeGCAction('v2' as EndpointId, 'retireExport', v2Object),
      ];

      kernelStore.setGCActions(new Set(actions));

      // Actions should be sorted when retrieved
      const sortedActions = Array.from(kernelStore.getGCActions());
      expect(sortedActions).toStrictEqual([
        `v1 dropExport ${v1Object}`,
        `v2 retireExport ${v2Object}`,
        `v3 retireImport ${v3Object}`,
      ]);
    });
  });

  describe('reaping', () => {
    it('processes reap queue in order', () => {
      const vatIds = ['v1', 'v2', 'v3'];

      // Schedule multiple vats for reaping
      vatIds.forEach((vatId) => kernelStore.scheduleReap(vatId));

      // Verify they are processed in order
      vatIds.forEach((endpointId) => {
        expect(kernelStore.nextReapAction()).toStrictEqual({
          type: 'bringOutYourDead',
          endpointId,
        });
      });

      // Queue should be empty after processing all items
      expect(kernelStore.nextReapAction()).toBeUndefined();
    });

    it('handles duplicate reap scheduling', () => {
      kernelStore.scheduleReap('v1');
      kernelStore.scheduleReap('v1'); // Duplicate scheduling
      kernelStore.scheduleReap('v2');

      // Should only process v1 once
      expect(kernelStore.nextReapAction()).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: 'v1',
      });

      expect(kernelStore.nextReapAction()).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: 'v2',
      });

      expect(kernelStore.nextReapAction()).toBeUndefined();
    });

    it('schedules remote IDs for reaping', () => {
      kernelStore.scheduleReap('r0');
      kernelStore.scheduleReap('r1');

      expect(kernelStore.nextReapAction()).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: 'r0',
      });

      expect(kernelStore.nextReapAction()).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: 'r1',
      });

      expect(kernelStore.nextReapAction()).toBeUndefined();
    });

    it('interleaves vat and remote reap scheduling', () => {
      kernelStore.scheduleReap('v1');
      kernelStore.scheduleReap('r0');
      kernelStore.scheduleReap('v2');

      expect(kernelStore.nextReapAction()).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: 'v1',
      });

      expect(kernelStore.nextReapAction()).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: 'r0',
      });

      expect(kernelStore.nextReapAction()).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: 'v2',
      });

      expect(kernelStore.nextReapAction()).toBeUndefined();
    });

    it('handles duplicate remote reap scheduling', () => {
      kernelStore.scheduleReap('r0');
      kernelStore.scheduleReap('r0');

      expect(kernelStore.nextReapAction()).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: 'r0',
      });

      expect(kernelStore.nextReapAction()).toBeUndefined();
    });
  });

  describe('retireKernelObjects', () => {
    it('retires objects by notifying importers', () => {
      // First, set up vat configurations so they are recognized by getVatIDs()
      kernelStore.setVatConfig('v1', { bundleName: 'vat1' });
      kernelStore.setVatConfig('v2', { bundleName: 'vat2' });
      kernelStore.setVatConfig('v3', { bundleName: 'vat3' });

      // Create objects owned by v1
      const ko1 = kernelStore.initKernelObject('v1');
      const ko2 = kernelStore.initKernelObject('v1');

      // Set up import relationships: v2 and v3 import objects from v1
      // The key is using import direction (o-N) for the importing vats
      kernelStore.addCListEntry('v2', ko1, 'o-1'); // v2 imports ko1 as o-1
      kernelStore.addCListEntry('v3', ko1, 'o-2'); // v3 imports ko1 as o-2
      kernelStore.addCListEntry('v3', ko2, 'o-3'); // v3 imports ko2 as o-3

      // Clear any existing GC actions
      kernelStore.setGCActions(new Set());

      // Should not throw when retiring objects
      expect(() => kernelStore.retireKernelObjects([ko1, ko2])).not.toThrow();
      const actions = kernelStore.getGCActions();

      const retireActions = Array.from(actions).filter((action) =>
        action.includes('retireImport'),
      );
      expect(retireActions.length).toBeGreaterThan(0);

      // Objects should still be accessible (they may not be deleted immediately)
      expect(kernelStore.getObjectRefCount(ko1)).toBeDefined();
      expect(kernelStore.getObjectRefCount(ko2)).toBeDefined();
    });

    // The object is deleted once the importers have been told, so a remote
    // left out keeps a c-list entry naming a kref that no longer exists — which
    // the audit reports as dangling, killing the run loop.
    it('tells a remote importer too', () => {
      kernelStore.setVatConfig('v1', { bundleName: 'vat1' });
      kernelStore.setRemoteInfo('r1', {
        peerId: 'peer-1',
      } as unknown as Parameters<typeof kernelStore.setRemoteInfo>[1]);
      const kref = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('r1', kref, 'ro-1');
      kernelStore.setGCActions(new Set());

      kernelStore.retireKernelObjects([kref]);

      expect([...kernelStore.getGCActions()]).toStrictEqual([
        `r1 retireImport ${kref}`,
      ]);
    });

    it('throws for non-array input', () => {
      expect(() => {
        kernelStore.retireKernelObjects('not-an-array' as unknown as KRef[]);
      }).toThrow('retireExports given non-Array');
    });
  });

  describe('collectGarbage', () => {
    it('calls collectGarbage without errors', () => {
      // Basic test to ensure collectGarbage can be called
      expect(() => kernelStore.collectGarbage()).not.toThrow();
    });

    it('processes empty maybeFreeKrefs set', () => {
      // Test with no items to garbage collect
      kernelStore.collectGarbage();

      // Should complete without errors
      const actions = kernelStore.getGCActions();
      expect(actions).toBeInstanceOf(Set);
    });

    it('handles basic object garbage collection setup', () => {
      // Create a subcluster and vat first
      const subclusterId = kernelStore.addSubcluster({
        bootstrap: 'v1',
        vats: { v1: { bundleName: 'test' } },
      });
      kernelStore.addSubclusterVat(subclusterId, 'v1', 'v1');

      const ko1 = kernelStore.initKernelObject('v1');

      // Set up basic object state
      kernelStore.addCListEntry('v1', ko1, 'o+1');

      // Run garbage collection
      kernelStore.collectGarbage();

      // Should complete without errors
      expect(kernelStore.getObjectRefCount(ko1)).toBeDefined();
    });

    it('handles kernel-owned objects during GC', () => {
      const ko1 = kernelStore.initKernelObject('kernel');

      // Kernel objects should not be garbage collected
      kernelStore.collectGarbage();

      // Object should still exist
      expect(kernelStore.getObjectRefCount(ko1)).toBeDefined();
    });
  });
});
