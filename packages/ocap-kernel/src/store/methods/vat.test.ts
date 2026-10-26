import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getBaseMethods } from './base.ts';
import * as clistModule from './clist.ts';
import * as objectModule from './object.ts';
import * as promiseModule from './promise.ts';
import * as reachableModule from './reachable.ts';
import * as refCountModule from './refcount.ts';
import { getVatMethods } from './vat.ts';
import { asVRef } from '../../../test/branded.ts';
import type {
  RemoteId,
  VatConfig,
  VatId,
  EndpointId,
  ERef,
} from '../../types.ts';
import type { StoreContext } from '../types.ts';

// Mock the parseRef function
vi.mock('../utils/parse-ref.ts', () => ({
  parseRef: vi.fn((ref) => {
    if (ref.startsWith('o+')) {
      return { context: 'vat', direction: 'export', isPromise: false };
    } else if (ref.startsWith('o-')) {
      return { context: 'vat', direction: 'import', isPromise: false };
    } else if (ref.startsWith('p+')) {
      return { context: 'vat', direction: 'export', isPromise: true };
    } else if (ref.startsWith('p-')) {
      return { context: 'vat', direction: 'import', isPromise: true };
    } else if (ref.startsWith('ro+')) {
      return { context: 'remote', direction: 'export', isPromise: false };
    } else if (ref.startsWith('ro-')) {
      return { context: 'remote', direction: 'import', isPromise: false };
    } else if (ref.startsWith('rp+')) {
      return { context: 'remote', direction: 'export', isPromise: true };
    } else if (ref.startsWith('rp-')) {
      return { context: 'remote', direction: 'import', isPromise: true };
    } else if (ref.startsWith('ko')) {
      return { context: 'kernel', direction: null, isPromise: false };
    } else if (ref.startsWith('kp')) {
      return { context: 'kernel', direction: null, isPromise: true };
    }
    return { context: 'unknown', direction: null, isPromise: false };
  }),
}));

vi.mock('./base.ts', () => ({
  getBaseMethods: vi.fn(),
}));

vi.mock('./clist.ts', () => ({
  getCListMethods: vi.fn(),
}));

vi.mock('./promise.ts', () => ({
  getPromiseMethods: vi.fn(),
}));

vi.mock('./object.ts', () => ({
  getObjectMethods: vi.fn(),
}));

vi.mock('./reachable.ts', () => ({
  getReachableMethods: vi.fn(),
}));

vi.mock('./refcount.ts', () => ({
  getRefCountMethods: vi.fn(),
}));

