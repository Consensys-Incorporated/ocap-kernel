import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { makeKernelStore } from './store/index.ts';
import type { RunQueueItem } from './types.ts';

/**
 * What a caller actually gets when the run loop stops, against a real store —
 * `KernelQueue.test.ts` mocks `makePromiseKit`, so nothing there can tell a
 * loop that has come to rest from one that has merely been asked to.
 */
describe('the window a stopped run loop opens', () => {
  /**
   * A queue over a real store, with a run queue holding `items` sends.
   *
   * @param items - How many items to queue.
   * @returns The store and its queue.
   */
  async function makeFixture(items: number): Promise<{
    kernelStore: ReturnType<typeof makeKernelStore>;
    kernelQueue: KernelQueue;
  }> {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kernelStore = makeKernelStore(kdb);
    kernelStore.initEndpoint('v1');
    for (let queued = 0; queued < items; queued += 1) {
      kernelStore.enqueueRun({
        type: 'send',
        target: kernelStore.initKernelObject('v1'),
        message: { methargs: { body: '', slots: [] }, result: null },
      } as unknown as RunQueueItem);
    }
    return {
      kernelStore,
      kernelQueue: new KernelQueue(kernelStore, async () => undefined),
    };
  }

  it('has no crank open when the caller gets control back', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(2);
    let stopped: Promise<boolean> | undefined;
    const running = kernelQueue.run(async () => {
      // Asked from inside a delivery, so a crank is open at the moment of
      // asking and the loop has to finish it first.
      stopped ??= kernelQueue.stopRunLoop();
      return undefined;
    });

    expect(await stopped).toBe(true);

    // The whole of what makes the caller's writes safe.
    expect(kernelStore.isInCrank()).toBe(false);
    await running;
  });

  it('keeps a write made in it out of the next crank', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(2);
    let stopped: Promise<boolean> | undefined;
    const running = kernelQueue.run(async () => {
      stopped ??= kernelQueue.stopRunLoop();
      return undefined;
    });
    await stopped;
    await running;

    kernelStore.setVatConfig('v9', { bundleName: 'written-between-cranks' });

    // A crank that aborts everything it did must not take this with it, which
    // is what happened when the control plane merely waited out the crank in
    // flight and wrote into the next one.
    const abortingRun = kernelQueue.run(async () => ({ abort: true }));
    await kernelQueue.stopRunLoop();
    await abortingRun;

    expect(kernelStore.getVatConfig('v9')).toStrictEqual({
      bundleName: 'written-between-cranks',
    });
  });

  it('lets go of a caller waiting on a loop that died instead', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(1);
    const boom = new Error('crank exploded');
    let stopped: Promise<boolean> | undefined;
    const running = kernelQueue.run(async () => {
      stopped ??= kernelQueue.stopRunLoop();
      throw boom;
    });

    await expect(running).rejects.toBe(boom);

    // `Kernel.stop` awaits this before closing the database; waiting for a
    // loop that is never going to read the request hangs the whole shutdown.
    expect(await stopped).toBe(false);
    expect(kernelStore.isInCrank()).toBe(false);
  });

  it('answers every caller that asked it to stop', async () => {
    const { kernelQueue } = await makeFixture(2);
    const asks: Promise<boolean>[] = [];
    const running = kernelQueue.run(async () => {
      if (asks.length === 0) {
        asks.push(kernelQueue.stopRunLoop(), kernelQueue.stopRunLoop());
      }
      return undefined;
    });

    // A second ask used to take the first one's place, leaving that caller
    // waiting for a loop that had already stopped.
    expect(await Promise.all(asks)).toStrictEqual([true, true]);
    await running;
  });

  it('refuses work while it is stopped', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(vi.fn());
    await kernelQueue.stopRunLoop();
    await running;

    // Nothing is draining the queue, so a result promise handed out now could
    // only hang.
    expect(() => kernelQueue.assertRunLoopAlive('queue a message')).toThrow(
      'Kernel run loop is stopped',
    );
  });
});
