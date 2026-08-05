import { Fail } from '@endo/errors';

import { getBaseMethods } from './base.ts';
import { getCListMethods } from './clist.ts';
import { getObjectMethods } from './object.ts';
import { getPromiseMethods } from './promise.ts';
import { getReachableMethods } from './reachable.ts';
import type {
  EndpointId,
  KRef,
  RemoteId,
  VatConfig,
  VatId,
  ERef,
} from '../../types.ts';
import type { StoreContext, VatCleanupWork } from '../types.ts';
import { parseRef } from '../utils/parse-ref.ts';
import { parseReachableAndVatSlot } from '../utils/reachable.ts';

type VatRecord = {
  vatID: VatId;
  vatConfig: VatConfig;
};

const VAT_CONFIG_BASE = 'vatConfig.';
const VAT_CONFIG_BASE_LEN = VAT_CONFIG_BASE.length;

/**
 * Get a kernel store object that provides functionality for managing vat records.
 *
 * @param ctx - The store context.
 * @returns A vat store object that maps various persistent kernel data
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getVatMethods(ctx: StoreContext) {
  const { kv } = ctx;
  const { getPrefixedKeys, getSlotKey, getCListPrefix, getOwnerKey } =
    getBaseMethods(ctx.kv);
  const { deleteCListEntry, forgetKref } = getCListMethods(ctx);
  const { getReachableAndVatSlot } = getReachableMethods(ctx);
  const { initKernelPromise, setPromiseDecider, addPromiseSubscriber } =
    getPromiseMethods(ctx);
  const { initKernelObject } = getObjectMethods(ctx);
  const { addCListEntry } = getCListMethods(ctx);

  /**
   * Delete all persistent state associated with an endpoint.
   *
   * Each surviving c-list entry is torn down rather than merely deleted: an
   * entry is a reference, so dropping the key without releasing its count
   * leaves the target held by a holder that no longer exists — pinned alive
   * forever, and reported by the audit as a count nothing accounts for.
   * `cleanupTerminatedVat` has already emptied the c-list by the time it calls
   * this, so in practice there is nothing here to release; a caller that has
   * not done that work first depends on this.
   *
   * @param endpointId - The endpoint whose state is to be deleted.
   */
  function deleteEndpoint(endpointId: EndpointId): void {
    const prefix = getCListPrefix(endpointId);
    // Snapshot the keys: forgetKref deletes both halves of a pair, so mutating
    // while walking the live key sequence would step over entries.
    for (const key of [...getPrefixedKeys(prefix)]) {
      const ref = key.slice(prefix.length);
      // The kref-keyed half of each pair, which is the half that names the
      // reference to release. The eref-keyed half goes with it.
      if (parseRef(ref).context === 'kernel') {
        forgetKref(endpointId, ref as KRef);
      }
    }
    // Any half-pair left over has no kref side to release through.
    for (const key of getPrefixedKeys(prefix)) {
      kv.delete(key);
    }
    kv.delete(`e.nextObjectId.${endpointId}`);
    kv.delete(`e.nextPromiseId.${endpointId}`);
  }

  /**
   * Generator that yields the configurations of running vats.
   *
   * @yields a series of vat records for all configured vats.
   */
  function* getAllVatRecords(): Generator<VatRecord> {
    for (const vatKey of getPrefixedKeys(VAT_CONFIG_BASE)) {
      const vatID = vatKey.slice(VAT_CONFIG_BASE_LEN) as VatId;
      const vatConfig = getVatConfig(vatID);
      yield { vatID, vatConfig };
    }
  }

  /**
   * Get all vat IDs from the store.
   *
   * @returns an array of vat IDs.
   */
  function getVatIDs(): VatId[] {
    return Array.from(getPrefixedKeys(VAT_CONFIG_BASE)).map(
      (vatKey) => vatKey.slice(VAT_CONFIG_BASE_LEN) as VatId,
    );
  }

  /**
   * Fetch the stored configuration for a vat.
   *
   * @param vatID - The vat whose configuration is sought.
   *
   * @returns the configuration for the given vat.
   */
  function getVatConfig(vatID: VatId): VatConfig {
    return JSON.parse(
      kv.getRequired(`${VAT_CONFIG_BASE}${vatID}`),
    ) as VatConfig;
  }

  /**
   * Check if a vat is active.
   *
   * @param vatID - The ID of the vat to check.
   * @returns True if the vat is active, false otherwise.
   */
  function isVatActive(vatID: VatId): boolean {
    return kv.get(`${VAT_CONFIG_BASE}${vatID}`) !== undefined;
  }

  /**
   * Store the configuration for a vat.
   *
   * @param vatID - The vat whose configuration is to be set.
   * @param vatConfig - The configuration to write.
   */
  function setVatConfig(vatID: VatId, vatConfig: VatConfig): void {
    kv.set(`${VAT_CONFIG_BASE}${vatID}`, JSON.stringify(vatConfig));
  }

  /**
   * Delete the stored configuration for a vat.
   *
   * @param vatID - The vat whose configuration is to be deleted.
   */
  function deleteVatConfig(vatID: VatId): void {
    kv.delete(`${VAT_CONFIG_BASE}${vatID}`);
  }

  /**
   * Checks if a vat imports the specified kernel slot.
   *
   * @param vatID - The ID of the vat to check.
   * @param kernelSlot - The kernel slot reference.
   * @returns True if the vat imports the kernel slot, false otherwise.
   */
  function importsKernelSlot(vatID: VatId, kernelSlot: KRef): boolean {
    const data = ctx.kv.get(getSlotKey(vatID, kernelSlot));
    if (data) {
      const { vatSlot } = parseReachableAndVatSlot(data);
      const { direction } = parseRef(vatSlot);
      if (direction === 'import') {
        return true;
      }
    }
    return false;
  }

  /**
   * Gets all vats that import a specific kernel object.
   *
   * @param koid - The kernel object ID.
   * @returns An array of vat IDs that import the kernel object.
   */
  function getImporters(koid: KRef): VatId[] {
    const importers = [];
    importers.push(
      ...getVatIDs().filter((vatID) => importsKernelSlot(vatID, koid)),
    );
    importers.sort();
    return importers;
  }

  /**
   * Get the list of terminated vats.
   *
   * @returns an array of terminated vat IDs.
   */
  function getTerminatedVats(): VatId[] {
    return JSON.parse(ctx.terminatedVats.get() ?? '[]');
  }

  /**
   * Check if a vat is terminated.
   *
   * @param vatID - The ID of the vat to check.
   * @returns True if the vat is terminated, false otherwise.
   */
  function isVatTerminated(vatID: VatId): boolean {
    return getTerminatedVats().includes(vatID);
  }

  /**
   * Add a vat to the list of terminated vats.
   *
   * @param vatID - The ID of the vat to add.
   */
  function markVatAsTerminated(vatID: VatId): void {
    const terminatedVats = getTerminatedVats();
    if (!terminatedVats.includes(vatID)) {
      terminatedVats.push(vatID);
      ctx.terminatedVats.set(JSON.stringify(terminatedVats));
    }
  }

  /**
   * Remove a vat from the list of terminated vats.
   *
   * @param vatID - The ID of the vat to remove.
   */
  function forgetTerminatedVat(vatID: VatId): void {
    const terminatedVats = getTerminatedVats().filter((id) => id !== vatID);
    ctx.terminatedVats.set(JSON.stringify(terminatedVats));
  }

  /**
   * Cleanup a terminated vat.
   *
   * @param vatID - The ID of the vat to cleanup.
   * @returns The work done during the cleanup.
   */
  function cleanupTerminatedVat(vatID: VatId): VatCleanupWork {
    const work = {
      exports: 0,
      imports: 0,
      promises: 0,
      kv: 0,
    };

    if (!isVatTerminated(vatID)) {
      return work;
    }

    const clistPrefix = `${vatID}.c.`;
    const exportPrefix = `${clistPrefix}o+`;
    const importPrefix = `${clistPrefix}o-`;
    const promisePrefix = `${clistPrefix}p`;

    // Note: ASCII order is "+,-./", and we rely upon this to split the
    // keyspace into the various o+NN/o-NN/etc spaces. If we were using a
    // more sophisticated database, we'd keep each section in a separate
    // table.

    // The current store semantics ensure this iteration is lexicographic.
    // Any changes to the creation of the list of promises to be rejected (and
    // thus to the order in which they *get* rejected) need to preserve this
    // ordering in order to preserve determinism.

    // first, scan for exported objects, which must be orphaned
    for (const key of getPrefixedKeys(exportPrefix)) {
      // The void for an object exported by a vat will always be of the form
      // `o+NN`.  The '+' means that the vat exported the object (rather than
      // importing it) and therefore the object is owned by (i.e., within) the
      // vat.  The corresponding void->koid c-list entry will thus always
      // begin with `vMM.c.o+`.  In addition to deleting the c-list entry, we
      // must also delete the corresponding kernel owner entry for the object,
      // since the object will no longer be accessible.
      assert(key.startsWith(clistPrefix), key);
      const vref = key.slice(clistPrefix.length);
      assert(vref.startsWith('o+'), vref);
      const kref = ctx.kv.get<KRef>(key);
      assert(kref, key);
      // deletes c-list and .owner, adds to maybeFreeKrefs
      const ownerKey = getOwnerKey(kref);
      const ownerVat = ctx.kv.get(ownerKey);
      ownerVat === vatID || Fail`export ${kref} not owned by old vat`;
      ctx.kv.delete(ownerKey);
      const { vatSlot } = getReachableAndVatSlot(vatID, kref);
      ctx.kv.delete(getSlotKey(vatID, kref));
      ctx.kv.delete(getSlotKey(vatID, vatSlot));
      // An export entry holds no count, so there is nothing to release; the
      // object is now orphaned, and GC retires it once importers let go.
      ctx.maybeFreeKrefs.add(kref);
      work.exports += 1;
    }

    // then scan for imported objects, which must be decrefed
    for (const key of getPrefixedKeys(importPrefix)) {
      // abandoned imports: delete the clist entry as if the vat did a
      // drop+retire
      const krefStr = ctx.kv.get<KRef>(key) ?? Fail`getNextKey ensures get`;
      assert(key.startsWith(clistPrefix), key);
      const vref = key.slice(clistPrefix.length) as ERef;
      deleteCListEntry(vatID, krefStr, vref);
      // that will also delete both db keys
      work.imports += 1;
    }

    // The caller looked the orphan promises up with getPromisesByDecider() and
    // rejected them before calling us; that rejection is what released each
    // promise's unsettled reference. Their kpids are still in the dead vat's
    // c-list, so clean those up now.
    for (const key of getPrefixedKeys(promisePrefix)) {
      const krefStr = ctx.kv.get<KRef>(key) ?? Fail`getNextKey ensures get`;
      assert(key.startsWith(clistPrefix), key);
      const vref = key.slice(clistPrefix.length) as ERef;
      // the following will also delete both db keys
      deleteCListEntry(vatID, krefStr, vref);
      work.promises += 1;
    }

    // Finally, clean up any remaining KV entries for this vat
    for (const key of getPrefixedKeys(`${vatID}.`)) {
      ctx.kv.delete(key);
      work.kv += 1;
    }

    // Clean up any remaining c-list entries and vat-specific counters
    deleteEndpoint(vatID);

    // Remove the vat from the terminated vats list
    forgetTerminatedVat(vatID);

    // Log the cleanup work done
    ctx.logger?.debug(`Cleaned up terminated vat ${vatID}:`, work);

    return work;
  }

  /**
   * Get the next terminated vat to cleanup.
   *
   * @returns The work done during the cleanup.
   */
  function nextTerminatedVatCleanup(): boolean {
    const vatID = getTerminatedVats()?.[0];
    vatID && cleanupTerminatedVat(vatID);
    return getTerminatedVats().length > 0;
  }

  /**
   * Clean up the c-list entries an endpoint introduced into the kernel — the
   * "+"-direction erefs the endpoint allocated and shared with us. These
   * become dead the moment the endpoint restarts: their kernel objects have
   * no live owner, their kernel promises can never be resolved by their
   * original decider, and any future c-list lookup for one of those reused
   * eref labels would route a fresh incarnation's traffic into stale state.
   *
   * Mirrors the export/promise legs of {@link cleanupTerminatedVat} but
   * scoped to a single endpoint and only its own contributions, so our
   * exports to that endpoint (alice's root, etc.) stay reachable when a
   * fresh incarnation reconnects with the same peer ID.
   *
   * The caller (RemoteManager.#handleIncarnationChange) rejects promises the
   * endpoint was deciding *before* invoking this, so its
   * `getPromisesByDecider` query can still find them through the c-list this
   * function is about to tear down.
   *
   * @param endpointId - The endpoint whose contributions are to be dropped.
   */
  function forgetEndpointImports(endpointId: RemoteId): void {
    const clistPrefix = `${endpointId}.c.`;
    const erefsToForget: ERef[] = [];
    for (const key of getPrefixedKeys(clistPrefix)) {
      const ref = key.slice(clistPrefix.length);
      // The c-list stores both directions of each pair (kref-keyed and
      // eref-keyed). Iterate by eref only; deleteCListEntry handles the
      // kref-keyed counterpart.
      if (ref.startsWith('k')) {
        continue;
      }
      const { direction } = parseRef(ref);
      if (direction === 'export') {
        erefsToForget.push(ref as ERef);
      }
    }

    for (const eref of erefsToForget) {
      const slotKey = getSlotKey(endpointId, eref);
      const kref = ctx.kv.get<KRef>(slotKey);
      if (!kref) {
        ctx.logger?.warn(
          `forgetEndpointImports: c-list entry ${eref} for endpoint ${endpointId} ` +
            `has no kref slot — skipping (possible c-list inconsistency)`,
        );
        continue;
      }
      const { isPromise } = parseRef(eref);
      if (isPromise) {
        // The caller already rejected the promises this endpoint was deciding,
        // so only the c-list entry's own reference is left.
        deleteCListEntry(endpointId, kref, eref);
      } else {
        // Object exports: drop the owner mapping if it still names the
        // restarting endpoint, tear down the c-list pair, and queue the object
        // for GC. An export entry holds no count, so this changes none. If
        // ownership has migrated (e.g. a kernel-internal handoff), leave the
        // new owner's mapping alone: the kref is theirs from here.
        const ownerKey = getOwnerKey(kref);
        const currentOwner = ctx.kv.get(ownerKey);
        if (currentOwner === endpointId) {
          ctx.kv.delete(ownerKey);
        } else if (currentOwner !== undefined) {
          ctx.logger?.warn(
            `forgetEndpointImports: kref ${kref} was exported by ${endpointId} ` +
              `but is now owned by ${currentOwner}`,
          );
        }
        const { vatSlot } = getReachableAndVatSlot(endpointId, kref);
        ctx.kv.delete(getSlotKey(endpointId, kref));
        ctx.kv.delete(getSlotKey(endpointId, vatSlot));
        ctx.maybeFreeKrefs.add(kref);
      }
    }
  }

  /**
   * Create the kernel's representation of an export from an endpoint.
   *
   * @param endpointId - The endpoint doing the exporting.
   * @param eref - The endpoint's ref for the entity in question.
   *
   * @returns the kref corresponding to the export of `eref` from `endpointId`.
   */
  function exportFromEndpoint(endpointId: EndpointId, eref: ERef): KRef {
    const { isPromise, context, direction } = parseRef(eref);
    assert(context === 'vat' || context === 'remote', `${eref} is not an ERef`);
    assert(direction === 'export', `${eref} is not an export reference`);
    let kref;
    if (isPromise) {
      kref = initKernelPromise()[0];
      setPromiseDecider(kref, endpointId);
    } else {
      kref = initKernelObject(endpointId);
    }
    // addCListEntry takes the entry's reference: none for an object, since the
    // owner is not one of its referrers, and one for a promise.
    addCListEntry(endpointId, kref, eref);
    ctx.logger?.debug('exportFromEndpoint', endpointId, eref, kref);
    if (context === 'remote' && isPromise) {
      addPromiseSubscriber(endpointId, kref);
    }
    return kref;
  }

  return {
    deleteEndpoint,
    getAllVatRecords,
    getVatConfig,
    setVatConfig,
    deleteVatConfig,
    getVatIDs,
    importsKernelSlot,
    getImporters,
    getTerminatedVats,
    markVatAsTerminated,
    forgetTerminatedVat,
    isVatTerminated,
    cleanupTerminatedVat,
    nextTerminatedVatCleanup,
    isVatActive,
    exportFromEndpoint,
    forgetEndpointImports,
  };
}
