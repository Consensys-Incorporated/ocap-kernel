import { Fail } from '@endo/errors';
import { SubclusterNotFoundError } from '@metamask/kernel-errors';

import type {
  ClusterConfig,
  Subcluster,
  SubclusterId,
  VatId,
} from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { getBaseMethods } from './base.ts';

/**
 * Get a subcluster store object that provides functionality for managing subcluster records.
 *
 * @param ctx - The store context.
 * @returns A subcluster store object that maps various persistent kernel data
 * structures.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getSubclusterMethods(ctx: StoreContext) {
  const { kv } = ctx;
  const { incCounter } = getBaseMethods(kv);

  /**
   * Retrieves all subclusters from persistent storage.
   *
   * @returns An array of all stored subclusters.
   */
  function getSubclusters(): Subcluster[] {
    const subclustersJSON = ctx.subclusters.get();
    return subclustersJSON ? (JSON.parse(subclustersJSON) as Subcluster[]) : [];
  }

  /**
   * Saves all subclusters to persistent storage.
   *
   * @param subclusters - The array of subclusters to save.
   */
  function saveAllSubclustersToStorage(subclusters: Subcluster[]): void {
    ctx.subclusters.set(JSON.stringify(subclusters));
  }

  /**
   * Retrieves the vat to subcluster mapping from persistent storage.
   *
   * @returns A record mapping VatIds to SubclusterIds.
   */
  function getVatToSubclusterMap(): Record<VatId, SubclusterId> {
    const mapJSON = ctx.vatToSubclusterMap.get();
    return mapJSON ? (JSON.parse(mapJSON) as Record<VatId, SubclusterId>) : {};
  }

  /**
   * Saves the vat to subcluster mapping to persistent storage.
   *
   * @param map - The vat to subcluster map to save.
   */
  function saveVatToSubclusterMapToStorage(
    map: Record<VatId, SubclusterId>,
  ): void {
    ctx.vatToSubclusterMap.set(JSON.stringify(map));
  }

  /**
   * Adds a new subcluster with the given configuration.
   *
   * @param config - The configuration for the new subcluster.
   * @returns The ID of the newly created subcluster.
   */
  function addSubcluster(config: ClusterConfig): SubclusterId {
    const currentSubclusters = getSubclusters();
    const newId = `s${incCounter(ctx.nextSubclusterId)}` as SubclusterId;
    const newSubcluster: Subcluster = {
      id: newId,
      config,
      vats: {},
    };
    currentSubclusters.push(newSubcluster);
    saveAllSubclustersToStorage(currentSubclusters);
    return newId;
  }

  /**
   * Retrieves a specific subcluster by its ID.
   *
   * @param subclusterId - The ID of the subcluster to retrieve.
   * @returns The subcluster if found, otherwise undefined.
   */
  function getSubcluster(subclusterId: SubclusterId): Subcluster | undefined {
    const currentSubclusters = getSubclusters();
    return currentSubclusters.find((sc) => sc.id === subclusterId);
  }

  /**
   * Adds a vat to the specified subcluster.
   *
   * @param subclusterId - The ID of the subcluster.
   * @param vatName - The name of the vat within the subcluster.
   * @param vatId - The ID of the vat to add.
   * @throws If the subcluster is not found.
   */
  function addSubclusterVat(
    subclusterId: SubclusterId,
    vatName: string,
    vatId: VatId,
  ): void {
    const currentSubclusters = getSubclusters();
    const subcluster = currentSubclusters.find((sc) => sc.id === subclusterId);

    if (!subcluster) {
      throw new SubclusterNotFoundError(subclusterId);
    }

    // Update vat mapping
    const currentMap = getVatToSubclusterMap();

    // Check if vat is already in another subcluster
    if (currentMap[vatId] && currentMap[vatId] !== subclusterId) {
      throw new Error(
        `Cannot add vat ${vatId} to subcluster ${subclusterId} as it already belongs to subcluster ${currentMap[vatId]}.`,
      );
    }

    // Add vat to subcluster if not already present
    if (subcluster.vats[vatName] !== vatId) {
      subcluster.vats[vatName] = vatId;
    }

    // Update the map and save all changes
    currentMap[vatId] = subclusterId;
    saveVatToSubclusterMapToStorage(currentMap);
    saveAllSubclustersToStorage(currentSubclusters);
  }

  /**
   * Retrieves all VATs associated with a specific subcluster.
   *
   * @param subclusterId - The ID of the subcluster.
   * @returns An array of VatIds associated with the subcluster.
   * @throws If the subcluster is not found.
   */
  function getSubclusterVats(subclusterId: SubclusterId): VatId[] {
    const subcluster = getSubcluster(subclusterId);
    if (!subcluster) {
      throw new SubclusterNotFoundError(subclusterId);
    }
    return Object.values(subcluster.vats);
  }

  /**
   * Deletes a vat from a specified subcluster.
   *
   * @param subclusterId - The ID of the subcluster.
   * @param vatId - The ID of the vat to delete.
   */
  function deleteSubclusterVat(subclusterId: SubclusterId, vatId: VatId): void {
    const currentSubclusters = getSubclusters();
    const subcluster = currentSubclusters.find((sc) => sc.id === subclusterId);

    // Remove vat from subcluster's vats record if subcluster exists
    if (subcluster) {
      const entry = Object.entries(subcluster.vats).find(
        ([, id]) => id === vatId,
      );
      if (entry) {
        delete subcluster.vats[entry[0]];
        saveAllSubclustersToStorage(currentSubclusters);
      }
    }

    // Always remove vat from the mapping if it points to this subcluster
    const currentMap = getVatToSubclusterMap();
    if (currentMap[vatId] === subclusterId) {
      delete currentMap[vatId];
      saveVatToSubclusterMapToStorage(currentMap);
    }
  }

  /**
   * Deletes a subcluster and removes its VATs from the vat-to-subcluster map.
   *
   * @param subclusterId - The ID of the subcluster to delete.
   */
  function deleteSubcluster(subclusterId: SubclusterId): void {
    const currentSubclusters = getSubclusters();
    const subclusterToDelete = currentSubclusters.find(
      (sc) => sc.id === subclusterId,
    );

    if (!subclusterToDelete) {
      return;
    }

    // Remove subcluster from the list
    const updatedSubclusters = currentSubclusters.filter(
      (sc) => sc.id !== subclusterId,
    );
    saveAllSubclustersToStorage(updatedSubclusters);

    // Remove all vats from the mapping
    const currentMap = getVatToSubclusterMap();
    const vatsToRemove = Object.values(subclusterToDelete.vats).filter(
      (vatId) => currentMap[vatId] === subclusterId,
    );

    if (vatsToRemove.length > 0) {
      for (const vatId of vatsToRemove) {
        delete currentMap[vatId];
      }
      saveVatToSubclusterMapToStorage(currentMap);
    }
  }

  /**
   * Retrieves the subcluster ID for a given vat ID.
   *
   * @param vatId - The ID of the vat.
   * @returns The ID of the subcluster the vat belongs to, or undefined if not found.
   */
  function getVatSubcluster(vatId: VatId): SubclusterId {
    const currentMap = getVatToSubclusterMap();
    return currentMap[vatId] ?? Fail`Vat ${vatId} has no subcluster`;
  }

  /**
   * Clears empty subclusters.
   */
  function clearEmptySubclusters(): void {
    const currentSubclusters = getSubclusters();
    const nonEmptySubclusters = currentSubclusters.filter(
      (sc) => Object.keys(sc.vats).length > 0,
    );
    if (nonEmptySubclusters.length !== currentSubclusters.length) {
      saveAllSubclustersToStorage(nonEmptySubclusters);
    }
  }

  /**
   * Removes a vat from its subcluster.
   *
   * A vat that belongs to no subcluster is already in the state this asks for,
   * so it is left alone rather than reported: `deleteVat` reaches here while
   * discarding a vat, which is the one moment a failure cannot be retried past.
   *
   * @param vatId - The ID of the vat to remove.
   */
  function removeVatFromSubcluster(vatId: VatId): void {
    const subclusterId = getVatToSubclusterMap()[vatId];
    if (subclusterId) {
      deleteSubclusterVat(subclusterId, vatId);
    }
  }

  // System subcluster mapping methods

  /**
   * Get the subcluster ID for a system subcluster by name.
   *
   * @param name - The name of the system subcluster.
   * @returns The subcluster ID, or undefined if not found.
   */
  function getSystemSubclusterMapping(name: string): SubclusterId | undefined {
    return ctx.kv.get<SubclusterId>(`systemSubcluster.${name}`);
  }

  /**
   * Set the subcluster ID for a system subcluster by name.
   *
   * @param name - The name of the system subcluster.
   * @param subclusterId - The subcluster ID to associate with the name.
   */
  function setSystemSubclusterMapping(
    name: string,
    subclusterId: SubclusterId,
  ): void {
    kv.set(`systemSubcluster.${name}`, subclusterId);
  }

  /**
   * Delete the mapping for a system subcluster by name.
   *
   * @param name - The name of the system subcluster to delete.
   */
  function deleteSystemSubclusterMapping(name: string): void {
    kv.delete(`systemSubcluster.${name}`);
  }

  /**
   * Get all system subcluster mappings.
   *
   * @returns A Map of system subcluster names to their subcluster IDs.
   */
  function getAllSystemSubclusterMappings(): Map<string, SubclusterId> {
    const { getPrefixedKeys } = getBaseMethods(kv);
    const prefix = 'systemSubcluster.';
    const mappings = new Map<string, SubclusterId>();
    for (const key of getPrefixedKeys(prefix)) {
      const name = key.slice(prefix.length);
      const subclusterId = ctx.kv.get<SubclusterId>(key);
      if (subclusterId) {
        mappings.set(name, subclusterId);
      }
    }
    return mappings;
  }

  return {
    addSubcluster,
    getSubcluster,
    getSubclusters,
    deleteSubcluster,
    addSubclusterVat,
    getSubclusterVats,
    deleteSubclusterVat,
    getVatSubcluster,
    clearEmptySubclusters,
    removeVatFromSubcluster,
    getSystemSubclusterMapping,
    setSystemSubclusterMapping,
    deleteSystemSubclusterMapping,
    getAllSystemSubclusterMappings,
  };
}