describe('vat store methods', () => {
  let mockKV: Map<string, string>;
  let mockGetPrefixedKeys = vi.fn();
  let mockGetSlotKey = vi.fn();
  let mockGetOwnerKey = vi.fn();
  let mockTerminatedVats = {
    get: vi.fn(),
    set: vi.fn(),
  };
  let mockMaybeFreeKrefs = {
    add: vi.fn(),
  };
  let context: StoreContext;
  let vatMethods: ReturnType<typeof getVatMethods>;
  const vatID1 = 'v1' as VatId;
  const vatID2 = 'v2' as VatId;
  const vatConfig1: VatConfig = {
    name: 'test-vat-1',
    path: '/path/to/vat1',
    options: { manualStart: true },
  } as unknown as VatConfig;
  const vatConfig2: VatConfig = {
    name: 'test-vat-2',
    path: '/path/to/vat2',
    options: { manualStart: false },
  } as unknown as VatConfig;

  // Mock method implementations
  const mockDeleteCListEntry = vi.fn();
  const mockForgetKref = vi.fn();
  const mockGetKernelPromise = vi.fn();
  const mockGetReachableAndVatSlot = vi.fn();
  const mockDecrementRefCount = vi.fn();
  const mockInitKernelPromise = vi.fn();
  const mockSetPromiseDecider = vi.fn();
  const mockInitKernelObject = vi.fn();
  const mockAddCListEntry = vi.fn();
  const mockIncrementRefCount = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    mockKV = new Map();
    mockGetPrefixedKeys = vi.fn();
    mockGetSlotKey = vi.fn((vatId, ref) => `slot.${vatId}.${ref}`);
    mockGetOwnerKey = vi.fn((ref) => `owner.${ref}`);
    mockTerminatedVats = {
      get: vi.fn().mockReturnValue('[]'),
      set: vi.fn(),
    };
    mockMaybeFreeKrefs = {
      add: vi.fn(),
    };

    (getBaseMethods as ReturnType<typeof vi.fn>).mockReturnValue({
      getPrefixedKeys: mockGetPrefixedKeys,
      getSlotKey: mockGetSlotKey,
      getCListPrefix: (endpointId: string) => `${endpointId}.c.`,
      getOwnerKey: mockGetOwnerKey,
    });

    // Setup mock implementations for imported methods
    (clistModule.getCListMethods as ReturnType<typeof vi.fn>).mockReturnValue({
      deleteCListEntry: mockDeleteCListEntry,
      addCListEntry: mockAddCListEntry,
      forgetKref: mockForgetKref,
    });

    (
      promiseModule.getPromiseMethods as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      getKernelPromise: mockGetKernelPromise,
      initKernelPromise: mockInitKernelPromise,
      setPromiseDecider: mockSetPromiseDecider,
    });

    (objectModule.getObjectMethods as ReturnType<typeof vi.fn>).mockReturnValue(
      {
        initKernelObject: mockInitKernelObject,
      },
    );

    (
      reachableModule.getReachableMethods as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      getReachableAndVatSlot: mockGetReachableAndVatSlot,
    });

    (
      refCountModule.getRefCountMethods as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      decrementRefCount: mockDecrementRefCount,
      incrementRefCount: mockIncrementRefCount,
    });

    context = {
      kv: {
        get: (key: string): string | undefined => mockKV.get(key),
        getRequired: (key: string): string => {
          const value = mockKV.get(key);
          if (value === undefined) {
            throw new Error(`Required key ${key} not found`);
          }
          return value;
        },
        set: (key: string, value: string): void => {
          mockKV.set(key, value);
        },
        delete: (key: string): void => {
          mockKV.delete(key);
        },
      },
      terminatedVats: mockTerminatedVats,
      maybeFreeKrefs: mockMaybeFreeKrefs,
    } as unknown as StoreContext;

    vatMethods = getVatMethods(context);

    // Default behavior for some mocks
    mockGetKernelPromise.mockReturnValue({});
    mockGetReachableAndVatSlot.mockReturnValue({ vatSlot: 'o+42' });
    mockInitKernelPromise.mockReturnValue(['kp123', {}]);
    mockInitKernelObject.mockReturnValue('ko456');
  });

  describe('getVatConfig', () => {
    it('retrieves vat configuration from storage', () => {
      mockKV.set(`vatConfig.${vatID1}`, JSON.stringify(vatConfig1));

      const result = vatMethods.getVatConfig(vatID1);

      expect(result).toStrictEqual(vatConfig1);
    });

    it('throws error if vat configuration does not exist', () => {
      expect(() => vatMethods.getVatConfig(vatID1)).toThrow(
        'Required key vatConfig.v1 not found',
      );
    });
  });

  describe('setVatConfig', () => {
    it('stores vat configuration in storage', () => {
      vatMethods.setVatConfig(vatID1, vatConfig1);

      const storedConfig = JSON.parse(
        mockKV.get(`vatConfig.${vatID1}`) as string,
      );
      expect(storedConfig).toStrictEqual(vatConfig1);
    });

    it('overwrites existing vat configuration', () => {
      mockKV.set(`vatConfig.${vatID1}`, JSON.stringify(vatConfig1));

      const updatedConfig = {
        ...vatConfig1,
        name: 'updated-vat',
      } as unknown as VatConfig;

      vatMethods.setVatConfig(vatID1, updatedConfig);

      const storedConfig = JSON.parse(
        mockKV.get(`vatConfig.${vatID1}`) as string,
      );
      expect(storedConfig).toStrictEqual(updatedConfig);
    });
  });

  describe('deleteVatConfig', () => {
    it('removes vat configuration from storage', () => {
      mockKV.set(`vatConfig.${vatID1}`, JSON.stringify(vatConfig1));

      vatMethods.deleteVatConfig(vatID1);

      expect(mockKV.has(`vatConfig.${vatID1}`)).toBe(false);
    });

    it('does nothing if vat configuration does not exist', () => {
      expect(() => vatMethods.deleteVatConfig(vatID1)).not.toThrow();
    });
  });

  describe('getAllVatRecords', () => {
    it('yields all stored vat records', () => {
      mockKV.set(`vatConfig.${vatID1}`, JSON.stringify(vatConfig1));
      mockKV.set(`vatConfig.${vatID2}`, JSON.stringify(vatConfig2));

      mockGetPrefixedKeys.mockReturnValue([
        `vatConfig.${vatID1}`,
        `vatConfig.${vatID2}`,
      ]);

      const records = Array.from(vatMethods.getAllVatRecords());

      expect(records).toStrictEqual([
        { vatID: vatID1, vatConfig: vatConfig1 },
        { vatID: vatID2, vatConfig: vatConfig2 },
      ]);
      expect(mockGetPrefixedKeys).toHaveBeenCalledWith('vatConfig.');
    });

    it('yields an empty array when no vats are configured', () => {
      mockGetPrefixedKeys.mockReturnValue([]);

      const records = Array.from(vatMethods.getAllVatRecords());

      expect(records).toStrictEqual([]);
    });
  });

  describe('deleteEndpoint', () => {
    it('deletes all keys related to the endpoint', () => {
      const endpointId = 'e1' as EndpointId;

      // The c-list holds both directions of each pair under one prefix
      mockKV.set(`${endpointId}.c.o-1`, 'ko1');
      mockKV.set(`${endpointId}.c.ko1`, 'R o-1');
      mockKV.set(`${endpointId}.c.p+1`, 'kp1');
      mockKV.set(`e.nextObjectId.${endpointId}`, '10');
      mockKV.set(`e.nextPromiseId.${endpointId}`, '5');

      mockGetPrefixedKeys.mockImplementation((prefix: string) =>
        [...mockKV.keys()].filter((key) => key.startsWith(prefix)),
      );

      vatMethods.deleteEndpoint(endpointId);

      expect(mockKV.has(`${endpointId}.c.o-1`)).toBe(false);
      expect(mockKV.has(`${endpointId}.c.ko1`)).toBe(false);
      expect(mockKV.has(`${endpointId}.c.p+1`)).toBe(false);
      expect(mockKV.has(`e.nextObjectId.${endpointId}`)).toBe(false);
      expect(mockKV.has(`e.nextPromiseId.${endpointId}`)).toBe(false);

      expect(mockGetPrefixedKeys).toHaveBeenCalledWith(`${endpointId}.c.`);
      // The kref-keyed half goes through the c-list teardown, so the entry's
      // reference is released rather than dropped along with the key. The
      // eref-keyed half of that pair goes with it; `p+1` here has no kref side
      // to release through, so it is deleted outright.
      expect(mockForgetKref.mock.calls).toStrictEqual([[endpointId, 'ko1']]);
    });

    it('does nothing if endpoint has no associated keys', () => {
      const endpointId = 'nonexistent' as EndpointId;

      mockGetPrefixedKeys.mockReturnValue([]);

      expect(() => vatMethods.deleteEndpoint(endpointId)).not.toThrow();

      expect(mockGetPrefixedKeys).toHaveBeenCalledWith(`${endpointId}.c.`);
    });
  });

  describe('getVatIDs', () => {
    it('returns all vat IDs from storage', () => {
      mockGetPrefixedKeys.mockReturnValue([
        `vatConfig.${vatID1}`,
        `vatConfig.${vatID2}`,
        `vatConfig.v3`,
      ]);

      const result = vatMethods.getVatIDs();

      expect(result).toStrictEqual([vatID1, vatID2, 'v3']);
      expect(mockGetPrefixedKeys).toHaveBeenCalledWith('vatConfig.');
    });

    it('returns an empty array when no vats are configured', () => {
      mockGetPrefixedKeys.mockReturnValue([]);

      const result = vatMethods.getVatIDs();

      expect(result).toStrictEqual([]);
      expect(mockGetPrefixedKeys).toHaveBeenCalledWith('vatConfig.');
    });
  });

  describe('getTerminatedVats', () => {
    it('returns empty array when no vats are terminated', () => {
      mockTerminatedVats.get.mockReturnValue('[]');

      const result = vatMethods.getTerminatedVats();

      expect(result).toStrictEqual([]);
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });

    it('returns array of terminated vat IDs', () => {
      mockTerminatedVats.get.mockReturnValue(JSON.stringify([vatID1, vatID2]));

      const result = vatMethods.getTerminatedVats();

      expect(result).toStrictEqual([vatID1, vatID2]);
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });

    it('returns empty array when no terminated vats data exists', () => {
      mockTerminatedVats.get.mockReturnValue(null);

      const result = vatMethods.getTerminatedVats();

      expect(result).toStrictEqual([]);
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });
  });

  describe('markVatAsTerminated', () => {
    it('adds a vat to the terminated vats list', () => {
      mockTerminatedVats.get.mockReturnValue('[]');

      vatMethods.markVatAsTerminated(vatID1);

      expect(mockTerminatedVats.set).toHaveBeenCalledWith(
        JSON.stringify([vatID1]),
      );
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });

    it('does not add a vat that is already in the terminated list', () => {
      mockTerminatedVats.get.mockReturnValue(JSON.stringify([vatID1]));

      vatMethods.markVatAsTerminated(vatID1);

      expect(mockTerminatedVats.set).not.toHaveBeenCalled();
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });

    it('appends to existing terminated vats list', () => {
      mockTerminatedVats.get.mockReturnValue(JSON.stringify([vatID1]));

      vatMethods.markVatAsTerminated(vatID2);

      expect(mockTerminatedVats.set).toHaveBeenCalledWith(
        JSON.stringify([vatID1, vatID2]),
      );
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });
  });

  describe('forgetTerminatedVat', () => {
    it('removes a vat from the terminated vats list', () => {
      mockTerminatedVats.get.mockReturnValue(JSON.stringify([vatID1, vatID2]));

      vatMethods.forgetTerminatedVat(vatID1);

      expect(mockTerminatedVats.set).toHaveBeenCalledWith(
        JSON.stringify([vatID2]),
      );
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });

    it('does nothing if vat is not in the terminated list', () => {
      mockTerminatedVats.get.mockReturnValue(JSON.stringify([vatID2]));

      vatMethods.forgetTerminatedVat(vatID1);

      expect(mockTerminatedVats.set).toHaveBeenCalledWith(
        JSON.stringify([vatID2]),
      );
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });

    it('handles empty terminated vats list', () => {
      mockTerminatedVats.get.mockReturnValue('[]');

      vatMethods.forgetTerminatedVat(vatID1);

      expect(mockTerminatedVats.set).toHaveBeenCalledWith('[]');
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });
  });

  describe('isVatTerminated', () => {
    it('returns true if vat is in terminated list', () => {
      mockTerminatedVats.get.mockReturnValue(JSON.stringify([vatID1, vatID2]));
      const result = vatMethods.isVatTerminated(vatID1);
      expect(result).toBe(true);
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });

    it('returns false if vat is not in terminated list', () => {
      mockTerminatedVats.get.mockReturnValue(JSON.stringify([vatID2]));

      const result = vatMethods.isVatTerminated(vatID1);

      expect(result).toBe(false);
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });

    it('returns false if terminated list is empty', () => {
      mockTerminatedVats.get.mockReturnValue('[]');

      const result = vatMethods.isVatTerminated(vatID1);

      expect(result).toBe(false);
      expect(mockTerminatedVats.get).toHaveBeenCalled();
    });
  });

  describe('exportFromEndpoint', () => {
    it('creates a kernel promise for an exported promise', () => {
      const vatId = 'v1' as VatId;
      const vref = asVRef('p+42'); // Promise export reference

      const result = vatMethods.exportFromEndpoint(vatId, vref);

      expect(result).toBe('kp123');
      expect(mockInitKernelPromise).toHaveBeenCalled();
      expect(mockSetPromiseDecider).toHaveBeenCalledWith('kp123', vatId);
      // addCListEntry takes the entry's reference; exportFromEndpoint no
      // longer takes one of its own
      expect(mockAddCListEntry).toHaveBeenCalledWith(vatId, 'kp123', vref);
      expect(mockIncrementRefCount).not.toHaveBeenCalled();
    });

    it('creates a kernel object for an exported object', () => {
      const vatId = 'v1' as VatId;
      const vref = asVRef('o+42'); // Object export reference

      const result = vatMethods.exportFromEndpoint(vatId, vref);

      expect(result).toBe('ko456');
      expect(mockInitKernelObject).toHaveBeenCalledWith(vatId);
      expect(mockAddCListEntry).toHaveBeenCalledWith(vatId, 'ko456', vref);
      expect(mockIncrementRefCount).not.toHaveBeenCalled();
    });

    it('throws an error for non-export reference', () => {
      const vatId = 'v1' as VatId;
      const vref = asVRef('o-42'); // Import reference, not export

      expect(() => vatMethods.exportFromEndpoint(vatId, vref)).toThrow(
        'is not an export reference',
      );
    });

    it('throws an error for non-vat reference', () => {
      const vatId = 'v1' as VatId;
      const vref = 'ko42' as ERef; // Kernel reference, not vat reference

      expect(() => vatMethods.exportFromEndpoint(vatId, vref)).toThrow(
        'is not an ERef',
      );
    });
  });

  describe('isVatActive', () => {
    it('returns true when vat configuration exists', () => {
      mockKV.set(`vatConfig.${vatID1}`, JSON.stringify(vatConfig1));

      const result = vatMethods.isVatActive(vatID1);

      expect(result).toBe(true);
    });

    it('returns false when vat configuration does not exist', () => {
      const result = vatMethods.isVatActive(vatID1);

      expect(result).toBe(false);
    });

    it('returns false after vat configuration is deleted', () => {
      mockKV.set(`vatConfig.${vatID1}`, JSON.stringify(vatConfig1));
      expect(vatMethods.isVatActive(vatID1)).toBe(true);

      mockKV.delete(`vatConfig.${vatID1}`);

      const result = vatMethods.isVatActive(vatID1);
      expect(result).toBe(false);
    });
  });

  describe('forgetEndpointImports', () => {
    const endpointId = 'r1' as RemoteId;

    /**
     * Seed the c-list-keyed entries the function iterates and arrange
     * `getPrefixedKeys` to return them in the order they would appear in
     * storage. Erefs use the realistic remote-style polarity (`ro+`, `ro-`,
     * `rp+`, `rp-`) since the function is scoped to RemoteId endpoints.
     *
     * @param erefs - Pairs of [eref, kref] to seed, in lexicographic order.
     */
    function seedClist(erefs: [string, string][]): void {
      for (const [eref, kref] of erefs) {
        mockKV.set(`slot.${endpointId}.${eref}`, kref);
        mockKV.set(`slot.${endpointId}.${kref}`, eref);
      }
      mockGetPrefixedKeys.mockImplementation((prefix: string) => {
        if (prefix === `${endpointId}.c.`) {
          // Emit both eref-keyed and kref-keyed entries so the function's
          // "skip kref-keyed" branch is exercised.
          return erefs.flatMap(([eref, kref]) => [
            `${endpointId}.c.${eref}`,
            `${endpointId}.c.${kref}`,
          ]);
        }
        return [];
      });
    }

    it("releases the peer's promise exports through the c-list", () => {
      seedClist([['rp+1', 'kp123']]);

      vatMethods.forgetEndpointImports(endpointId);

      // The caller rejected the promises the peer was deciding first, which
      // released the unsettled-promise reference; the entry's own reference is
      // all that is left, and deleteCListEntry releases it.
      expect(mockDeleteCListEntry).toHaveBeenCalledWith(
        endpointId,
        'kp123',
        'rp+1',
      );
    });

    it("releases the peer's object exports: owner, c-list, GC", () => {
      seedClist([['ro+7', 'ko42']]);
      mockKV.set(`owner.ko42`, endpointId);
      mockGetReachableAndVatSlot.mockReturnValue({ vatSlot: 'ro+7' });

      vatMethods.forgetEndpointImports(endpointId);

      expect(mockKV.has(`owner.ko42`)).toBe(false);
      expect(mockKV.has(`slot.${endpointId}.ko42`)).toBe(false);
      expect(mockKV.has(`slot.${endpointId}.ro+7`)).toBe(false);
      expect(mockMaybeFreeKrefs.add).toHaveBeenCalledWith('ko42');
      // An export entry carries no reference, so tearing it down changes no
      // count; the object is simply orphaned for GC to retire.
      expect(mockDecrementRefCount).not.toHaveBeenCalled();
      expect(mockDeleteCListEntry).not.toHaveBeenCalled();
    });

    it('leaves the owner mapping alone when ownership has migrated', () => {
      seedClist([['ro+7', 'ko42']]);
      mockKV.set(`owner.ko42`, 'someoneElse');
      mockGetReachableAndVatSlot.mockReturnValue({ vatSlot: 'ro+7' });

      vatMethods.forgetEndpointImports(endpointId);

      expect(mockKV.get(`owner.ko42`)).toBe('someoneElse');
      // Our c-list pair is still torn down: the peer can't reach the kref
      // through us anymore.
      expect(mockKV.has(`slot.${endpointId}.ko42`)).toBe(false);
      expect(mockKV.has(`slot.${endpointId}.ro+7`)).toBe(false);
      expect(mockDecrementRefCount).not.toHaveBeenCalled();
      // Queued for GC even though the new owner keeps the kref: tearing our
      // pair down may have been what took its last reference, and the new
      // owner's accounting decides the outcome.
      expect(mockMaybeFreeKrefs.add).toHaveBeenCalledWith('ko42');
    });

    it('preserves our exports to the peer (import-direction entries)', () => {
      // Both object and promise imports — neither should be touched.
      seedClist([
        ['ro-3', 'ko99'],
        ['rp-2', 'kp77'],
      ]);

      vatMethods.forgetEndpointImports(endpointId);

      expect(mockDeleteCListEntry).not.toHaveBeenCalled();
      expect(mockDecrementRefCount).not.toHaveBeenCalled();
      expect(mockMaybeFreeKrefs.add).not.toHaveBeenCalled();
      // Mappings stay so a fresh incarnation can keep referring to alice etc.
      expect(mockKV.get(`slot.${endpointId}.ro-3`)).toBe('ko99');
      expect(mockKV.get(`slot.${endpointId}.ko99`)).toBe('ro-3');
      expect(mockKV.get(`slot.${endpointId}.rp-2`)).toBe('kp77');
      expect(mockKV.get(`slot.${endpointId}.kp77`)).toBe('rp-2');
    });

    it('processes mixed entries in one pass without disturbing imports', () => {
      seedClist([
        ['ro+7', 'ko42'], // peer's object export — clean up
        ['ro-3', 'ko99'], // our export to the peer — keep
        ['rp+1', 'kp123'], // peer's promise export — clean up
      ]);
      mockKV.set(`owner.ko42`, endpointId);
      mockGetKernelPromise.mockReturnValue({ decider: endpointId });
      mockGetReachableAndVatSlot.mockReturnValue({ vatSlot: 'ro+7' });

      vatMethods.forgetEndpointImports(endpointId);

      // Peer's exports gone.
      expect(mockKV.has(`slot.${endpointId}.ro+7`)).toBe(false);
      expect(mockDeleteCListEntry).toHaveBeenCalledWith(
        endpointId,
        'kp123',
        'rp+1',
      );
      // Our export retained.
      expect(mockKV.get(`slot.${endpointId}.ro-3`)).toBe('ko99');
    });

    it('logs and skips when an eref entry has no matching kref slot', () => {
      // Seed only the eref-keyed side (simulating c-list inconsistency).
      mockKV.set(`slot.${endpointId}.rp+1`, 'kp123');
      mockKV.delete(`slot.${endpointId}.rp+1`);
      mockGetPrefixedKeys.mockImplementation((prefix: string) => {
        if (prefix === `${endpointId}.c.`) {
          return [`${endpointId}.c.rp+1`];
        }
        return [];
      });
      const warnSpy = vi.fn();
      // Override the logger on context with a spy by re-creating vatMethods
      // pointing at a context with a logger that captures warns.
      const ctxWithLogger = { ...context, logger: { warn: warnSpy } };
      const localVatMethods = getVatMethods(
        ctxWithLogger as unknown as StoreContext,
      );

      expect(() =>
        localVatMethods.forgetEndpointImports(endpointId),
      ).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('has no kref slot'),
      );
      expect(mockDeleteCListEntry).not.toHaveBeenCalled();
    });
  });
});
