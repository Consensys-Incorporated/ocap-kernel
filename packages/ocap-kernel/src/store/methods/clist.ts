import { Fail } from '@endo/errors';

import { getBaseMethods } from './base.ts';
import { getReachableMethods } from './reachable.ts';
import { getRefCountMethods } from './refcount.ts';
import type { EndpointId, KRef, ERef, Ref } from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { parseRef } from '../utils/parse-ref.ts';
import { isPromiseRef } from '../utils/promise-ref.ts';
import {
  buildReachableAndVatSlot,
  parseReachableAndVatSlot,
} from '../utils/reachable.ts';

/**
 * Get the c-list methods that provide functionality for managing c-lists.
 *
 * @param ctx - The store context.
 * @returns The c-list store.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getCListMethods(ctx: StoreContext) {
  const { getSlotKey } = getBaseMethods(ctx.kv);
  const { clearReachableFlag } = getReachableMethods(ctx);
  const { incrementRefCount, decrementRefCount } = getRefCountMethods(ctx);

  /**
   * Add an entry to an endpoint's c-list, creating a new bidirectional mapping
   * between an ERef belonging to the endpoint and a KRef belonging to the
   * kernel.
   *
   * The entry is itself a reference, so creating one takes a count, mirroring
   * {@link deleteCListEntry}. An object import is born recognizing but not
   * reaching: reachability is `setReachableFlag`'s job, when the reference is
   * handed over. An object export takes no count — the owner is not one of its
   * own referrers — and is born flagged. A promise entry takes a full count
   * whichever direction it faces, since a promise has only the one count.
   *
   * @param endpointId - The endpoint whose c-list is to be added to.
   * @param kref - The KRef.
   * @param eref - The ERef.
   */
  function addCListEntry(endpointId: EndpointId, kref: KRef, eref: ERef): void {
    const isExport = parseRef(eref).direction === 'export';
    ctx.kv.set(
      getSlotKey(endpointId, kref),
      buildReachableAndVatSlot(isExport, eref),
    );
    ctx.kv.set(getSlotKey(endpointId, eref), kref);
    incrementRefCount(kref, 'add|kref', { isExport, onlyRecognizable: true });
  }

  /**
   * Test if there's a c-list entry for some slot.
   *
   * @param endpointId - The endpoint of interest
   * @param slot - The slot of interest
   * @returns true iff this vat has a c-list entry mapping for `slot`.
   */
  function hasCListEntry(endpointId: EndpointId, slot: Ref): boolean {
    return ctx.kv.get(getSlotKey(endpointId, slot)) !== undefined;
  }

  /**
   * Remove an entry from an endpoint's c-list.
   *
   * @param endpointId - The endpoint whose c-list entry is to be removed.
   * @param kref - The KRef.
   * @param eref - The ERef.
   */
  function deleteCListEntry(
    endpointId: EndpointId,
    kref: KRef,
    eref: ERef,
  ): void {
    const kernelKey = getSlotKey(endpointId, kref);
    const vatKey = getSlotKey(endpointId, eref);
    assert(ctx.kv.get(kernelKey));
    clearReachableFlag(endpointId, kref);
    const { direction } = parseRef(eref);
    decrementRefCount(kref, 'delete|kref', {
      isExport: direction === 'export',
      onlyRecognizable: true,
    });
    ctx.kv.delete(kernelKey);
    ctx.kv.delete(vatKey);
  }

  /**
   * Generate a new eref for a kernel object or promise being imported into an
   * endpoint.
   *
   * @param endpointId - The endpoint the kref is being imported into.
   * @param kref - The kref for the kernel object or promise in question.
   *
   * @returns A new eref in the scope of the given endpoint for the given kernel entity.
   */
  function allocateErefForKref(endpointId: EndpointId, kref: KRef): ERef {
    let id;
    const refTag = endpointId.startsWith('v') ? '' : endpointId[0];
    let refType;
    if (isPromiseRef(kref)) {
      id = ctx.kv.get(`e.nextPromiseId.${endpointId}`);
      ctx.kv.set(`e.nextPromiseId.${endpointId}`, `${Number(id) + 1}`);
      refType = 'p';
    } else {
      id = ctx.kv.get(`e.nextObjectId.${endpointId}`);
      ctx.kv.set(`e.nextObjectId.${endpointId}`, `${Number(id) + 1}`);
      refType = 'o';
    }
    const eref = `${refTag}${refType}-${id}` as ERef;
    addCListEntry(endpointId, kref, eref);
    return eref;
  }

  /**
   * Look up the ERef that and endpoint's c-list maps a KRef to.
   *
   * @param endpointId - The endpoint in question.
   * @param eref - The ERef to look up.
   * @returns The KRef corresponding to `eref` in the given endpoints c-list, or undefined
   * if there is no such mapping.
   */
  function erefToKref(endpointId: EndpointId, eref: ERef): KRef | undefined {
    return ctx.kv.get<KRef>(getSlotKey(endpointId, eref));
  }

  /**
   * Look up the KRef that an endpoint's c-list maps an ERef to.
   *
   * @param endpointId - The endpoint in question.
   * @param kref - The KRef to look up.
   * @returns The given endpoint's ERef corresponding to `kref`, or undefined if
   * there is no such mapping.
   */
  function krefToEref(endpointId: EndpointId, kref: KRef): ERef | undefined {
    const key = getSlotKey(endpointId, kref);
    const data = ctx.kv.get(key);
    if (!data) {
      return undefined;
    }
    const { vatSlot } = parseReachableAndVatSlot(data);
    return vatSlot;
  }

  /**
   * Look up the ERefs that an endpoint's c-list maps a list of KRefs to,
   * without allocating entries or disturbing reachability.
   *
   * Every kref must already be mapped: a missing entry means the caller's list
   * of krefs and the c-list disagree, which is worth hearing about rather than
   * silently dropping the one that got away.
   *
   * @param endpointId - The endpoint in question.
   * @param krefs - The KRefs to look up.
   * @returns The given endpoint's ERefs corresponding to `krefs`.
   */
  function krefsToErefs(endpointId: EndpointId, krefs: KRef[]): ERef[] {
    return krefs.map(
      (kref) =>
        krefToEref(endpointId, kref) ??
        Fail`unmapped kref ${kref} in ${endpointId} c-list`,
    );
  }

  /**
   * Remove an entry from an endpoint's c-list given an eref.
   *
   * @param endpointId - The endpoint whose c-list entry is to be removed.
   * @param eref - The ERef.
   */
  function forgetEref(endpointId: EndpointId, eref: ERef): void {
    const kref = erefToKref(endpointId, eref);
    if (kref) {
      deleteCListEntry(endpointId, kref, eref);
    }
  }

  /**
   * Remove an entry from an endpoint's c-list given a kref.
   *
   * @param endpointId - The endpoint whose c-list entry is to be removed.
   * @param kref - The Kref.
   */
  function forgetKref(endpointId: EndpointId, kref: KRef): void {
    const eref = krefToEref(endpointId, kref);
    if (eref) {
      deleteCListEntry(endpointId, kref, eref);
    }
  }

  return {
    // C-List entries
    addCListEntry,
    hasCListEntry,
    deleteCListEntry,
    // Eref allocation
    allocateErefForKref,
    erefToKref,
    krefToEref,
    forgetEref,
    forgetKref,
    krefsToErefs,
  };
}
