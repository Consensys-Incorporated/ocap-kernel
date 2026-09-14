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
 * `withStoreOutOfCrank`, and both directions of the overlap are refused. The
 * turn is taken and given back by that one call because a turn never given back
 * parks the run loop with nothing to show for it.
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
    await kernelStore.withStoreOutOfCrank(() => {
      expect(() => kernelStore.startCrank()).toThrow(
        'startCrank while 1 caller(s) hold the store outside a crank',
      );
    });
  });

  it('lets a caller through once the crank it arrived during has ended', async () => {
    kernelStore.startCrank();

    let held = false;
    const turn = kernelStore.withStoreOutOfCrank(() => {
      held = true;
    });

    await Promise.resolve();
    expect(held).toBe(false);

    kernelStore.endCrank();
    await turn;

    expect(held).toBe(true);
  });

  it('holds the next crank off while a caller is waiting', async () => {
    kernelStore.startCrank();
    const turn = kernelStore.withStoreOutOfCrank(() => undefined);

    // What the run loop consults between `endCrank` and the next `startCrank`.
    expect(kernelStore.outOfCrankWorkPending()).toBeDefined();

    kernelStore.endCrank();
    await turn;

    expect(kernelStore.outOfCrankWorkPending()).toBeUndefined();
  });

  it('nothing to wait for while no caller is holding', () => {
    expect(kernelStore.outOfCrankWorkPending()).toBeUndefined();
  });

  it('gives the store back when the work throws', async () => {
    await expect(
      kernelStore.withStoreOutOfCrank(() => {
        throw new Error('the delivery failed');
      }),
    ).rejects.toThrow('the delivery failed');

    expect(kernelStore.outOfCrankWorkPending()).toBeUndefined();
    expect(() => kernelStore.startCrank()).not.toThrow();
  });

  it('returns what the work returned', async () => {
    expect(await kernelStore.withStoreOutOfCrank(() => 'committed')).toBe(
      'committed',
    );
  });

  // The turn is given back the moment the work returns, so work that awaits
  // resumes with the run loop free to start a crank — and the savepoint both
  // callers take inside it would nest in that crank rather than being the
  // commit point. The type refuses this; the check is for what inference lets
  // through.
  it('refuses work that is not synchronous', async () => {
    await expect(
      kernelStore.withStoreOutOfCrank(
        (async () => undefined) as unknown as () => undefined,
      ),
    ).rejects.toThrow('work that is not synchronous');

    expect(kernelStore.outOfCrankWorkPending()).toBeUndefined();
    expect(() => kernelStore.startCrank()).not.toThrow();
  });

  // The run loop's protocol: re-check the gate until nothing is waiting, then
  // start the crank with no await in between. Checking once would have it
  // resume into `startCrank` with a caller already holding, which is a refusal
  // it cannot survive.
  it('lets a caller that arrives as the gate clears take its turn too', async () => {
    let crankStarted = false;
    let second: Promise<void> | undefined;

    const first = kernelStore.withStoreOutOfCrank(() => {
      // Registers before the first caller's turn is given back, so the gate
      // never reaches zero between the two.
      second = kernelStore.withStoreOutOfCrank(() => undefined);
    });

    const runLoopTurn = (async () => {
      let pending = kernelStore.outOfCrankWorkPending();
      while (pending) {
        await pending;
        pending = kernelStore.outOfCrankWorkPending();
      }
      kernelStore.startCrank();
      crankStarted = true;
    })();

    await first;
    expect(crankStarted).toBe(false);

    await second;
    await runLoopTurn;

    expect(crankStarted).toBe(true);
  });

  it('holds the crank off until the last of several callers is done', async () => {
    kernelStore.startCrank();
    const order: string[] = [];
    const first = kernelStore.withStoreOutOfCrank(() => {
      order.push('first');
    });
    const second = kernelStore.withStoreOutOfCrank(() => {
      order.push('second');
      // The first caller has had its turn and given it back. The gate is still
      // closed, because this one has not.
      order.push(
        kernelStore.outOfCrankWorkPending() === undefined ? 'open' : 'closed',
      );
    });

    kernelStore.endCrank();
    await Promise.all([first, second]);

    expect(order).toStrictEqual(['first', 'second', 'closed']);
    expect(kernelStore.outOfCrankWorkPending()).toBeUndefined();
  });
});
