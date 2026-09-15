import { Fail, q } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';
import type { KernelDatabase } from '@metamask/kernel-store';

import type { CrankBufferItem, Savepoint, StoreContext } from '../types.ts';

/**
 * Get the crank methods.
 *
 * @param ctx - The store context.
 * @param kdb - The kernel database.
 * @returns The crank methods.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getCrankMethods(ctx: StoreContext, kdb: KernelDatabase) {
  /**
   * Start a crank.
   */
  function startCrank(): void {
    !ctx.inCrank || Fail`startCrank while already in a crank`;
    ctx.inCrank = true;
    const { promise, resolve } = makePromiseKit<void>();
    ctx.crankSettled = promise;
    ctx.resolveCrank = resolve;
  }

  /**
   * Create a savepoint in the crank.
   *
   * @param name - The savepoint name.
   */
  function createCrankSavepoint(name: string): void {
    ctx.inCrank || Fail`createCrankSavepoint outside of crank`;
    const ordinal = ctx.savepoints.length;
    // Record the name only once the database has the savepoint. Recording it
    // first would leave `endCrank` trying to release a savepoint that was never
    // created, and that error would replace whatever really went wrong.
    kdb.createSavepoint(`t${ordinal}`);
    // Copied, not referenced: `maybeFreeKrefs` is mutated in place from here
    // on, and this is the "before" a rollback restores.
    ctx.savepoints.push({ name, maybeFreeKrefs: new Set(ctx.maybeFreeKrefs) });
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
          // A failed rollback discards the whole transaction (see
          // `rollbackSavepoint`), so no savepoint survives it and RAM goes back
          // to where the outermost one was taken, not to the named one.
          // Reverting before the rethrow, because leaving the caches as they
          // are would have the dying crank still holding the GC action it
          // consumed and the freed krefs it was about to collect.
          const outermost = ctx.savepoints[0] ?? restored;
          ctx.savepoints.length = 0;
          revertStateBeneathRollback(outermost, error);
          throw error;
        }
        revertStateBeneathRollback(restored);
        return;
      }
    }
    Fail`no such savepoint as "${q(savepoint)}"`;
  }

  /**
   * Revert what a database rollback cannot reach: the in-memory caches built
   * over the abandoned crank's writes.
   *
   * @param restored - The savepoint being rolled back to, whose snapshot of
   * `maybeFreeKrefs` is the "before" this restores.
   * @param rollbackError - The error the rollback threw, if it threw. Kept as
   * the `cause` should reverting fail too, since it is the root cause an
   * operator needs.
   */
  function revertStateBeneathRollback(
    restored: Savepoint,
    rollbackError?: unknown,
  ): void {
    // Nothing rolls back RAM. Krefs the abandoned crank added are collection
    // candidates only because of decrements that were just undone; left in
    // place, `collectGarbage` throws on a later crank for any promise that
    // crank created, killing the run loop over work that no longer exists.
    // Restored to the snapshot rather than cleared, because the set is not
    // per-crank: only `collectGarbage` empties it, so a candidate added while
    // the run loop was idle is still owed a collection. Done first, being the
    // one step that cannot fail.
    ctx.maybeFreeKrefs.clear();
    for (const kref of restored.maybeFreeKrefs) {
      ctx.maybeFreeKrefs.add(kref);
    }
    try {
      ctx.refreshRunQueue();
      ctx.runQueueLengthCache = -1;
      ctx.refreshCachedValues();
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
      kdb.releaseSavepoint('t0');
      ctx.savepoints.length = 0;
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
    bufferCrankOutput,
    flushCrankBuffer,
    isInCrank,
  };
}
