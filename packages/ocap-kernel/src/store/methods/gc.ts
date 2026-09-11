import { Fail } from '@endo/errors';

import { getBaseMethods } from './base.ts';
import { getCListMethods } from './clist.ts';
import { getObjectMethods } from './object.ts';
import { getPromiseMethods } from './promise.ts';
import { getReachableMethods } from './reachable.ts';
import { getRefCountMethods } from './refcount.ts';
import { getSubclusterMethods } from './subclusters.ts';
import { getVatMethods } from './vat.ts';
import { isVatId, makeGCAction } from '../../types.ts';
import type {
  EndpointId,
  KRef,
  GCAction,
  RunQueueItemBringOutYourDead,
} from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { parseKernelSlot } from '../utils/kernel-slots.ts';

/**
 * Create a store for garbage collection.
 *
 * @param ctx - The store context.
 * @returns The GC store.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getGCMethods(ctx: StoreContext) {
  const { getSlotKey, getOwnerKey } = getBaseMethods(ctx.kv);
  const { getRefCount, decrementRefCount } = getRefCountMethods(ctx);
  const { getObjectRefCount, deleteKernelObject, getOwner } =
    getObjectMethods(ctx);
  const { getKernelPromise, deleteKernelPromise } = getPromiseMethods(ctx);
  const { getImporters, isVatTerminated } = getVatMethods(ctx);
  const { getReachableFlag, getReachableAndVatSlot } = getReachableMethods(ctx);
  const { clearEmptySubclusters } = getSubclusterMethods(ctx);
  const { hasCListEntry } = getCListMethods(ctx);

  /**
   * Give up the kernel's record of who owns an object. The object survives only
   * as long as something still names it; the collector disposes of it from
   * there, retiring any stragglers that still recognize it.
   *
   * Called when an owner stops naming its own export — it retired or abandoned
   * it, or a GC `retireExport` was delivered. Without this the owner mapping
   * outlives the c-list entry it was reachable through, which both leaks the
   * object record and leaves `collectGarbage` reading a c-list entry that is no
   * longer there.
   *
   * Disowning an object is only ever the owner's own doing, so `expectedOwner`
   * is required: taking it on trust would let one endpoint erase another's claim
   * to an object it is still exporting. An object that is already orphaned is
   * left alone — the caller and the kernel agree it has no owner.
   *
   * @param kref - The object whose owner mapping is to be dropped.
   * @param expectedOwner - The endpoint the caller believes owns `kref`.
   */
  function orphanKernelObject(kref: KRef, expectedOwner: EndpointId): void {
    const owner = getOwner(kref);
    if (owner === undefined) {
      return;
    }
    owner === expectedOwner ||
      Fail`cannot orphan ${kref} for ${expectedOwner}: owned by ${owner}`;
    ctx.kv.delete(getOwnerKey(kref));
    ctx.maybeFreeKrefs.add(kref);
  }

  /**
   * Get the set of GC actions to perform.
   *
   * @returns The set of GC actions to perform.
   */
  function getGCActions(): Set<GCAction> {
    // Safe to cast: all actions are created via makeGCAction(), which
    // validates format before storage. The JSON roundtrip preserves strings.
    const actions = JSON.parse(ctx.gcActions.get() ?? '[]') as GCAction[];
    return new Set(actions);
  }

  /**
   * Set the set of GC actions to perform.
   *
   * @param actions - The set of GC actions to perform.
   */
  function setGCActions(actions: Set<GCAction>): void {
    const a = Array.from(actions);
    a.sort();
    ctx.gcActions.set(JSON.stringify(a));
  }

  /**
   * Add a new GC action to the set of GC actions to perform.
   *
   * @param newActions - The new GC action to add.
   */
  function addGCActions(newActions: GCAction[]): void {
    const actions = getGCActions();
    for (const action of newActions) {
      actions.add(action);
    }
    setGCActions(actions);
  }

  /**
   * Schedule an endpoint for reaping.
   *
   * @param endpointId - The endpoint (vat or remote) to schedule for reaping.
   */
  function scheduleReap(endpointId: EndpointId): void {
    const queue = JSON.parse(ctx.reapQueue.get() ?? '[]');
    if (!queue.includes(endpointId)) {
      queue.push(endpointId);
      ctx.reapQueue.set(JSON.stringify(queue));
    }
  }

  /**
   * Get the next reap action.
   *
   * @returns The next reap action, or undefined if the queue is empty.
   */
  function nextReapAction(): RunQueueItemBringOutYourDead | undefined {
    const queue = JSON.parse(ctx.reapQueue.get() ?? '[]');
    if (queue.length > 0) {
      const endpointId = queue.shift();
      ctx.reapQueue.set(JSON.stringify(queue));
      return harden({ type: 'bringOutYourDead', endpointId });
    }
    return undefined;
  }

  /**
   * Retires kernel objects by notifying importers and removing the objects.
   *
   * @param koids - Array of kernel object IDs to retire.
   */
  function retireKernelObjects(koids: KRef[]): void {
    Array.isArray(koids) || Fail`retireExports given non-Array ${koids}`;
    const newActions: GCAction[] = [];
    for (const koid of koids) {
      const importers = getImporters(koid);
      for (const vatID of importers) {
        newActions.push(makeGCAction(vatID, 'retireImport', koid));
      }
      deleteKernelObject(koid);
    }
    addGCActions(newActions);
  }

  /**
   * Processes reference counts for kernel resources and performs garbage collection actions
   * for resources that are no longer referenced or should be retired.
   */
  function collectGarbage(): void {
    const actions: Set<GCAction> = new Set();
    for (const kref of ctx.maybeFreeKrefs.values()) {
      const { type } = parseKernelSlot(kref);
      if (type === 'promise') {
        const kpid = kref;
        const kp = getKernelPromise(kpid);
        const refCount = getRefCount(kpid);
        if (refCount === 0) {
          if (kp.state === 'fulfilled' || kp.state === 'rejected') {
            // https://github.com/Agoric/agoric-sdk/issues/9888 don't assume promise is settled
            for (const slot of kp.value?.slots ?? []) {
              // Note: the following decrement can result in an addition to the
              // maybeFreeKrefs set, which we are in the midst of iterating.
              // TC39 went to a lot of trouble to ensure that this is kosher.
              decrementRefCount(slot, 'gc|promise|slot');
            }
          }
          deleteKernelPromise(kpid);
        }
      }

      if (type === 'object') {
        const { reachable, recognizable } = getObjectRefCount(kref);
        if (reachable === 0) {
          let ownerVatID = getOwner(kref);
          if (ownerVatID === 'kernel') {
            continue;
          }
          const terminated =
            ownerVatID !== undefined &&
            isVatId(ownerVatID) &&
            isVatTerminated(ownerVatID);

          // Some objects that are still owned, but the owning vat
          // might still alive, or might be terminated and in the
          // process of being deleted. These two clauses are
          // mutually exclusive.
          if (ownerVatID && !terminated && !hasCListEntry(ownerVatID, kref)) {
            // Should be unreachable: every path that tears down an owner's
            // export entry orphans the object with it. Repair it so the
            // collector can keep going, but say so — absorbing this in silence
            // would hide whatever upstream broke the pairing.
            ctx.logger?.error(
              `${kref} is owned by live endpoint ${ownerVatID} which has no ` +
                `c-list entry for it; treating it as orphaned`,
            );
            orphanKernelObject(kref, ownerVatID);
            ownerVatID = undefined;
          } else if (ownerVatID && !terminated) {
            const vatConsidersReachable = getReachableFlag(ownerVatID, kref);
            if (vatConsidersReachable) {
              // the reachable count is zero, but the vat doesn't realize it
              actions.add(makeGCAction(ownerVatID, 'dropExport', kref));
            }
            if (recognizable === 0) {
              // No assertion that the owner has stopped considering this
              // reachable: when the last holder both drops and retires before
              // we run, we queue dropExport and retireExport together and the
              // owner's flag is still set until the first of them is delivered.
              actions.add(makeGCAction(ownerVatID, 'retireExport', kref));
            }
          } else if (ownerVatID && terminated) {
            // When we're slowly deleting a vat, and one of its
            // exports becomes unreferenced, we obviously must not
            // send dropExports or retireExports into the dead vat.
            // We fast-forward the abandonment that slow-deletion
            // would have done, then treat the object as orphaned.

            const { vatSlot } = getReachableAndVatSlot(ownerVatID, kref);
            // delete directly, not orphanKernelObject(), which
            // would re-submit to maybeFreeKrefs
            ctx.kv.delete(getOwnerKey(kref));
            ctx.kv.delete(getSlotKey(ownerVatID, kref));
            ctx.kv.delete(getSlotKey(ownerVatID, vatSlot));
            // now fall through to the orphaned case
            ownerVatID = undefined;
          }

          // Now handle objects which were orphaned. NOTE: this
          // includes objects which were owned by a terminated (but
          // not fully deleted) vat, where `ownerVatID` was cleared
          // in the last line of that previous clause (the
          // fall-through case). Don't try to change this `if
          // (!ownerVatID)` into an `else if`: the two clauses are
          // *not* mutually-exclusive.
          if (!ownerVatID) {
            // orphaned and unreachable, so retire it. If the kref
            // is recognizable, then we need retireKernelObjects()
            // to scan for importers and send retireImports (and
            // delete), else we can call deleteKernelObject directly
            if (recognizable) {
              retireKernelObjects([kref]);
            } else {
              deleteKernelObject(kref);
            }
          }
        }
      }
    }
    addGCActions([...actions]);
    ctx.maybeFreeKrefs.clear();
    clearEmptySubclusters();
  }

  return {
    getGCActions,
    setGCActions,
    addGCActions,
    scheduleReap,
    nextReapAction,
    retireKernelObjects,
    orphanKernelObject,
    collectGarbage,
  };
}
