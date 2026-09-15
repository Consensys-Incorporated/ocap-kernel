import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import { kser } from './liveslots/kernel-marshal.ts';
import { makeKernelStore } from './store/index.ts';
import type { EndpointHandle, KRef, RunQueueItem } from './types.ts';

/**
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
      () => endpoint,
      () => undefined,
    );

    // The run loop's crank, minus the run loop.
    const runCrank = async (): Promise<void> => {
      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('start');
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

  // A vat that resolves the result and then loses its stream is one way in; a
  // stream that dies mid-delivery is the other, since retiring the vat rejects
  // every promise it was deciding and this one's decider was just set.
  it.each([
    { how: 'fulfilled', rejected: false, state: 'fulfilled' },
    { how: 'rejected', rejected: true, state: 'rejected' },
  ])(
    'leaves a result the endpoint already $how alone',
    async ({ rejected, state }) => {
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
      endpointDoes.settleTheResult = () =>
        kernelQueue.resolvePromises('v1', [
          [result, rejected, kser('settled by the endpoint')],
        ]);

      expect(await runCrank()).toBeUndefined();

      const settled = kernelStore.getKernelPromise(result);
      expect(settled.state).toBe(state);
      // The endpoint's own settlement, not the delivery's `DELIVERY_FAILED`.
      expect(settled.value?.body).toContain('settled by the endpoint');
    },
  );
});
