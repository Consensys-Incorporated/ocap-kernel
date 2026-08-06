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
    ctx.savepoints.push(name);
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
      if (ctx.savepoints[ordinal] === savepoint) {
        try {
          kdb.rollbackSavepoint(`t${ordinal}`);
          // Left listed, `endCrank`'s release would commit the crank we just
          // abandoned.
          ctx.savepoints.length = ordinal;
        } catch (error) {
          // A failed rollback discards the whole transaction, so every savepoint
          // is gone, not just this one. Truncating to `ordinal` would have
          // `endCrank` release a `t0` the database lacks and throw over whatever
          // really killed the kernel.
          ctx.savepoints.length = 0;
          throw error;
        }
        // The rollback reverted DB state but in-memory caches are stale.
        // Recreate the run queue so its cached head/tail are re-read from DB.
        ctx.refreshRunQueue();
        // Invalidate the run queue length cache so it's recalculated from
        // the database on next access, since the rollback may have restored
        // dequeued items.
        ctx.runQueueLengthCache = -1;
        return;
      }
    }
    Fail`no such savepoint as "${q(savepoint)}"`;
  }

  /**
   * Release all savepoints.
   */
  function releaseAllSavepoints(): void {
    if (ctx.savepoints.length > 0) {
      try {
        kdb.releaseSavepoint('t0');
      } finally {
        // A failed release discards the transaction too, so the database has no
        // savepoints left either. Left listed, the next crank would number its
        // savepoint `t1` and aim every later release and rollback one crank past
        // the one it meant to end.
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
    bufferCrankOutput,
    flushCrankBuffer,
    isInCrank,
  };
}
