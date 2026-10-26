import type { KVStore } from '@metamask/kernel-store';
import { describe, it, expect, beforeEach } from 'vitest';

import { getIdMethods } from './id.ts';
import { asRemoteId, asVatId } from '../../../test/branded.ts';
import { makeMapKVStore } from '../../../test/storage.ts';
import type { EndpointId } from '../../types.ts';
import type { StoreContext } from '../types.ts';

describe('id-methods', () => {
  let kv: KVStore;
  let idStore: ReturnType<typeof getIdMethods>;
  let nextVatId: { get: () => string; set: (value: string) => void };
  let nextRemoteId: { get: () => string; set: (value: string) => void };

  beforeEach(() => {
    kv = makeMapKVStore();

    // Initialize ID counters
    kv.set('nextVatId', '0');
    kv.set('nextRemoteId', '0');

    nextVatId = {
      get: () => kv.get('nextVatId') ?? '0',
      set: (value: string) => kv.set('nextVatId', value),
    };

    nextRemoteId = {
      get: () => kv.get('nextRemoteId') ?? '0',
      set: (value: string) => kv.set('nextRemoteId', value),
    };

    idStore = getIdMethods({
      kv,
      nextVatId,
      nextRemoteId,
    } as StoreContext);
  });

  describe('getNextVatId', () => {
    it('returns sequential vat IDs', () => {
      expect(idStore.getNextVatId()).toBe('v0');
      expect(idStore.getNextVatId()).toBe('v1');
      expect(idStore.getNextVatId()).toBe('v2');
    });

    it('increments the vat ID counter', () => {
      idStore.getNextVatId();
      expect(kv.get('nextVatId')).toBe('1');

      idStore.getNextVatId();
      expect(kv.get('nextVatId')).toBe('2');
    });

    it('continues from existing counter value', () => {
      // Set an existing counter value
      kv.set('nextVatId', '42');

      expect(idStore.getNextVatId()).toBe('v42');
      expect(idStore.getNextVatId()).toBe('v43');
    });
  });

  describe('getNextRemoteId', () => {
    it('returns sequential remote IDs', () => {
      expect(idStore.getNextRemoteId()).toBe('r0');
      expect(idStore.getNextRemoteId()).toBe('r1');
      expect(idStore.getNextRemoteId()).toBe('r2');
    });

    it('increments the remote ID counter', () => {
      idStore.getNextRemoteId();
      expect(kv.get('nextRemoteId')).toBe('1');

      idStore.getNextRemoteId();
      expect(kv.get('nextRemoteId')).toBe('2');
    });

    it('continues from existing counter value', () => {
      // Set an existing counter value
      kv.set('nextRemoteId', '99');

      expect(idStore.getNextRemoteId()).toBe('r99');
      expect(idStore.getNextRemoteId()).toBe('r100');
    });
  });

  describe('initEndpoint', () => {
    it('initializes a vat endpoint', () => {
      const vatId: EndpointId = asVatId('v1');

      idStore.initEndpoint(vatId);

      expect(kv.get(`e.nextPromiseId.${vatId}`)).toBe('1');
      expect(kv.get(`e.nextObjectId.${vatId}`)).toBe('1');
    });

    it('initializes a remote endpoint', () => {
      const remoteId: EndpointId = asRemoteId('r2');

      idStore.initEndpoint(remoteId);

      expect(kv.get(`e.nextPromiseId.${remoteId}`)).toBe('1');
      expect(kv.get(`e.nextObjectId.${remoteId}`)).toBe('1');
    });

    it('can initialize multiple endpoints', () => {
      idStore.initEndpoint(asVatId('v1'));
      idStore.initEndpoint(asVatId('v2'));
      idStore.initEndpoint(asRemoteId('r1'));

      expect(kv.get('e.nextPromiseId.v1')).toBe('1');
      expect(kv.get('e.nextObjectId.v1')).toBe('1');

      expect(kv.get('e.nextPromiseId.v2')).toBe('1');
      expect(kv.get('e.nextObjectId.v2')).toBe('1');

      expect(kv.get('e.nextPromiseId.r1')).toBe('1');
      expect(kv.get('e.nextObjectId.r1')).toBe('1');
    });

    it('can reinitialize an existing endpoint', () => {
      const vatId: EndpointId = asVatId('v3');

      // Initialize with default values
      idStore.initEndpoint(vatId);

      // Modify the values
      kv.set(`e.nextPromiseId.${vatId}`, '10');
      kv.set(`e.nextObjectId.${vatId}`, '20');

      // Reinitialize
      idStore.initEndpoint(vatId);

      // Values should be reset to 1
      expect(kv.get(`e.nextPromiseId.${vatId}`)).toBe('1');
      expect(kv.get(`e.nextObjectId.${vatId}`)).toBe('1');
    });
  });

  describe('integration', () => {
    it('supports creating and initializing endpoints', () => {
      // Get new vat and remote IDs
      const vatId = idStore.getNextVatId();
      const remoteId = idStore.getNextRemoteId();

      // Initialize them as endpoints
      idStore.initEndpoint(vatId);
      idStore.initEndpoint(remoteId);

      // Check that they're properly initialized
      expect(kv.get(`e.nextPromiseId.${vatId}`)).toBe('1');
      expect(kv.get(`e.nextObjectId.${vatId}`)).toBe('1');

      expect(kv.get(`e.nextPromiseId.${remoteId}`)).toBe('1');
      expect(kv.get(`e.nextObjectId.${remoteId}`)).toBe('1');
    });

    it('maintains separate counters for vats and remotes', () => {
      // Generate multiple IDs of each type
      const vatId1 = idStore.getNextVatId();
      const vatId2 = idStore.getNextVatId();
      const remoteId1 = idStore.getNextRemoteId();
      const remoteId2 = idStore.getNextRemoteId();

      // Check that they follow the expected sequence
      expect(vatId1).toBe('v0');
      expect(vatId2).toBe('v1');
      expect(remoteId1).toBe('r0');
      expect(remoteId2).toBe('r1');
    });
  });
});
