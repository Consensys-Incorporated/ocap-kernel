import { Fail, q } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';
import type { KernelDatabase } from '@metamask/kernel-store';

import type { CrankBufferItem, Savepoint, StoreContext } from '../types.ts';

/**
 * @param value - Anything.
 * @returns Whether it is a thenable, which is what `await` acts on.
 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
  );
}

/**
 * `never` for any `Result` that has a thenable member, so that the callback
 * cannot be written.
 *
 * The tuple stops the conditional distributing, which is what makes it judge a
 * union whole: distributed, `number | Promise<number>` resolves to
 * `unknown | never`, which is `unknown`, and lets one promise-returning branch
 * of several through.
 */
type Synchronous<Result> = [Extract<Result, PromiseLike<unknown>>] extends [
  never,
]
  ? unknown
  : never;

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
   * Private to this module; callers take their turn through
   * {@link withStoreOutOfCrank}.
   */
  async function beginOutOfCrank(): Promise<void> {
    outOfCrankWaiters += 1;
    // Created before the await below, so a run loop that consults
    // `outOfCrankWorkPending` in the meantime has something to wait on. The
    // count it increments above is what `startCrank` itself refuses on.
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
   * Hold the store outside any crank for the duration of `work`, and give it
   * back however `work` ends. Paired here rather than by callers because a turn
   * never given back leaves the run loop waiting on a promise nothing resolves:
   * no failure, no log, no timeout.
   *
   * `work` must be synchronous. The turn is given back the moment it returns,
   * so work that awaits resumes with the run loop free to start a crank — and
   * both callers take a savepoint inside it, which would then nest inside that
   * crank rather than being the commit point it has to be. A caller that needs
   * to await does it with what `work` hands back.
   *
   * {@link Synchronous} cannot refuse an explicit
   * `withStoreOutOfCrank<void>`, since a `Promise<void>` is assignable to a
   * `void` return, nor an `unknown` or `any` one — hence the check below.
   *
   * @param work - The synchronous work to do while holding the store.
   * @returns What `work` returned.
   */
  async function withStoreOutOfCrank<Result>(
    work: () => Result & Synchronous<Result>,
  ): Promise<Result> {
    await beginOutOfCrank();
    try {
      const result = work();
      if (isPromiseLike(result)) {
        // Nothing awaits this thenable, and an abandoned rejection is an
        // unhandled one, which ends the process.
        Promise.resolve(result).catch(() => undefined);
        // Thrown from inside the `try`, so the `finally` still gives the turn
        // back rather than parking the run loop on top of the mistake.
        Fail`withStoreOutOfCrank given work that is not synchronous`;
      }
      return result;
    } finally {
      endOutOfCrank();
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
          // Before the rethrow, and not only on the path below. A failed
          // rollback discards the whole transaction, so the database has moved
          // back at least as far as a successful rollback would have taken it
          // and these caches are at least as stale. Rethrowing ahead of this
          // would leave the dying crank holding the GC action it consumed and
          // the freed krefs it was about to collect.
          revertStateBeneathRollback(restored, error);
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
    try {
      ctx.refreshRunQueue();
      ctx.runQueueLengthCache = -1;
      ctx.refreshCachedValues();
      // Nothing rolls back RAM. Krefs this crank added are collection
      // candidates only because of decrements that were just undone; left in
      // place, `collectGarbage` throws on a later crank for any promise this one
      // created, killing the run loop over work that no longer exists.
      // Restored to the savepoint's snapshot rather than cleared, because the
      // set is not per-crank: only `collectGarbage` empties it, so a candidate
      // added while the run loop was idle — `terminateVat` unpinning a root is
      // the real path — is still owed a collection and must survive an
      // unrelated crank's rollback.
      ctx.maybeFreeKrefs.clear();
      for (const kref of restored.maybeFreeKrefs) {
        ctx.maybeFreeKrefs.add(kref);
      }
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
    withStoreOutOfCrank,
    outOfCrankWorkPending,
    bufferCrankOutput,
    flushCrankBuffer,
    isInCrank,
  };
}
