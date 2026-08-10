import { Fail, q } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';
import type { KernelDatabase } from '@metamask/kernel-store';

import type { CrankBufferItem, StoreContext } from '../types.ts';

/**
 * Get the crank methods.
 *
 * @param ctx - The store context.
 * @param kdb - The kernel database.
 * @returns The crank methods.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getCrankMethods(ctx: StoreContext, kdb: KernelDatabase) {
  // Callers waiting to take a savepoint of their own, and a gate the run loop
  // holds off on starting a crank for while any of them are. The run loop is
  // otherwise synchronous from `endCrank` to the next `startCrank`, so it never
  // leaves a gap for them on its own.
  let outOfCrankWaiters = 0;
  let outOfCrankIdle: ReturnType<typeof makePromiseKit<void>> | undefined;

  /**
   * Start a crank.
   */
  function startCrank(): void {
    !ctx.inCrank || Fail`startCrank while already in a crank`;
    // A savepoint taken outside a crank is the outermost one on the connection,
    // and so the transaction's commit point. Opening a crank underneath it
    // would put this crank's writes inside someone else's transaction, to be
    // committed or discarded by them.
    outOfCrankWaiters === 0 ||
      Fail`startCrank while ${q(outOfCrankWaiters)} caller(s) hold the store outside a crank`;
    ctx.inCrank = true;
    const { promise, resolve } = makePromiseKit<void>();
    ctx.crankSettled = promise;
    ctx.resolveCrank = resolve;
  }

  /**
   * Take a turn at the store outside any crank, for work that must be its own
   * transaction: an inbound remote message, a peer's restart. Resolves only
   * once no crank is open, and holds the run loop off until the matching
   * {@link endOutOfCrank}.
   *
   * The caller's work must be synchronous. Awaiting while holding this would
   * park the run loop for the duration, and awaiting between the savepoint and
   * its release is the interleaving this exists to prevent.
   */
  async function beginOutOfCrank(): Promise<void> {
    outOfCrankWaiters += 1;
    // Created before the await below, so a run loop reaching `startCrank`
    // in the meantime sees the gate rather than racing past it.
    outOfCrankIdle ??= makePromiseKit<void>();
    try {
      while (ctx.inCrank) {
        // Awaiting `undefined` would spin this loop as fast as the microtask
        // queue allows, wedging the event loop with nothing to show for it.
        ctx.crankSettled !== undefined ||
          Fail`inCrank with no crankSettled to wait on`;
        await ctx.crankSettled;
      }
    } catch (error) {
      // The count is incremented above, before any of this can fail, so the
      // caller's `finally` has nothing to release yet. Left as it was, a gate
      // that never reaches zero parks the run loop for good.
      endOutOfCrank();
      throw error;
    }
  }

  /**
   * Give the run loop the store back. Must be called for every
   * {@link beginOutOfCrank}, from a `finally`.
   */
  function endOutOfCrank(): void {
    // An unmatched call would drive the count negative, and a gate that never
    // reaches zero parks the run loop for good.
    outOfCrankWaiters > 0 || Fail`endOutOfCrank without beginOutOfCrank`;
    outOfCrankWaiters -= 1;
    if (outOfCrankWaiters === 0) {
      outOfCrankIdle?.resolve();
      outOfCrankIdle = undefined;
    }
  }

  /**
   * @returns A promise to await before starting a crank, or undefined if
   * nothing is waiting — undefined rather than a resolved promise so that the
   * run loop's usual path stays synchronous.
   */
  function outOfCrankWorkPending(): Promise<void> | undefined {
    return outOfCrankIdle?.promise;
  }

  /**
   * Create a savepoint in the crank.
   *
   * @param name - The savepoint name.
   */
  function createCrankSavepoint(name: string): void {
    ctx.inCrank || Fail`createCrankSavepoint outside of crank`;
    const ordinal = ctx.savepoints.length;
    kdb.createSavepoint(`t${ordinal}`);
    // Copied, not referenced: `maybeFreeKrefs` is mutated in place from here on,
    // and this is the "before" a rollback restores.
    ctx.savepoints.push({
      name,
      maybeFreeKrefs: new Set(ctx.maybeFreeKrefs),
    });
  }

  /**
   * Rollback a crank.
   *
   * @param savepoint - The savepoint name.
   */
  function rollbackCrank(savepoint: string): void {
    ctx.inCrank || Fail`rollbackCrank outside of crank`;
    ctx.crankBuffer.length = 0; // Discard buffered outputs
    for (const ordinal of ctx.savepoints.keys()) {
      const restored = ctx.savepoints[ordinal];
      if (restored?.name === savepoint) {
        try {
          kdb.rollbackSavepoint(`t${ordinal}`);
          ctx.savepoints.length = ordinal;
        } catch (error) {
          ctx.savepoints.length = 0;
          revertStateBeneathRollback(error);
          throw error;
        }
        revertStateBeneathRollback();
        return;
      }
    }
    Fail`no such savepoint as "${q(savepoint)}"`;
  }

  /**
   * Revert what a database rollback cannot reach: the in-memory caches built
   * over the abandoned crank's writes.
   *
   * @param rollbackError - The error the rollback threw, if it threw.
   */
  function revertStateBeneathRollback(rollbackError?: unknown): void {
    try {
      ctx.refreshRunQueue();
      ctx.runQueueLengthCache = -1;
      ctx.refreshCachedValues();
      // Clearing all of them is correct only while a rollback discards the whole
      // delivery, which is all any caller asks for.
      ctx.maybeFreeKrefs.clear();
    } catch (revertError) {
      if (rollbackError === undefined) {
        throw revertError;
      }
      throw new Error(
        `Crank rollback failed and its caches could not be reverted: ${String(revertError)}`,
        { cause: rollbackError },
      );
    }
  }

  /**
   * Release all savepoints.
   */
  function releaseAllSavepoints(): void {
    if (ctx.savepoints.length > 0) {
      try {
        kdb.releaseSavepoint('t0');
      } finally {
        ctx.savepoints.length = 0;
      }
    }
  }

  /**
   * End a crank. Settles even if releasing the savepoints fails, so that a
   * database error can't strand every `waitForCrank()` waiter forever.
   */
  function endCrank(): void {
    ctx.inCrank || Fail`endCrank outside of crank`;
    try {
      releaseAllSavepoints();
    } finally {
      ctx.inCrank = false;
      ctx.resolveCrank?.();
      ctx.resolveCrank = undefined;
    }
  }

  /**
   * Wait until the crank is finished.
   *
   * @returns A promise that resolves when the crank is finished.
   */
  async function waitForCrank(): Promise<void> {
    return ctx.inCrank
      ? (ctx.crankSettled ?? Promise.resolve())
      : Promise.resolve();
  }

  /**
   * Buffer a vat output for delivery upon crank completion.
   *
   * @param item - The item to buffer.
   */
  function bufferCrankOutput(item: CrankBufferItem): void {
    ctx.crankBuffer.push(item);
  }

  /**
   * Flush the crank buffer, returning all buffered items.
   *
   * @returns The buffered items.
   */
  function flushCrankBuffer(): CrankBufferItem[] {
    const items = ctx.crankBuffer;
    ctx.crankBuffer = [];
    return items;
  }

  /**
   * Check whether the kernel is currently inside a crank.
   *
   * @returns True if a crank is in progress.
   */
  function isInCrank(): boolean {
    return ctx.inCrank;
  }

  return {
    startCrank,
    createCrankSavepoint,
    rollbackCrank,
    endCrank,
    releaseAllSavepoints,
    waitForCrank,
    beginOutOfCrank,
    endOutOfCrank,
    outOfCrankWorkPending,
    bufferCrankOutput,
    flushCrankBuffer,
    isInCrank,
  };
}
