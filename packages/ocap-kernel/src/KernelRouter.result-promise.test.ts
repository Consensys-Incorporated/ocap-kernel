import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import { makeKernelError, kser } from './liveslots/kernel-marshal.ts';
import { makeKernelStore } from './store/index.ts';
import type { EndpointHandle, KRef, RunQueueItem } from './types.ts';

/**
 * What happens to a message's result promise when the delivery carrying it
 * fails, against a real store and a real queue.
 *
 * `KernelRouter`'s own tests mock `resolvePromises`, so nothing there can see a
 * second resolution of one promise — which is a `Fail`, and reaches the run
 * loop from inside the very catch meant to contain the delivery's failure.
 */
describe('a result promise whose delivery fails', () => {
  /**
   * A router over a real store, delivering to one endpoint the test supplies.
   *
   * @param deliverMessage - What the endpoint does with a message.
   * @returns The store, queue and a `runCrank` that delivers one queued item.
   */
  async function makeFixture(deliverMessage: () => Promise<never>): Promise<{
    kernelStore: ReturnType<typeof makeKernelStore>;
    kernelQueue: KernelQueue;
    runCrank: () => Promise<void>;
  }> {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kernelStore = makeKernelStore(kdb);
    const kernelQueue = new KernelQueue(kernelStore, async () => undefined);
    const endpoint = {
      deliverMessage: vi.fn(deliverMessage),
      deliverNotify: vi.fn(),
      deliverDropExports: vi.fn(),
      deliverRetireExports: vi.fn(),
      deliverRetireImports: vi.fn(),
      deliverBringOutYourDead: vi.fn(),
    } as unknown as EndpointHandle;
    const kernelRouter = new KernelRouter(
      kernelStore,
      kernelQueue,
      async () => endpoint,
      () => undefined,
      async () => undefined,
    );

    const runCrank = async (): Promise<void> => {
      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      try {
        const item = kernelStore.dequeueRun() as RunQueueItem;
        await kernelRouter.deliver(item);
        kernelStore.collectGarbage();
      } finally {
        kernelStore.endCrank();
      }
    };

    return { kernelStore, kernelQueue, runCrank };
  }

  /**
   * Queue a message to v1's root with a result promise.
   *
   * @param kernelStore - The store to set up.
   * @param kernelQueue - The queue to send through.
   * @returns The result promise's kref.
   */
  function queueSendWithResult(
    kernelStore: ReturnType<typeof makeKernelStore>,
    kernelQueue: KernelQueue,
  ): KRef {
    kernelStore.setVatConfig('v1', { bundleName: 'vat1' });
    kernelStore.initEndpoint('v1');
    const target = kernelStore.exportFromEndpoint('v1', 'o+1');
    const [result] = kernelStore.initKernelPromise();
    kernelQueue.enqueueSend(target, {
      methargs: kser(['ping', []]),
      result,
    });
    return result;
  }

  it('rejects it once the delivery reports failure', async () => {
    const { kernelStore, kernelQueue, runCrank } = await makeFixture(
      async () => {
        throw new Error('stream closed');
      },
    );
    const result = queueSendWithResult(kernelStore, kernelQueue);

    await runCrank();

    expect(kernelStore.getKernelPromise(result).state).toBe('rejected');
  });

  // The vat resolving the result and then losing its stream is one way in; a
  // stream that dies mid-delivery is the other, since retiring the vat rejects
  // every promise it was deciding and this one's decider was just set.
  it('leaves a result the endpoint already settled alone', async () => {
    // Held in an object so the endpoint can reach it before the queue that
    // settles the promise exists.
    const endpointDoes = { settleTheResult: (): void => undefined };
    const { kernelStore, kernelQueue, runCrank } = await makeFixture(
      async () => {
        endpointDoes.settleTheResult();
        throw new Error('stream closed');
      },
    );
    const result = queueSendWithResult(kernelStore, kernelQueue);
    // The endpoint settles the result on its way down, as a vat that resolves
    // and then loses its stream does.
    endpointDoes.settleTheResult = () =>
      kernelQueue.resolvePromises('v1', [
        [result, true, makeKernelError('VAT_TERMINATED', 'worker died')],
      ]);

    expect(await runCrank()).toBeUndefined();

    expect(kernelStore.getKernelPromise(result).state).toBe('rejected');
  });
});
