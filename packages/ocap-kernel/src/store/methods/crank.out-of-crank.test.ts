import { describe, it, expect, beforeEach } from 'vitest';

import { makeMapKernelDatabase } from '../../../test/storage.ts';
import { makeKernelStore } from '../index.ts';

/**
 * A savepoint taken through `KernelStore.createSavepoint` is invisible to
 * `createCrankSavepoint`'s ordinal naming, so overlapping one with a crank
 * leaves the crank's release committing into someone else's transaction, or the
 * caller's writes discarded by a delivery rollback it had nothing to do with.
 * See `kernel-store`'s `nodejs.savepoint-interleaving.test.ts` for what SQLite
 * does in each case.
 *
 * The two are kept apart instead: callers take their turn through
 * `beginOutOfCrank`, and both directions of the overlap are refused.
 */
describe('store work outside a crank', () => {
  let kernelStore: ReturnType<typeof makeKernelStore>;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
  });

  it('refuses a savepoint taken inside a crank', () => {
    kernelStore.startCrank();

    expect(() => kernelStore.createSavepoint('receive_r1_7')).toThrow(
      'createSavepoint "receive_r1_7" inside a crank',
    );
  });

  it('refuses a crank started while a caller holds the store', async () => {
    await kernelStore.beginOutOfCrank();

    expect(() => kernelStore.startCrank()).toThrow(
      'startCrank while 1 caller(s) hold the store outside a crank',
    );

    kernelStore.endOutOfCrank();
  });

  it('lets a caller through once the crank it arrived during has ended', async () => {
    kernelStore.startCrank();

    let held = false;
    const turn = (async () => {
      await kernelStore.beginOutOfCrank();
      held = true;
    })();

    await Promise.resolve();
    expect(held).toBe(false);

    kernelStore.endCrank();
    await turn;

    expect(held).toBe(true);
    kernelStore.endOutOfCrank();
  });

  it('holds the next crank off while a caller is waiting', async () => {
    kernelStore.startCrank();
    const turn = kernelStore.beginOutOfCrank();

    // What the run loop consults between `endCrank` and the next `startCrank`.
    expect(kernelStore.outOfCrankWorkPending()).toBeDefined();

    kernelStore.endCrank();
    await turn;
    kernelStore.endOutOfCrank();

    expect(kernelStore.outOfCrankWorkPending()).toBeUndefined();
  });

  it('nothing to wait for while no caller is holding', () => {
    expect(kernelStore.outOfCrankWorkPending()).toBeUndefined();
  });

  it('lets a caller that arrives as the gate clears take its turn too', async () => {
    await kernelStore.beginOutOfCrank();

    // The run loop's protocol: re-check the gate until nothing is waiting, then
    // start the crank with no await in between.
    let crankStarted = false;
    const runLoopTurn = (async () => {
      let pending = kernelStore.outOfCrankWorkPending();
      while (pending) {
        await pending;
        pending = kernelStore.outOfCrankWorkPending();
      }
      kernelStore.startCrank();
      crankStarted = true;
    })();

    // The first caller releases, and a second registers in the microtask that
    // resolution queues — ahead of the run loop's own continuation. Checking
    // the gate once would have the run loop resume into `startCrank` with this
    // caller already holding, which is a refusal it cannot survive.
    kernelStore.endOutOfCrank();
    await kernelStore.beginOutOfCrank();
    expect(crankStarted).toBe(false);

    kernelStore.endOutOfCrank();
    await runLoopTurn;

    expect(crankStarted).toBe(true);
  });

  it('refuses an unmatched release, which would park the run loop for good', () => {
    expect(() => kernelStore.endOutOfCrank()).toThrow(
      'endOutOfCrank without beginOutOfCrank',
    );
  });

  it('holds the crank off until the last of several callers is done', async () => {
    await kernelStore.beginOutOfCrank();
    await kernelStore.beginOutOfCrank();

    kernelStore.endOutOfCrank();
    expect(kernelStore.outOfCrankWorkPending()).toBeDefined();

    kernelStore.endOutOfCrank();
    expect(kernelStore.outOfCrankWorkPending()).toBeUndefined();
  });
});
