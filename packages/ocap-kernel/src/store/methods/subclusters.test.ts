import { SubclusterNotFoundError } from '@metamask/kernel-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { getBaseMethods } from './base.ts';
import { getSubclusterMethods } from './subclusters.ts';
import type {
  ClusterConfig,
  Subcluster,
  SubclusterId,
  VatConfig,
  VatId,
} from '../../types.ts';
import type { StoreContext, StoredValue } from '../types.ts';

vi.mock('./base.ts', () => ({
  getBaseMethods: vi.fn(),
}));

describe('getSubclusterMethods', () => {
  let mockIncCounter: ReturnType<typeof vi.fn>;
  let subclustersInternalValue: string | undefined;
  let vatMapInternalValue: string | undefined;
  let nextIdInternalValue: string | undefined;
  let mockSubclustersStorage: StoredValue;
  let mockVatToSubclusterMapStorage: StoredValue;
  let mockNextSubclusterIdCounter: StoredValue;
  let mockKvStore: unknown;
  let mockContext: StoreContext;
  let subclusterMethods: ReturnType<typeof getSubclusterMethods>;
  const mockVatConfig1: VatConfig = { bundleName: 'bundleA' };
  const mockVatConfig2: VatConfig = { sourceSpec: './sourceB.js' };
  const mockClusterConfig1: ClusterConfig = {
    bootstrap: 'bob',
    vats: { bob: mockVatConfig1 },
  };
  const mockClusterConfig2: ClusterConfig = {
    bootstrap: 'alice',
    vats: { alice: mockVatConfig2, bob: mockVatConfig1 },
  };

  beforeEach(() => {
    mockIncCounter = vi.fn();
    (getBaseMethods as ReturnType<typeof vi.fn>).mockReturnValue({
      incCounter: mockIncCounter,
    });
    mockIncCounter.mockImplementation((storedValueMock: StoredValue) => {
      const currentVal = storedValueMock.get();
      const currentValue = currentVal ? parseInt(currentVal, 10) : 0;
      const nextValue = currentValue + 1;
      storedValueMock.set(String(nextValue));
      return String(nextValue);
    });

    subclustersInternalValue = '[]';
    vatMapInternalValue = '{}';
    nextIdInternalValue = '1';

    mockSubclustersStorage = {
      get: vi.fn(() => subclustersInternalValue),
      set: vi.fn((newValue: string) => {
        subclustersInternalValue = newValue;
      }),
      delete: vi.fn(() => {
        subclustersInternalValue = undefined;
      }),
    };

    mockVatToSubclusterMapStorage = {
      get: vi.fn(() => vatMapInternalValue),
      set: vi.fn((newValue: string) => {
        vatMapInternalValue = newValue;
      }),
      delete: vi.fn(() => {
        vatMapInternalValue = undefined;
      }),
    };

    mockNextSubclusterIdCounter = {
      get: vi.fn(() => nextIdInternalValue),
      set: vi.fn((newValue: string) => {
        nextIdInternalValue = newValue;
      }),
      delete: vi.fn(() => {
        nextIdInternalValue = undefined;
      }),
    };

    mockKvStore = {};

    mockContext = {
      kv: mockKvStore,
      subclusters: mockSubclustersStorage,
      vatToSubclusterMap: mockVatToSubclusterMapStorage,
      nextSubclusterId: mockNextSubclusterIdCounter,
    } as unknown as StoreContext;

    subclusterMethods = getSubclusterMethods(mockContext);
  });

  describe('addSubcluster', () => {
    it('should add a new subcluster, increment ID, and return the new ID', () => {
      const newId = subclusterMethods.addSubcluster(mockClusterConfig1);
      expect(newId).toBe('s2');
      expect(mockIncCounter).toHaveBeenCalledWith(mockNextSubclusterIdCounter);
      expect(mockNextSubclusterIdCounter.get()).toBe('2');

      const subclustersRaw = mockSubclustersStorage.get();
      const subclusters = subclustersRaw
        ? (JSON.parse(subclustersRaw) as Subcluster[])
        : [];
      expect(subclusters).toHaveLength(1);
      expect(subclusters[0]).toStrictEqual({
        id: 's2',
        config: mockClusterConfig1,
        vats: {},
      });
    });

    it('should add multiple subclusters with incrementing IDs', () => {
      const id1 = subclusterMethods.addSubcluster(mockClusterConfig1);
      const id2 = subclusterMethods.addSubcluster(mockClusterConfig2);
      expect(id1).toBe('s2');
      expect(id2).toBe('s3');
      expect(mockIncCounter).toHaveBeenCalledTimes(2);
      expect(mockNextSubclusterIdCounter.get()).toBe('3');

      const subclustersRaw = mockSubclustersStorage.get();
      const subclusters = subclustersRaw
        ? (JSON.parse(subclustersRaw) as Subcluster[])
        : [];
      expect(subclusters).toHaveLength(2);
      expect(subclusters[1]).toStrictEqual({
        id: 's3',
        config: mockClusterConfig2,
        vats: {},
      });
    });
  });

  describe('getSubclusters', () => {
    it('should return all subclusters', () => {
      const id1 = subclusterMethods.addSubcluster(mockClusterConfig1);
      const id2 = subclusterMethods.addSubcluster(mockClusterConfig2);
      const all = subclusterMethods.getSubclusters();
      expect(all).toHaveLength(2);
      expect(all.find((sc) => sc.id === id1)?.config).toStrictEqual(
        mockClusterConfig1,
      );
      expect(all.find((sc) => sc.id === id2)?.config).toStrictEqual(
        mockClusterConfig2,
      );
    });

    it('should return an empty array if no subclusters exist', () => {
      expect(subclusterMethods.getSubclusters()).toStrictEqual([]);
    });
  });

  describe('getSubcluster', () => {
    it('should return a specific subcluster by ID', () => {
      const id = subclusterMethods.addSubcluster(mockClusterConfig1);
      const subcluster = subclusterMethods.getSubcluster(id);
      expect(subcluster).toBeDefined();
      expect(subcluster?.id).toBe(id);
      expect(subcluster?.config).toStrictEqual(mockClusterConfig1);
    });

    it('should return undefined if the subcluster is not found', () => {
      expect(
        subclusterMethods.getSubcluster('sNonExistent' as SubclusterId),
      ).toBeUndefined();
    });
  });

  describe('addSubclusterVat', () => {
    let scId: SubclusterId;
    const vatId1: VatId = 'v1';

    beforeEach(() => {
      scId = subclusterMethods.addSubcluster(mockClusterConfig1);
    });

    it('should add a vat to an existing subcluster and update map', () => {
      subclusterMethods.addSubclusterVat(scId, 'bob', vatId1);

      const subclustersRaw = mockSubclustersStorage.get();
      const subclusters = subclustersRaw
        ? (JSON.parse(subclustersRaw) as Subcluster[])
        : [];
      const targetSubcluster = subclusters.find((sc) => sc.id === scId);
      expect(Object.values(targetSubcluster?.vats ?? {})).toContain(vatId1);

      const mapRaw = mockVatToSubclusterMapStorage.get();
      const map = mapRaw ? JSON.parse(mapRaw) : {};
      expect(map[vatId1]).toBe(scId);
    });

    it('should not add a duplicate vat to the same subcluster', () => {
      subclusterMethods.addSubclusterVat(scId, 'bob', vatId1);
      subclusterMethods.addSubclusterVat(scId, 'bob', vatId1);

      const subclustersRaw = mockSubclustersStorage.get();
      const subclusters = subclustersRaw
        ? (JSON.parse(subclustersRaw) as Subcluster[])
        : [];
      const targetSubcluster = subclusters.find((sc) => sc.id === scId);
      expect(targetSubcluster?.vats).toStrictEqual({ bob: vatId1 });
    });

    it('should throw an error when trying to add a vat to a different subcluster', () => {
      const scId2 = subclusterMethods.addSubcluster(mockClusterConfig2);
      subclusterMethods.addSubclusterVat(scId, 'bob', vatId1);

      expect(() =>
        subclusterMethods.addSubclusterVat(scId2, 'alice', vatId1),
      ).toThrow(
        `Cannot add vat ${vatId1} to subcluster ${scId2} as it already belongs to subcluster ${scId}.`,
      );

      // Verify the vat is still in the original subcluster
      const subclustersRaw = mockSubclustersStorage.get();
      const subclusters = subclustersRaw
        ? (JSON.parse(subclustersRaw) as Subcluster[])
        : [];
      const originalSc = subclusters.find((sc) => sc.id === scId);
      const newSc = subclusters.find((sc) => sc.id === scId2);

      expect(Object.values(originalSc?.vats ?? {})).toContain(vatId1);
      expect(Object.values(newSc?.vats ?? {})).not.toContain(vatId1);

      // Verify the map hasn't changed
      const mapRaw = mockVatToSubclusterMapStorage.get();
      const map = mapRaw ? JSON.parse(mapRaw) : {};
      expect(map[vatId1]).toBe(scId);
    });

    it('should throw SubclusterNotFoundError if subcluster does not exist', () => {
      const nonExistentId = 'sNonExistent' as SubclusterId;
      expect(() =>
        subclusterMethods.addSubclusterVat(nonExistentId, 'bob', vatId1),
      ).toThrow(SubclusterNotFoundError);
    });
  });

  describe('getSubclusterVats', () => {
    let scId: SubclusterId;
    const vatId1: VatId = 'v1';
    const vatId2: VatId = 'v2';

    beforeEach(() => {
      scId = subclusterMethods.addSubcluster(mockClusterConfig1);
      subclusterMethods.addSubclusterVat(scId, 'vat1', vatId1);
      subclusterMethods.addSubclusterVat(scId, 'vat2', vatId2);
    });

    it('should return all vats for a given subcluster', () => {
      const vats = subclusterMethods.getSubclusterVats(scId);
      expect(vats).toHaveLength(2);
      expect(vats).toContain(vatId1);
      expect(vats).toContain(vatId2);
    });

    it('should return an empty array if the subcluster has no vats', () => {
      const scIdNew = subclusterMethods.addSubcluster(mockClusterConfig2);
      const vats = subclusterMethods.getSubclusterVats(scIdNew);
      expect(vats).toStrictEqual([]);
    });

    it('should throw SubclusterNotFoundError if subcluster does not exist', () => {
      const nonExistentId = 'sNonExistent' as SubclusterId;
      expect(() => subclusterMethods.getSubclusterVats(nonExistentId)).toThrow(
        SubclusterNotFoundError,
      );
    });

    it('should return a copy of the vats, not a reference', () => {
      const vatsArray1 = subclusterMethods.getSubclusterVats(scId);
      expect(vatsArray1).toStrictEqual([vatId1, vatId2]);
      vatsArray1.push('v3-mutated' as VatId);

      const vatsArray2 = subclusterMethods.getSubclusterVats(scId);
      expect(vatsArray2).toStrictEqual([vatId1, vatId2]);
      expect(vatsArray2).not.toContain('v3-mutated');
    });
  });

  describe('deleteSubclusterVat', () => {
    let scId1: SubclusterId;
    const vatId1: VatId = 'v1';
    const vatId2: VatId = 'v2';

    beforeEach(() => {
      scId1 = subclusterMethods.addSubcluster(mockClusterConfig1);
      subclusterMethods.addSubclusterVat(scId1, 'vat1', vatId1);
      subclusterMethods.addSubclusterVat(scId1, 'vat2', vatId2);
    });

    it('should delete a vat from a subcluster and update map', () => {
      subclusterMethods.deleteSubclusterVat(scId1, vatId2);

      const sc1 = subclusterMethods.getSubcluster(scId1) as Subcluster;
      expect(Object.values(sc1.vats)).not.toContain(vatId2);
      expect(Object.values(sc1.vats)).toContain(vatId1);

      const mapRaw = mockVatToSubclusterMapStorage.get();
      const map = mapRaw ? JSON.parse(mapRaw) : {};
      expect(map[vatId2]).toBeUndefined();
      expect(map[vatId1]).toBe(scId1);
    });

    it('should do nothing to subclusters list if subcluster is not found', () => {
      const initialSubclustersRaw = mockSubclustersStorage.get();
      const nonExistentScId = 'sNonExistentCluster' as SubclusterId;
      const someVat = 'vSomeVat' as VatId;
      mockVatToSubclusterMapStorage.set(
        JSON.stringify({ [someVat]: nonExistentScId }),
      );

      subclusterMethods.deleteSubclusterVat(nonExistentScId, someVat);

      expect(mockSubclustersStorage.get()).toBe(initialSubclustersRaw);
      const mapRaw = mockVatToSubclusterMapStorage.get();
      const map = mapRaw ? JSON.parse(mapRaw) : {};
      expect(map[someVat]).toBeUndefined();
    });

    it('should do nothing to subclusters list if vat is not in the specified subcluster', () => {
      const nonExistentVat = 'vNonExistent' as VatId;
      const sc1 = subclusterMethods.getSubcluster(scId1) as Subcluster;
      const sc1InitialVats = sc1 ? { ...sc1.vats } : {};

      subclusterMethods.deleteSubclusterVat(scId1, nonExistentVat);

      const sc1After = subclusterMethods.getSubcluster(scId1) as Subcluster;
      expect(sc1After?.vats).toStrictEqual(sc1InitialVats);
    });

    it('should clear map entry if vat is mapped to a subclusterId being deleted from, but subcluster is not found in main list', () => {
      const vatX: VatId = 'v100';
      const scGhostId: SubclusterId = 's100';
      mockVatToSubclusterMapStorage.set(JSON.stringify({ [vatX]: scGhostId }));

      subclusterMethods.deleteSubclusterVat(scGhostId, vatX);

      const mapRaw = mockVatToSubclusterMapStorage.get();
      const map = mapRaw ? JSON.parse(mapRaw) : {};
      expect(map[vatX]).toBeUndefined();
    });
  });

  describe('deleteSubcluster', () => {
    let scId1: SubclusterId;
    const vatId1: VatId = 'v1';
    const vatId2: VatId = 'v2';

    beforeEach(() => {
      scId1 = subclusterMethods.addSubcluster(mockClusterConfig1);
      subclusterMethods.addSubclusterVat(scId1, 'vat1', vatId1);
      subclusterMethods.addSubclusterVat(scId1, 'vat2', vatId2);
    });

    it('should delete a subcluster and remove its vats from the map', () => {
      expect(subclusterMethods.getSubcluster(scId1)).toBeDefined();
      expect(subclusterMethods.getVatSubcluster(vatId1)).toBe(scId1);
      expect(subclusterMethods.getVatSubcluster(vatId2)).toBe(scId1);

      subclusterMethods.deleteSubcluster(scId1);

      expect(subclusterMethods.getSubcluster(scId1)).toBeUndefined();
      expect(() => subclusterMethods.getVatSubcluster(vatId1)).toThrow(
        `Vat "${vatId1}" has no subcluster`,
      );
      expect(() => subclusterMethods.getVatSubcluster(vatId2)).toThrow(
        `Vat "${vatId2}" has no subcluster`,
      );

      const allSc = subclusterMethods.getSubclusters();
      expect(allSc.find((sc) => sc.id === scId1)).toBeUndefined();
    });

    it('should do nothing if subcluster is not found', () => {
      const initialSubclustersRaw = mockSubclustersStorage.get();
      const initialMapRaw = mockVatToSubclusterMapStorage.get();

      subclusterMethods.deleteSubcluster('sNonExistent' as SubclusterId);

      expect(mockSubclustersStorage.get()).toBe(initialSubclustersRaw);
      expect(mockVatToSubclusterMapStorage.get()).toBe(initialMapRaw);
      expect(subclusterMethods.getSubcluster(scId1)).toBeDefined();
    });

    it('should correctly update map if a vat was in multiple subclusters conceptually', () => {
      const scId2 = subclusterMethods.addSubcluster(mockClusterConfig2);
      const vatX = 'vX' as VatId;
      subclusterMethods.addSubclusterVat(scId1, 'vatX', vatX);

      const subclustersRaw = mockSubclustersStorage.get();
      const subclusters = subclustersRaw
        ? (JSON.parse(subclustersRaw) as Subcluster[])
        : [];
      const sc2obj = subclusters.find((sc) => sc.id === scId2) as Subcluster;
      sc2obj.vats.vatX = vatX;
      mockSubclustersStorage.set(JSON.stringify(subclusters));

      subclusterMethods.deleteSubcluster(scId1);

      expect(() => subclusterMethods.getVatSubcluster(vatX)).toThrow(
        `Vat "${vatX}" has no subcluster`,
      );
      const sc2AfterDelete = subclusterMethods.getSubcluster(scId2);
      expect(sc2AfterDelete).toBeDefined();
      expect(Object.values(sc2AfterDelete?.vats ?? {})).toContain(vatX);
    });
  });

  describe('getVatSubcluster', () => {
    it('should return the subcluster ID for a given vat', () => {
      const scId = subclusterMethods.addSubcluster(mockClusterConfig1);
      const vatId: VatId = 'vTest';
      subclusterMethods.addSubclusterVat(scId, 'test', vatId);
      expect(subclusterMethods.getVatSubcluster(vatId)).toBe(scId);
    });

    it('should throw an error if the vat is not in any subcluster map', () => {
      expect(() =>
        subclusterMethods.getVatSubcluster('vNonMapped' as VatId),
      ).toThrow('Vat "vNonMapped" has no subcluster');
    });

    it('should throw an error if the map is empty', () => {
      mockVatToSubclusterMapStorage.set('{}');
      expect(() => subclusterMethods.getVatSubcluster('v1' as VatId)).toThrow(
        'Vat "v1" has no subcluster',
      );
    });
  });

  describe('clearEmptySubclusters', () => {
    it('should remove subclusters with no vats', () => {
      const scId1 = subclusterMethods.addSubcluster(mockClusterConfig1);
      subclusterMethods.addSubcluster(mockClusterConfig2);
      const vatId = 'v1' as VatId;
      subclusterMethods.addSubclusterVat(scId1, 'bob', vatId);

      subclusterMethods.clearEmptySubclusters();

      const subclusters = subclusterMethods.getSubclusters();
      expect(subclusters).toHaveLength(1);
      expect(subclusters[0]?.id).toBe(scId1);
      expect(Object.values(subclusters[0]?.vats ?? {})).toContain(vatId);
    });

    it('should do nothing if all subclusters have vats', () => {
      const scId1 = subclusterMethods.addSubcluster(mockClusterConfig1);
      const scId2 = subclusterMethods.addSubcluster(mockClusterConfig2);
      const vatId1 = 'v1' as VatId;
      const vatId2 = 'v2' as VatId;
      subclusterMethods.addSubclusterVat(scId1, 'bob', vatId1);
      subclusterMethods.addSubclusterVat(scId2, 'alice', vatId2);

      const initialSubclusters = subclusterMethods.getSubclusters();
      subclusterMethods.clearEmptySubclusters();
      const finalSubclusters = subclusterMethods.getSubclusters();

      expect(finalSubclusters).toStrictEqual(initialSubclusters);
    });

    it('should do nothing if there are no subclusters', () => {
      subclusterMethods.clearEmptySubclusters();
      expect(subclusterMethods.getSubclusters()).toStrictEqual([]);
    });
  });

  describe('removeVatFromSubcluster', () => {
    let scId: SubclusterId;
    const vatId1: VatId = 'v1';
    const vatId2: VatId = 'v2';

    beforeEach(() => {
      scId = subclusterMethods.addSubcluster(mockClusterConfig1);
      subclusterMethods.addSubclusterVat(scId, 'vat1', vatId1);
      subclusterMethods.addSubclusterVat(scId, 'vat2', vatId2);
    });

    it('should remove a vat from its subcluster', () => {
      subclusterMethods.removeVatFromSubcluster(vatId1);

      const subcluster = subclusterMethods.getSubcluster(scId);
      expect(Object.values(subcluster?.vats ?? {})).not.toContain(vatId1);
      expect(Object.values(subcluster?.vats ?? {})).toContain(vatId2);

      const mapRaw = mockVatToSubclusterMapStorage.get();
      const map = mapRaw ? JSON.parse(mapRaw) : {};
      expect(map[vatId1]).toBeUndefined();
      expect(map[vatId2]).toBe(scId);
    });

    it('leaves a vat that is in no subcluster alone', () => {
      const nonMappedVat = 'vNonMapped' as VatId;

      // Already in the state this asks for. Reporting it instead strands the
      // teardown that called it — `deleteVat` reaches here while discarding a
      // vat, which is the one moment a failure cannot be retried past.
      expect(() =>
        subclusterMethods.removeVatFromSubcluster(nonMappedVat),
      ).not.toThrow();
      expect(subclusterMethods.getSubcluster(scId)?.vats).toStrictEqual({
        vat1: vatId1,
        vat2: vatId2,
      });
    });

    it('should handle removing the last vat from a subcluster', () => {
      subclusterMethods.removeVatFromSubcluster(vatId1);
      subclusterMethods.removeVatFromSubcluster(vatId2);

      const subcluster = subclusterMethods.getSubcluster(scId);
      expect(Object.keys(subcluster?.vats ?? {})).toHaveLength(0);

      const mapRaw = mockVatToSubclusterMapStorage.get();
      const map = mapRaw ? JSON.parse(mapRaw) : {};
      expect(map[vatId1]).toBeUndefined();
      expect(map[vatId2]).toBeUndefined();
    });
  });
});
