import { Fail } from '@endo/errors';

import { getBaseMethods } from './base.ts';
import { ROOT_OBJECT_VREF, insistEndpointId } from '../../types.ts';
import type { EndpointId, KRef, VatId } from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { makeKernelSlot } from '../utils/kernel-slots.ts';

/**
 * Create an object store object that provides functionality for managing kernel objects.
 *
 * @param ctx - The store context.
 * @returns An object store object that maps various persistent kernel data
 * structures onto `kv`.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getObjectMethods(ctx: StoreContext) {
  const { getSlotKey, incCounter, refCountKey, getOwnerKey, getRevokedKey } =
    getBaseMethods(ctx.kv);

  /**
   * Create a new kernel object, born unreferenced at `(0, 0)`. Every unit of
   * an object's counts is owed to a reference someone else holds — an
   * importer's c-list entry, a queued message, a promise's resolution value, a
   * pin — and the owner's own export entry is not one of them. The object is
   * initially unrevoked.
   *
   * @param owner - The endpoint or 'kernel' that is the owner of the new object.
   * @returns The new object's KRef.
   */
  function initKernelObject(owner: EndpointId | 'kernel'): KRef {
    const koId = getNextObjectId();
    ctx.kv.set(getOwnerKey(koId), owner);
    setObjectRefCount(koId, { reachable: 0, recognizable: 0 });
    return koId;
  }

  /**
   * Get a kernel object's owner.
   *
   * @param koId - The KRef of the kernel object of interest.
   * @returns The identity of the vat or remote that owns the object.
   */
  function getOwner(koId: KRef): EndpointId | 'kernel' | undefined {
    const raw = ctx.kv.get(getOwnerKey(koId));
    if (raw === undefined || raw === 'kernel') {
      return raw;
    }
    insistEndpointId(raw);
    return raw;
  }

  /**
   * Get the root object for a vat.
   *
   * @param vatId - The ID of the vat of interest.
   * @returns The root object for the vat.
   */
  function getRootObject(vatId: VatId): KRef | undefined {
    return ctx.kv.get<KRef>(getSlotKey(vatId, ROOT_OBJECT_VREF));
  }

  /**
   * True if `kref` is the root object for `vatId`.
   *
   * Every vat exports its root as slot `o+0`, which gives a c‑list entry
   *
   * @param kref - The KRef of the object of interest.
   * @param vatId - The ID of the vat of interest.
   * @returns True if `kref` is the root object for `vatId`.
   */
  function isRootObject(kref: KRef, vatId: VatId): boolean {
    return getRootObject(vatId) === kref;
  }

  /**
   * Expunge a kernel object from the kernel's persistent state.
   *
   * @param koId - The KRef of the kernel object to delete.
   */
  function deleteKernelObject(koId: KRef): void {
    ctx.kv.delete(getOwnerKey(koId));
    ctx.kv.delete(refCountKey(koId));
    ctx.kv.delete(getRevokedKey(koId));
  }

  /**
   * Obtain a KRef for the next unallocated kernel object.
   *
   * @returns The next koId use.
   */
  function getNextObjectId(): KRef {
    return makeKernelSlot('object', incCounter(ctx.nextObjectId));
  }

  /**
   * Get the reference counts for a kernel object
   *
   * @param kref - The KRef of the object of interest.
   * @returns The reference counts for the object.
   */
  function getObjectRefCount(kref: KRef): {
    reachable: number;
    recognizable: number;
  } {
    const data = ctx.kv.get(refCountKey(kref));
    if (!data) {
      return { reachable: 0, recognizable: 0 };
    }
    const [reachable = 0, recognizable = 0] = data.split(',').map(Number);
    reachable <= recognizable ||
      Fail`refMismatch(get) ${kref} ${reachable},${recognizable}`;
    return { reachable, recognizable };
  }

  /**
   * Set the reference counts for a kernel object
   *
   * @param kref - The KRef of the object of interest.
   * @param counts - The reference counts to set.
   * @param counts.reachable - The reachable reference count.
   * @param counts.recognizable - The recognizable reference count.
   */
  function setObjectRefCount(
    kref: KRef,
    counts: { reachable: number; recognizable: number },
  ): void {
    const { reachable, recognizable } = counts;
    assert.typeof(reachable, 'number');
    assert.typeof(recognizable, 'number');
    (reachable >= 0 && recognizable >= 0) ||
      Fail`${kref} underflow ${reachable},${recognizable}`;
    reachable <= recognizable ||
      Fail`refMismatch(set) ${kref} ${reachable},${recognizable}`;
    ctx.kv.set(refCountKey(kref), `${reachable},${recognizable}`);
  }

  return {
    initKernelObject,
    getOwner,
    getRootObject,
    isRootObject,
    deleteKernelObject,
    getNextObjectId,
    getObjectRefCount,
    setObjectRefCount,
  };
}
