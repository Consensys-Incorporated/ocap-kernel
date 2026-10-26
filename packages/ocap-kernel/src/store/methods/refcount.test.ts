import type { KVStore } from '@metamask/kernel-store';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getRefCountMethods } from './refcount.ts';
import { makeMapKVStore } from '../../../test/storage.ts';
import type { KRef } from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { getBaseMethods } from './base.ts';
import { asKRef } from '../../../test/branded.ts';

describe('refcount-methods', () => {
  let kv: KVStore;
  let refCountMethods: ReturnType<typeof getRefCountMethods>;
  let baseStore: ReturnType<typeof getBaseMethods>;
  let maybeFreeKrefs: Set<KRef>;
  const mockGetObjectRefCount = vi.fn();
  const mockSetObjectRefCount = vi.fn();

  beforeEach(() => {
    kv = makeMapKVStore();
    maybeFreeKrefs = new Set<KRef>();
    baseStore = getBaseMethods(kv);
    refCountMethods = getRefCountMethods({
      kv,
      maybeFreeKrefs,
    } as StoreContext);

    // Reset mocks
    mockGetObjectRefCount.mockReset();
    mockSetObjectRefCount.mockReset();

    // Default mock implementations
    mockGetObjectRefCount.mockImplementation(() => ({
      reachable: 1,
      recognizable: 1,
    }));
  });

  describe('getRefCount', () => {
    it('returns 0 for non-existent references', () => {
      kv.set(baseStore.refCountKey(asKRef('ko99')), '0');
      expect(refCountMethods.getRefCount(asKRef('ko99'))).toBe(0);
    });

    it('handles undefined values by returning NaN', () => {
      expect(
        Number.isNaN(refCountMethods.getRefCount('nonexistent' as KRef)),
      ).toBe(true);
    });

    it('returns the correct reference count for existing references', () => {
      const kref = asKRef('ko1');
      kv.set(`${kref}.refCount`, '5');
      expect(refCountMethods.getRefCount(kref)).toBe(5);
    });
  });

  describe('incRefCount', () => {
    it('initializes and increments reference count for new references', () => {
      const kref = asKRef('ko1');

      kv.set(baseStore.refCountKey(kref), '0');

      expect(refCountMethods.incRefCount(kref)).toBe(1);
      expect(kv.get(`${kref}.refCount`)).toBe('1');

      expect(refCountMethods.incRefCount(kref)).toBe(2);
      expect(kv.get(`${kref}.refCount`)).toBe('2');
    });

    it('handles incrementing from undefined', () => {
      const kref = asKRef('ko2');
      expect(Number.isNaN(refCountMethods.incRefCount(kref))).toBe(true);
      expect(kv.get(baseStore.refCountKey(kref))).toBe('NaN');
    });

    it('increments existing reference counts', () => {
      const kref = asKRef('kp42');
      kv.set(`${kref}.refCount`, '10');

      expect(refCountMethods.incRefCount(kref)).toBe(11);
      expect(kv.get(`${kref}.refCount`)).toBe('11');
    });
  });

  describe('decRefCount', () => {
    it('decrements reference counts correctly', () => {
      const kref = asKRef('ko1');
      kv.set(`${kref}.refCount`, '5');

      expect(refCountMethods.decRefCount(kref)).toBe(4);
      expect(kv.get(`${kref}.refCount`)).toBe('4');

      expect(refCountMethods.decRefCount(kref)).toBe(3);
      expect(kv.get(`${kref}.refCount`)).toBe('3');
    });

    it('can decrement to zero', () => {
      const kref = asKRef('ko1');
      kv.set(`${kref}.refCount`, '1');

      expect(refCountMethods.decRefCount(kref)).toBe(0);
      expect(kv.get(`${kref}.refCount`)).toBe('0');
    });

    it('can decrement below zero (though this should be avoided in practice)', () => {
      const kref = asKRef('ko1');
      kv.set(`${kref}.refCount`, '0');

      expect(refCountMethods.decRefCount(kref)).toBe(-1);
      expect(kv.get(`${kref}.refCount`)).toBe('-1');
    });
  });

  describe('kernelRefExists', () => {
    it('returns false for non-existent references', () => {
      expect(refCountMethods.kernelRefExists(asKRef('ko99'))).toBe(false);
    });

    it('returns true for existing references with non-zero count', () => {
      const kref = asKRef('ko1');
      kv.set(`${kref}.refCount`, '5');
      expect(refCountMethods.kernelRefExists(kref)).toBe(true);
    });

    it('returns true for existing references with zero count', () => {
      const kref = asKRef('ko1');
      kv.set(`${kref}.refCount`, '0');
      expect(refCountMethods.kernelRefExists(kref)).toBe(true);
    });
  });

  describe('integration', () => {
    it('supports full reference counting lifecycle', () => {
      const kref = asKRef('ko42');

      expect(refCountMethods.kernelRefExists(kref)).toBe(false);

      kv.set(baseStore.refCountKey(kref), '0');
      expect(refCountMethods.getRefCount(kref)).toBe(0);

      expect(refCountMethods.kernelRefExists(kref)).toBe(true);

      expect(refCountMethods.incRefCount(kref)).toBe(1);

      refCountMethods.incRefCount(kref);
      refCountMethods.incRefCount(kref);
      expect(refCountMethods.getRefCount(kref)).toBe(3);

      refCountMethods.decRefCount(kref);
      expect(refCountMethods.getRefCount(kref)).toBe(2);

      refCountMethods.decRefCount(kref);
      refCountMethods.decRefCount(kref);
      expect(refCountMethods.getRefCount(kref)).toBe(0);

      expect(refCountMethods.kernelRefExists(kref)).toBe(true);
    });

    it('works with multiple references simultaneously', () => {
      const kref1 = asKRef('ko1');
      const kref2 = asKRef('kp2');

      kv.set(baseStore.refCountKey(kref1), '0');
      kv.set(baseStore.refCountKey(kref2), '0');

      refCountMethods.incRefCount(kref1);
      refCountMethods.incRefCount(kref2);
      refCountMethods.incRefCount(kref2);

      expect(refCountMethods.getRefCount(kref1)).toBe(1);
      expect(refCountMethods.getRefCount(kref2)).toBe(2);

      refCountMethods.decRefCount(kref1);
      expect(refCountMethods.getRefCount(kref1)).toBe(0);
      expect(refCountMethods.getRefCount(kref2)).toBe(2);
    });
  });

  describe('incrementRefCount', () => {
    it('increments promise reference counts', () => {
      const kref = asKRef('kp1');

      // Set up initial refCount
      kv.set(`${kref}.refCount`, '1');

      refCountMethods.incrementRefCount(kref, 'test');

      // Check that the refCount was incremented
      expect(kv.get(`${kref}.refCount`)).toBe('2');
    });

    it('does not increment object counts for exports', () => {
      const kref = asKRef('ko1');

      refCountMethods.incrementRefCount(kref, 'test', { isExport: true });

      // Should not call getObjectRefCount or setObjectRefCount
      expect(mockGetObjectRefCount).not.toHaveBeenCalled();
      expect(mockSetObjectRefCount).not.toHaveBeenCalled();
    });

    it('throws for empty kref', () => {
      expect(() =>
        refCountMethods.incrementRefCount('' as KRef, 'test', {}),
      ).toThrow('incrementRefCount called with empty kref');
    });

    it('refuses to resurrect an object the kernel has deleted', () => {
      const kref = asKRef('ko99');

      expect(() => refCountMethods.incrementRefCount(kref, 'test')).toThrow(
        'incrementRefCount on deleted kref "ko99" ("test")',
      );
      expect(kv.get(baseStore.refCountKey(kref))).toBeUndefined();
    });

    it('refuses to resurrect a promise the kernel has deleted', () => {
      const kref = asKRef('kp99');

      expect(() => refCountMethods.incrementRefCount(kref, 'test')).toThrow(
        'incrementRefCount on deleted kref "kp99" ("test")',
      );
      // A written-back `NaN` would read as existing and never reach zero, so
      // the promise could never be collected.
      expect(kv.get(baseStore.refCountKey(kref))).toBeUndefined();
    });

    it('increments an object that exists', () => {
      const kref = asKRef('ko1');
      kv.set(baseStore.refCountKey(kref), '0,0');

      refCountMethods.incrementRefCount(kref, 'test');

      expect(kv.get(baseStore.refCountKey(kref))).toBe('1,1');
    });

    it('increments only the recognizable count when asked', () => {
      const kref = asKRef('ko1');
      kv.set(baseStore.refCountKey(kref), '1,1');

      refCountMethods.incrementRefCount(kref, 'test', {
        onlyRecognizable: true,
      });

      expect(kv.get(baseStore.refCountKey(kref))).toBe('1,2');
    });
  });

  describe('decrementRefCount', () => {
    it('decrements promise reference counts', () => {
      const kref = asKRef('kp1');

      // Set up initial refCount
      kv.set(`${kref}.refCount`, '2');

      const result = refCountMethods.decrementRefCount(kref, 'test');

      // Check that the refCount was decremented
      expect(kv.get(`${kref}.refCount`)).toBe('1');

      expect(result).toBe(false); // Not zero yet
    });

    it('adds promise to maybeFreeKrefs when count reaches zero', () => {
      const kref = asKRef('kp1');

      // Set up initial refCount
      kv.set(`${kref}.refCount`, '1');

      const result = refCountMethods.decrementRefCount(kref, 'test');

      // Check that the refCount was decremented to zero
      expect(kv.get(`${kref}.refCount`)).toBe('0');
      expect(result).toBe(true); // Now zero
      expect(maybeFreeKrefs.has(kref)).toBe(true);
    });

    it('does not decrement object counts for exports', () => {
      const kref = asKRef('ko1');

      const result = refCountMethods.decrementRefCount(kref, 'test', {
        isExport: true,
      });

      // Should not call getObjectRefCount or setObjectRefCount
      expect(mockGetObjectRefCount).not.toHaveBeenCalled();
      expect(mockSetObjectRefCount).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it('throws for empty kref', () => {
      expect(() =>
        refCountMethods.decrementRefCount('' as KRef, 'test', {}),
      ).toThrow('decrementRefCount called with empty kref');
    });

    it('throws for underflow on promise refCount', () => {
      const kref = asKRef('kp1');

      // Set up initial refCount at 0
      kv.set(`${kref}.refCount`, '0');

      expect(() => refCountMethods.decrementRefCount(kref, 'test')).toThrow(
        /refCount underflow/u,
      );
    });
  });
});
