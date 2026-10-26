import type { KVStore } from '@metamask/kernel-store';
import { describe, it, expect, beforeEach } from 'vitest';

import { getObjectMethods } from './object.ts';
import { makeMapKVStore } from '../../../test/storage.ts';
import { ROOT_OBJECT_VREF } from '../../types.ts';
import type { EndpointId } from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { getRevocationMethods } from './revocation.ts';
import { asKRef, asRemoteId, asVatId } from '../../../test/branded.ts';

const v1 = asVatId('v1');

describe('object-methods', () => {
  let kv: KVStore;
  let objectStore: ReturnType<typeof getObjectMethods>;
  let nextObjectId: { get: () => string; set: (value: string) => void };

  beforeEach(() => {
    kv = makeMapKVStore();
    // Initialize nextObjectId counter
    kv.set('nextObjectId', '0');
    nextObjectId = {
      get: () => kv.get('nextObjectId') ?? '0',
      set: (value: string) => kv.set('nextObjectId', value),
    };

    objectStore = getObjectMethods({
      kv,
      nextObjectId,
    } as StoreContext);
  });

  describe('initKernelObject', () => {
    it('creates a new kernel object, unreferenced', () => {
      const owner: EndpointId = v1;
      const koId = objectStore.initKernelObject(owner);

      // Check the object ID format
      expect(koId).toBe('ko0');

      // Check the owner is set correctly
      expect(kv.get(`${koId}.owner`)).toBe(owner);

      // A new object has no referrers yet; the owner's own export entry is
      // not one of them
      expect(kv.get(`${koId}.refCount`)).toBe('0,0');
      expect(objectStore.getObjectRefCount(koId)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });
    });

    it('initializes the revoked flag to false', () => {
      const { isRevoked } = getRevocationMethods({ kv } as StoreContext);
      const koId = objectStore.initKernelObject(v1);
      expect(isRevoked(koId)).toBe(false);
    });

    it('increments the object ID counter', () => {
      const koId1 = objectStore.initKernelObject(v1);
      const koId2 = objectStore.initKernelObject(asVatId('v2'));
      const koId3 = objectStore.initKernelObject(asRemoteId('r1'));

      expect(koId1).toBe('ko0');
      expect(koId2).toBe('ko1');
      expect(koId3).toBe('ko2');
    });
  });

  describe('getOwner', () => {
    it('returns the owner of a kernel object', () => {
      const owner1: EndpointId = v1;
      const owner2: EndpointId = asRemoteId('r2');

      const koId1 = objectStore.initKernelObject(owner1);
      const koId2 = objectStore.initKernelObject(owner2);

      expect(objectStore.getOwner(koId1)).toBe(owner1);
      expect(objectStore.getOwner(koId2)).toBe(owner2);
    });

    it('returns undefined for unknown kernel objects', () => {
      expect(objectStore.getOwner(asKRef('ko99'))).toBeUndefined();
    });
  });

  describe('getRootObject', () => {
    it('returns the root object KRef for a vat', () => {
      const vatId = v1;
      const rootKref = 'ko42';

      // Set up a root object entry in the KV store
      kv.set(`${vatId}.c.${ROOT_OBJECT_VREF}`, rootKref);

      // Should return the root object KRef
      expect(objectStore.getRootObject(vatId)).toBe(rootKref);
    });

    it('returns undefined when no root object exists', () => {
      const vatId = asVatId('v2');

      // No setup needed - the root object doesn't exist

      // Should return undefined
      expect(objectStore.getRootObject(vatId)).toBeUndefined();
    });
  });

  describe('isRootObject', () => {
    it('returns true when the KRef is the root object for the vat', () => {
      const vatId = v1;
      const rootKref = asKRef('ko42');

      // Set up a root object entry in the KV store
      kv.set(`${vatId}.c.${ROOT_OBJECT_VREF}`, rootKref);

      // Should return true for the matching KRef
      expect(objectStore.isRootObject(rootKref, vatId)).toBe(true);
    });

    it('returns false when the KRef is not the root object for the vat', () => {
      const vatId = v1;
      const rootKref = 'ko42';
      const nonRootKref = asKRef('ko99');

      // Set up a root object entry in the KV store
      kv.set(`${vatId}.c.${ROOT_OBJECT_VREF}`, rootKref);

      // Should return false for a different KRef
      expect(objectStore.isRootObject(nonRootKref, vatId)).toBe(false);
    });

    it('returns false when no root object exists for the vat', () => {
      const vatId = asVatId('v2');
      const kref = asKRef('ko42');

      // No setup needed - the root object doesn't exist

      // Should return false since there's no root object
      expect(objectStore.isRootObject(kref, vatId)).toBe(false);
    });
  });

  describe('deleteKernelObject', () => {
    it('removes a kernel object from storage', () => {
      const koId = objectStore.initKernelObject(v1);

      // Object exists before deletion
      expect(kv.get(`${koId}.owner`)).toBeDefined();
      expect(kv.get(`${koId}.refCount`)).toBeDefined();

      // Delete the object
      objectStore.deleteKernelObject(koId);

      // Object should be gone
      expect(kv.get(`${koId}.owner`)).toBeUndefined();
      expect(kv.get(`${koId}.refCount`)).toBeUndefined();

      // getOwner should throw
      expect(objectStore.getOwner(koId)).toBeUndefined();
    });
  });

  describe('getNextObjectId', () => {
    it('returns sequential object IDs', () => {
      expect(objectStore.getNextObjectId()).toBe('ko0');
      expect(objectStore.getNextObjectId()).toBe('ko1');
      expect(objectStore.getNextObjectId()).toBe('ko2');
    });
  });

  describe('getObjectRefCount', () => {
    it('returns reference counts for existing objects', () => {
      const koId = objectStore.initKernelObject(v1);

      objectStore.setObjectRefCount(koId, { reachable: 1, recognizable: 2 });

      const refCounts = objectStore.getObjectRefCount(koId);
      expect(refCounts).toStrictEqual({ reachable: 1, recognizable: 2 });
    });

    it('returns zero counts for non-existent objects', () => {
      const refCounts = objectStore.getObjectRefCount(asKRef('ko99'));
      expect(refCounts).toStrictEqual({ reachable: 0, recognizable: 0 });
    });

    it('parses reference counts correctly', () => {
      const koId = objectStore.initKernelObject(v1);

      // Manually set reference counts
      kv.set(`${koId}.refCount`, '5,10');

      const refCounts = objectStore.getObjectRefCount(koId);
      expect(refCounts).toStrictEqual({ reachable: 5, recognizable: 10 });
    });

    it('throws when stored reachable count exceeds recognizable count', () => {
      const koId = objectStore.initKernelObject(v1);

      // Manually set invalid reference counts where reachable > recognizable
      // This simulates corruption in the storage
      kv.set(`${koId}.refCount`, '10,5');

      expect(() => objectStore.getObjectRefCount(koId)).toThrow(
        /refMismatch\(get\)/u,
      );
    });
  });

  describe('setObjectRefCount', () => {
    it('sets reference counts for an object', () => {
      const koId = objectStore.initKernelObject(v1);

      // Set new reference counts
      objectStore.setObjectRefCount(koId, { reachable: 3, recognizable: 5 });

      // Check via direct KV access
      expect(kv.get(`${koId}.refCount`)).toBe('3,5');

      // Check via API
      const refCounts = objectStore.getObjectRefCount(koId);
      expect(refCounts).toStrictEqual({ reachable: 3, recognizable: 5 });
    });

    it('allows zero reference counts', () => {
      const koId = objectStore.initKernelObject(v1);

      objectStore.setObjectRefCount(koId, { reachable: 0, recognizable: 0 });

      const refCounts = objectStore.getObjectRefCount(koId);
      expect(refCounts).toStrictEqual({ reachable: 0, recognizable: 0 });
    });

    it('throws when reachable count exceeds recognizable count', () => {
      const koId = objectStore.initKernelObject(v1);

      expect(() =>
        objectStore.setObjectRefCount(koId, { reachable: 5, recognizable: 3 }),
      ).toThrow(/refMismatch/u);
    });

    it('throws when counts are negative', () => {
      const koId = objectStore.initKernelObject(v1);

      expect(() =>
        objectStore.setObjectRefCount(koId, { reachable: -1, recognizable: 1 }),
      ).toThrow(/underflow/u);

      expect(() =>
        objectStore.setObjectRefCount(koId, { reachable: 0, recognizable: -1 }),
      ).toThrow(/underflow/u);
    });

    it('prevents storing and retrieving invalid reference count combinations', () => {
      const koId = objectStore.initKernelObject(v1);

      // Test setting invalid counts (should throw)
      expect(() =>
        objectStore.setObjectRefCount(koId, { reachable: 5, recognizable: 3 }),
      ).toThrow(/refMismatch\(set\)/u);

      // Set a valid reference count
      objectStore.setObjectRefCount(koId, { reachable: 3, recognizable: 5 });

      // Manually corrupt the stored value
      kv.set(`${koId}.refCount`, '10,5');

      // Retrieving should now throw due to the corrupted data
      expect(() => objectStore.getObjectRefCount(koId)).toThrow(
        /refMismatch\(get\)/u,
      );
    });
  });

  describe('integration', () => {
    it('supports the full kernel object lifecycle', () => {
      // Create an object
      const koId = objectStore.initKernelObject(v1);

      // Check initial state
      expect(objectStore.getOwner(koId)).toBe('v1');
      expect(objectStore.getObjectRefCount(koId)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });

      // Update reference counts
      objectStore.setObjectRefCount(koId, { reachable: 2, recognizable: 3 });
      expect(objectStore.getObjectRefCount(koId)).toStrictEqual({
        reachable: 2,
        recognizable: 3,
      });

      // Reduce to zero
      objectStore.setObjectRefCount(koId, { reachable: 0, recognizable: 0 });
      expect(objectStore.getObjectRefCount(koId)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });

      // Object still exists with zero counts
      expect(objectStore.getOwner(koId)).toBe('v1');

      // Delete the object
      objectStore.deleteKernelObject(koId);

      // Object should be gone
      expect(objectStore.getOwner(koId)).toBeUndefined();
      expect(objectStore.getObjectRefCount(koId)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });
    });

    it('handles multiple objects simultaneously', () => {
      // Create multiple objects with different owners
      const koId1 = objectStore.initKernelObject(v1);
      const koId2 = objectStore.initKernelObject(asRemoteId('r2'));

      // Check owners
      expect(objectStore.getOwner(koId1)).toBe('v1');
      expect(objectStore.getOwner(koId2)).toBe('r2');

      // Set different reference counts
      objectStore.setObjectRefCount(koId1, { reachable: 2, recognizable: 2 });
      objectStore.setObjectRefCount(koId2, { reachable: 3, recognizable: 5 });

      // Check counts
      expect(objectStore.getObjectRefCount(koId1)).toStrictEqual({
        reachable: 2,
        recognizable: 2,
      });
      expect(objectStore.getObjectRefCount(koId2)).toStrictEqual({
        reachable: 3,
        recognizable: 5,
      });

      // Delete one object
      objectStore.deleteKernelObject(koId1);

      // First object should be gone, second still exists
      expect(objectStore.getOwner(koId1)).toBeUndefined();
      expect(objectStore.getOwner(koId2)).toBe('r2');
    });

    it('handles reference count patterns correctly', () => {
      const koId = objectStore.initKernelObject(v1);

      // Equal reachable and recognizable
      objectStore.setObjectRefCount(koId, { reachable: 5, recognizable: 5 });
      expect(objectStore.getObjectRefCount(koId)).toStrictEqual({
        reachable: 5,
        recognizable: 5,
      });

      // Reachable less than recognizable
      objectStore.setObjectRefCount(koId, { reachable: 3, recognizable: 5 });
      expect(objectStore.getObjectRefCount(koId)).toStrictEqual({
        reachable: 3,
        recognizable: 5,
      });

      // Both zero
      objectStore.setObjectRefCount(koId, { reachable: 0, recognizable: 0 });
      expect(objectStore.getObjectRefCount(koId)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });
    });
  });
});
