import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { kser } from './liveslots/kernel-marshal.ts';
import { makeKernelStore } from './store/index.ts';
import type { CrankResult, KernelMessage, RunQueueItem } from './types.ts';

const STOP_RUN_LOOP = 'test: stop run loop';

/**
 * What survives a crank that dies, against a real store rather than a mocked
 * one — the mocked store can report which savepoint was rolled back but not
 * what the rollback did.
 */
describe('a crank that dies after recording a vat death', () => {
  /**
   * Run one crank that delivers `crankResult`, then kills the run loop from
   * `collectGarbage`, which is past the point where the rollback is decided.
   *
   * @param crankResult - What the delivery reports.
   * @returns The store the crank ran against.
   */
  async function runOneDoomedCrank(
    crankResult: CrankResult,
  ): Promise<ReturnType<typeof makeKernelStore>> {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const real = makeKernelStore(kdb);
    // Spread rather than spied: `makeKernelStore` hardens what it returns.
    const kernelStore = {
      ...real,
      collectGarbage: () => {
        throw new Error(STOP_RUN_LOOP);
      },
    };
    const kernelQueue = new KernelQueue(kernelStore, async (vatId) => {
      kernelStore.markVatAsTerminated(vatId);
    });
    const item: RunQueueItem = {
      type: 'send',
      target: 'ko1',
      message: { methargs: { body: '', slots: [] }, result: null },
    } as unknown as RunQueueItem;
    kernelStore.enqueueRun(item);

    await expect(
      kernelQueue.run(vi.fn().mockResolvedValue(crankResult)),
    ).rejects.toThrow(STOP_RUN_LOOP);

    return kernelStore as unknown as ReturnType<typeof makeKernelStore>;
  }

  it('leaves the vat dead after a graceful exit', async () => {
    const kernelStore = await runOneDoomedCrank({
      terminate: { vatId: 'v1', info: {} as KernelMessage['methargs'] },
    } as unknown as CrankResult);

    expect(kernelStore.getTerminatedVats()).toStrictEqual(['v1']);
  });

  it('leaves the vat dead after an aborted delivery', async () => {
    const kernelStore = await runOneDoomedCrank({
      abort: true,
      terminate: { vatId: 'v1', info: {} as KernelMessage['methargs'] },
    } as unknown as CrankResult);

    expect(kernelStore.getTerminatedVats()).toStrictEqual(['v1']);
  });
});

/**
 * The audit runs while the crank can still be rolled back, which means it runs
 * before the flush moves buffered items onto the run queue.
 */
describe('the reference count audit inside a crank', () => {
  it('accepts a delivery that buffered a send', async () => {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kernelStore = makeKernelStore(kdb);
    kernelStore.setRefCountAuditing(true);
    const kernelQueue = new KernelQueue(kernelStore, async () => undefined);
    kernelStore.setVatConfig('v1', { bundleName: 'vat1' });
    kernelStore.initEndpoint('v1');
    const target = kernelStore.exportFromEndpoint('v1', 'o+1');
    kernelQueue.enqueueSend(target, {
      methargs: kser(['ping', []]),
      result: null,
    });

    let delivered = 0;
    const deliver = async (item: RunQueueItem): Promise<undefined> => {
      // What `KernelRouter.#deliverSend` does with the queue entry's charge.
      kernelStore.decrementRefCount(
        (item as { target: string }).target,
        'deliver|send|target',
      );
      delivered += 1;
      if (delivered === 1) {
        // What a vat's `syscall.send` does mid-crank.
        kernelQueue.enqueueSend(
          target,
          { methargs: kser(['pong', []]), result: null },
          false,
        );
        return undefined;
      }
      throw new Error(STOP_RUN_LOOP);
    };

    // An uncredited crank buffer makes the first crank's audit report the
    // buffered send as a leak, so the second delivery is never reached.
    await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

    expect(delivered).toBe(2);
  });
});
