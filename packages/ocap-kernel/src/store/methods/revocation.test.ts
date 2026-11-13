import type { KVStore } from '@metamask/kernel-store';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getObjectMethods } from './object.ts';
import { makeMapKVStore } from '../../../test/storage.ts';
import type { StoreContext } from '../types.ts';
import { getRevocationMethods } from './revocation.ts';
import { asKRef, asVatId } from '../../../test/branded.ts';

describe('revocation-methods', () => {
  let kv: KVStore;
  let objectStore: ReturnType<typeof getObjectMethods>;
  let nextObjectId: { get: () => string; set: (value: string) => void };
  let revocation: ReturnType<typeof getRevocationMethods>;

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

    revocation = getRevocationMethods({
      kv,
      nextObjectId,
    } as StoreContext);
  });

  describe('setRevoked', () => {
    it('sets the revoked flag when argument is true', () => {
      const koId = objectStore.initKernelObject(asVatId('v1'));
      const expectedKey = expect.stringContaining(koId);
      const setSpy = vi.spyOn(kv, 'set');
      revocation.setRevoked(koId, true);
      expect(setSpy).toHaveBeenCalledWith(expectedKey, 'true');
    });

    it('deletes the revoked flag when argument is false', () => {
      const koId = objectStore.initKernelObject(asVatId('v1'));
      const expectedKey = expect.stringContaining(koId);
      const deleteSpy = vi.spyOn(kv, 'delete');
      revocation.setRevoked(koId, false);
      expect(deleteSpy).toHaveBeenCalledWith(expectedKey);
    });
  });

  describe('revokeKernelObject', () => {
    it('revokes a kernel object', () => {
      const koId = objectStore.initKernelObject(asVatId('v1'));
      revocation.revoke(koId);
      expect(revocation.isRevoked(koId)).toBe(true);
    });

    it('does not change the reference counts', () => {
      const koId = objectStore.initKernelObject(asVatId('v1'));
      objectStore.setObjectRefCount(koId, { reachable: 1, recognizable: 1 });
      revocation.revoke(koId);
      expect(objectStore.getObjectRefCount(koId)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });
    });

    it('throws when trying to revoke a promise', () => {
      const koId = asKRef('kp1');
      expect(() => revocation.revoke(koId)).toThrow(
        `cannot revoke promise ${koId}`,
      );
    });
  });

  describe('isRevoked', () => {
    it('returns true if the object is revoked', () => {
      const koId = objectStore.initKernelObject(asVatId('v1'));
      revocation.revoke(koId);
      expect(revocation.isRevoked(koId)).toBe(true);
    });

    it('returns false if the object is not revoked', () => {
      const koId = objectStore.initKernelObject(asVatId('v1'));
      expect(revocation.isRevoked(koId)).toBe(false);
    });
  });
});
