import { describe, it, expect, beforeEach } from 'vitest';

import { asVatId, asVRef } from '../../../test/branded.ts';
import { makeMapKernelDatabase } from '../../../test/storage.ts';
import { makeKernelStore } from '../index.ts';

describe('GC methods', () => {
  let kernelStore: ReturnType<typeof makeKernelStore>;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
  });

  describe('reachability tracking', () => {
    it('manages reachable flags', () => {
      const ko1 = kernelStore.initKernelObject(asVatId('v1'));
      kernelStore.addCListEntry(asVatId('v1'), ko1, asVRef('o-1'));

      // An import entry is born recognizing but not yet reaching
      expect(kernelStore.getReachableFlag(asVatId('v1'), ko1)).toBe(false);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 1,
      });

      kernelStore.setReachableFlag(asVatId('v1'), ko1);
      expect(kernelStore.getReachableFlag(asVatId('v1'), ko1)).toBe(true);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });

      kernelStore.clearReachableFlag(asVatId('v1'), ko1);
      expect(kernelStore.getReachableFlag(asVatId('v1'), ko1)).toBe(false);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 1,
      });
    });

    it.each(['setReachableFlag', 'clearReachableFlag'] as const)(
      'is idempotent: %s',
      (method) => {
        const ko1 = kernelStore.initKernelObject(asVatId('v1'));
        kernelStore.addCListEntry(asVatId('v1'), ko1, asVRef('o-1'));
        kernelStore.setReachableFlag(asVatId('v1'), ko1);

        const before = kernelStore.getObjectRefCount(ko1);
        kernelStore[method](asVatId('v1'), ko1);
        kernelStore[method](asVatId('v1'), ko1);
        const after = kernelStore.getObjectRefCount(ko1);

        expect(after).toStrictEqual(
          method === 'setReachableFlag'
            ? before
            : { reachable: 0, recognizable: 1 },
        );
      },
    );

    it('leaves an export entry alone: it carries no reachable count', () => {
      const ko1 = kernelStore.initKernelObject(asVatId('v1'));
      kernelStore.addCListEntry(asVatId('v1'), ko1, asVRef('o+1'));

      expect(kernelStore.getReachableFlag(asVatId('v1'), ko1)).toBe(true);
      kernelStore.setReachableFlag(asVatId('v1'), ko1);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });

      kernelStore.clearReachableFlag(asVatId('v1'), ko1);
      expect(kernelStore.getReachableFlag(asVatId('v1'), ko1)).toBe(false);
      expect(kernelStore.getObjectRefCount(ko1)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });
    });
  });
});
