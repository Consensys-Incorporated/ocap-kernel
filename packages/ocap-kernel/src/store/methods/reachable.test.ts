import { describe, it, expect, beforeEach } from 'vitest';

import { makeMapKernelDatabase } from '../../../test/storage.ts';
import type { KRef } from '../../types.ts';
import { makeKernelStore } from '../index.ts';

describe('GC methods', () => {
  let kernelStore: ReturnType<typeof makeKernelStore>;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
  });

  describe('reachability tracking', () => {
    it('manages reachable flags', () => {
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o-1');

      // An import entry is born recognizing but not yet reaching
      expect(kernelStore.getReachableFlag('v1', ko1)).toBe(false);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 1,
      });

      kernelStore.setReachableFlag('v1', ko1);
      expect(kernelStore.getReachableFlag('v1', ko1)).toBe(true);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });

      kernelStore.clearReachableFlag('v1', ko1);
      expect(kernelStore.getReachableFlag('v1', ko1)).toBe(false);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 1,
      });
    });

    /**
     * Give v1 an import entry it reaches, the state both idempotence tests
     * start from.
     *
     * @returns The kref of the reached import.
     */
    function givenReachedImport(): KRef {
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o-1');
      kernelStore.setReachableFlag('v1', ko1);
      return ko1;
    }

    it('setReachableFlag is idempotent', () => {
      const ko1 = givenReachedImport();

      kernelStore.setReachableFlag('v1', ko1);
      kernelStore.setReachableFlag('v1', ko1);

      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });
    });

    it('clearReachableFlag is idempotent', () => {
      const ko1 = givenReachedImport();

      kernelStore.clearReachableFlag('v1', ko1);
      kernelStore.clearReachableFlag('v1', ko1);

      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 1,
      });
    });

    it('leaves an export entry alone: it carries no reachable count', () => {
      const ko1 = kernelStore.initKernelObject('v1');
      kernelStore.addCListEntry('v1', ko1, 'o+1');

      expect(kernelStore.getReachableFlag('v1', ko1)).toBe(true);
      kernelStore.setReachableFlag('v1', ko1);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });

      kernelStore.clearReachableFlag('v1', ko1);
      expect(kernelStore.getReachableFlag('v1', ko1)).toBe(false);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });
    });
  });
});
