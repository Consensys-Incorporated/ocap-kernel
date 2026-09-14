import { describe, it, expect, beforeEach } from 'vitest';

import { processGCActionSet } from './garbage-collection.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';
import { makeKernelStore } from '../store/index.ts';

describe('garbage-collection', () => {
  describe('processGCActionSet', () => {
    let kernelStore: ReturnType<typeof makeKernelStore>;

    beforeEach(() => {
      kernelStore = makeKernelStore(makeMapKernelDatabase());
    });

    it('processes dropExport actions', () => {
      // Setup: Create object and add GC action
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o+1'); // Export reference

      // Set reachable count to 0 but keep recognizable count
      kernelStore.setObjectRefCount(ko1, { reachable: 0, recognizable: 1 });

      kernelStore.addGCActions([`v1 dropExport ${ko1}`]);

      // Initial state checks
      expect(kernelStore.getReachableFlag('v1', ko1)).toBe(true);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 1,
      });

      // Process GC actions
      const result = processGCActionSet(kernelStore);

      // Verify result
      expect(result).toStrictEqual({
        type: 'dropExports',
        endpointId: 'v1',
        krefs: [ko1],
      });

      // Verify actions were removed
      expect(kernelStore.getGCActions().size).toBe(0);
    });

    it('processes retireExport actions', () => {
      // Setup: Create object with zero refcounts
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o+1');
      kernelStore.setObjectRefCount(ko1, { reachable: 0, recognizable: 0 });
      kernelStore.addGCActions([`v1 retireExport ${ko1}`]);

      // Process GC actions
      const result = processGCActionSet(kernelStore);

      // Verify result
      expect(result).toStrictEqual({
        type: 'retireExports',
        endpointId: 'v1',
        krefs: [ko1],
      });

      // Verify actions were removed
      expect(kernelStore.getGCActions().size).toBe(0);
    });

    it('processes retireImport actions', () => {
      // Setup: Create object and add GC action
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v2', ko1, 'o-1'); // Import reference
      kernelStore.addGCActions([`v2 retireImport ${ko1}`]);

      // Process GC actions
      const result = processGCActionSet(kernelStore);

      // Verify result
      expect(result).toStrictEqual({
        type: 'retireImports',
        endpointId: 'v2',
        krefs: [ko1],
      });

      // Verify actions were removed
      expect(kernelStore.getGCActions().size).toBe(0);
    });

    it('groups two actions of one type for one vat into a single item', () => {
      const ko1 = kernelStore.initKernelObject('v1');
      const ko2 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o+1');
      kernelStore.addCListEntry('v1', ko2, 'o+2');
      kernelStore.setObjectRefCount(ko1, { reachable: 0, recognizable: 1 });
      kernelStore.setObjectRefCount(ko2, { reachable: 0, recognizable: 1 });
      kernelStore.addGCActions([
        `v1 dropExport ${ko2}`,
        `v1 dropExport ${ko1}`,
      ]);

      expect(processGCActionSet(kernelStore)).toStrictEqual({
        type: 'dropExports',
        endpointId: 'v1',
        krefs: [ko1, ko2],
      });
    });

    it('processes actions in priority order', () => {
      // Setup: Create objects and add multiple GC actions
      const ko1 = kernelStore.initKernelObject('v1');
      const ko2 = kernelStore.initKernelObject('v1');

      kernelStore.addCListEntry('v1', ko1, 'o+1');
      kernelStore.addCListEntry('v1', ko2, 'o+2');

      // Set up conditions for dropExport and retireExport
      kernelStore.setObjectRefCount(ko1, { reachable: 0, recognizable: 1 });
      kernelStore.setObjectRefCount(ko2, { reachable: 0, recognizable: 0 });

      // Add actions in reverse priority order
      kernelStore.addGCActions([
        `v1 retireExport ${ko2}`,
        `v1 dropExport ${ko1}`,
      ]);

      // Process first action - should be dropExport
      let result = processGCActionSet(kernelStore);
      expect(result).toStrictEqual({
        type: 'dropExports',
        endpointId: 'v1',
        krefs: [ko1],
      });

      // Process second action - should be retireExport
      result = processGCActionSet(kernelStore);
      expect(result).toStrictEqual({
        type: 'retireExports',
        endpointId: 'v1',
        krefs: [ko2],
      });
    });

    it('processes actions by vat ID order', () => {
      // Setup: Create objects in different vats
      const ko1 = kernelStore.initKernelObject('v2');
      const ko2 = kernelStore.initKernelObject('v1');

      kernelStore.addCListEntry('v2', ko1, 'o+1');
      kernelStore.addCListEntry('v1', ko2, 'o+1');

      // Set up conditions for dropExport
      kernelStore.setObjectRefCount(ko1, { reachable: 0, recognizable: 1 });
      kernelStore.setObjectRefCount(ko2, { reachable: 0, recognizable: 1 });

      // Add actions in reverse vat order
      kernelStore.addGCActions([
        `v2 dropExport ${ko1}`,
        `v1 dropExport ${ko2}`,
      ]);

      // Process first action - should be v1
      let result = processGCActionSet(kernelStore);
      expect(result).toStrictEqual({
        type: 'dropExports',
        endpointId: 'v1',
        krefs: [ko2],
      });

      // Process second action - should be v2
      result = processGCActionSet(kernelStore);
      expect(result).toStrictEqual({
        type: 'dropExports',
        endpointId: 'v2',
        krefs: [ko1],
      });
    });

    it('skips actions that should not be processed', () => {
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o+1');

      // Add dropExport action but set reachable to false (should skip)
      kernelStore.clearReachableFlag('v1', ko1);
      kernelStore.addGCActions([`v1 dropExport ${ko1}`]);

      // Process actions - should return undefined since action should be skipped
      const result = processGCActionSet(kernelStore);
      expect(result).toBeUndefined();

      // Verify action was removed from set
      expect(kernelStore.getGCActions().size).toBe(0);
    });

    it('returns undefined when no actions to process', () => {
      const result = processGCActionSet(kernelStore);
      expect(result).toBeUndefined();
    });

    it('skips dropExport when object does not exist', () => {
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o+1');

      // Delete the object to simulate non-existence
      kernelStore.deleteKernelObject(ko1);

      kernelStore.addGCActions([`v1 dropExport ${ko1}`]);

      const result = processGCActionSet(kernelStore);
      expect(result).toBeUndefined();
      expect(kernelStore.getGCActions().size).toBe(0);
    });

    it('skips retireExport when object has non-zero refcounts', () => {
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o+1');

      // Set non-zero refcounts
      kernelStore.setObjectRefCount(ko1, { reachable: 1, recognizable: 1 });

      kernelStore.addGCActions([`v1 retireExport ${ko1}`]);

      const result = processGCActionSet(kernelStore);
      expect(result).toBeUndefined();
      expect(kernelStore.getGCActions().size).toBe(0);
    });

    it('skips retireExport when object does not exist', () => {
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o+1');

      // Delete the object
      kernelStore.deleteKernelObject(ko1);

      kernelStore.addGCActions([`v1 retireExport ${ko1}`]);

      const result = processGCActionSet(kernelStore);
      expect(result).toBeUndefined();
      expect(kernelStore.getGCActions().size).toBe(0);
    });

    it('skips retireExport when clist entry does not exist', () => {
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.setObjectRefCount(ko1, { reachable: 0, recognizable: 0 });

      kernelStore.addGCActions([`v1 retireExport ${ko1}`]);

      const result = processGCActionSet(kernelStore);
      expect(result).toBeUndefined();
      expect(kernelStore.getGCActions().size).toBe(0);
    });

    it('skips retireImport when clist entry does not exist', () => {
      const ko1 = kernelStore.initKernelObject('v1');

      kernelStore.addGCActions([`v2 retireImport ${ko1}`]);

      const result = processGCActionSet(kernelStore);
      expect(result).toBeUndefined();
      expect(kernelStore.getGCActions().size).toBe(0);
    });

    it('skips retireExport when object is recognizable', () => {
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o+1');

      // Set only recognizable count to non-zero
      kernelStore.setObjectRefCount(ko1, { reachable: 0, recognizable: 1 });

      kernelStore.addGCActions([`v1 retireExport ${ko1}`]);

      const result = processGCActionSet(kernelStore);
      expect(result).toBeUndefined();
      expect(kernelStore.getGCActions().size).toBe(0);
    });
  });
});
