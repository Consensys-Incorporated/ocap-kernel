import { getBaseMethods } from './base.ts';
import { getRefCountMethods } from './refcount.ts';
import type { KRef } from '../../types.ts';
import type { StoreContext } from '../types.ts';

const HELD_RESULT_PREFIX = 'heldResult.';

/**
 * Create a store for the result promises the kernel holds on behalf of
 * `queueMessage` callers, which hold krefs without a c-list.
 *
 * @param ctx - The store context.
 * @returns Methods for holding and releasing result promises.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getHeldResultMethods(ctx: StoreContext) {
  const { incrementRefCount, decrementRefCount } = getRefCountMethods(ctx);
  const { getPrefixedKeys } = getBaseMethods(ctx.kv);

  /**
   * Hold a result promise for the caller of the message it answers.
   *
   * @param kpid - The result promise.
   */
  function holdResult(kpid: KRef): void {
    // Before the row, so a refused increment records no hold.
    incrementRefCount(kpid, 'hold|result');
    ctx.kv.set(`${HELD_RESULT_PREFIX}${kpid}`, `${Date.now()}`);
  }

  /**
   * Check whether a result promise is held.
   *
   * @param kpid - The promise.
   * @returns True if it is held.
   */
  function isResultHeld(kpid: KRef): boolean {
    return ctx.kv.get(`${HELD_RESULT_PREFIX}${kpid}`) !== undefined;
  }

  /**
   * Release a held result promise.
   *
   * @param kpid - The promise.
   * @returns False if it was not held.
   */
  function releaseHeldResult(kpid: KRef): boolean {
    if (!isResultHeld(kpid)) {
      return false;
    }
    decrementRefCount(kpid, 'release|result');
    ctx.kv.delete(`${HELD_RESULT_PREFIX}${kpid}`);
    return true;
  }

  /**
   * List the held result promises.
   *
   * @returns The kpid of each.
   */
  function getHeldResults(): KRef[] {
    return [...getPrefixedKeys(HELD_RESULT_PREFIX)].map(
      (key) => key.slice(HELD_RESULT_PREFIX.length) as KRef,
    );
  }

  return {
    holdResult,
    isResultHeld,
    releaseHeldResult,
    getHeldResults,
  };
}
