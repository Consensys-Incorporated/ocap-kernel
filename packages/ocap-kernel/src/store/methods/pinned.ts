import { getBaseMethods } from './base.ts';
import { getRefCountMethods } from './refcount.ts';
import type { KRef } from '../../types.ts';
import type { StoreContext } from '../types.ts';

/**
 * The prefix shared by every object's pin count, for iterating over them.
 *
 * A pin count lives in a row of its own rather than in one row listing every
 * pin, so pinning is a single write whatever else is pinned. Anything a holder
 * outside the kernel's own state keeps alive is pinned — an ocap URL's target,
 * for one — so the number of pinned objects is not bounded by the kernel's
 * own structure.
 */
const PIN_PREFIX = 'pinned.';

/**
 * Create a pinned store that provides high-level functionality for managing pinned objects.
 *
 * @param ctx - The store context.
 * @returns A pinned store with functions for pinning/unpinning objects and managing pinned objects.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getPinMethods(ctx: StoreContext) {
  const { incrementRefCount, decrementRefCount } = getRefCountMethods(ctx);
  const { getPrefixedKeys } = getBaseMethods(ctx.kv);

  /**
   * Generate the storage key for an object's pin count.
   *
   * @param kref - The KRef of interest.
   * @returns the key to store the indicated pin count at.
   */
  function pinCountKey(kref: KRef): string {
    return `${PIN_PREFIX}${kref}`;
  }

  /**
   * Get the number of pins held on an object.
   *
   * @param kref - The KRef of the object to count the pins of.
   * @returns How many times the object has been pinned and not unpinned.
   */
  function getPinCount(kref: KRef): number {
    return Number(ctx.kv.get(pinCountKey(kref)) ?? 0);
  }

  /**
   * Pin a kernel object to prevent it from being garbage collected.
   * Multiple calls will increment the pin count for the object.
   *
   * @param kref - The KRef of the object to pin.
   */
  function pinObject(kref: KRef): void {
    const pins = getPinCount(kref);
    // Before the count, so a refused increment records no pin.
    incrementRefCount(kref, 'pin');
    ctx.kv.set(pinCountKey(kref), `${pins + 1}`);
  }

  /**
   * Unpin a kernel object, allowing it to be garbage collected if no other references exist.
   * Each call decrements the pin count for the object. The object is only fully unpinned
   * when all pins are removed.
   *
   * @param kref - The KRef of the object to unpin.
   */
  function unpinObject(kref: KRef): void {
    const pins = getPinCount(kref);
    if (pins === 0) {
      return;
    }
    decrementRefCount(kref, 'unpin');
    if (pins === 1) {
      ctx.kv.delete(pinCountKey(kref));
    } else {
      ctx.kv.set(pinCountKey(kref), `${pins - 1}`);
    }
  }

  /**
   * Get all pinned objects.
   *
   * @returns An array of KRefs for all pinned objects, each named once however
   * many pins it holds; `getPinCount` gives that number.
   */
  function getPinnedObjects(): KRef[] {
    return [...getPrefixedKeys(PIN_PREFIX)].map(
      (key) => key.slice(PIN_PREFIX.length) as KRef,
    );
  }

  /**
   * Check if an object is pinned.
   *
   * @param kref - The KRef of the object to check.
   * @returns True if the object is pinned, false otherwise.
   */
  function isObjectPinned(kref: KRef): boolean {
    return getPinCount(kref) > 0;
  }

  return {
    pinObject,
    unpinObject,
    getPinCount,
    getPinnedObjects,
    isObjectPinned,
  };
}
