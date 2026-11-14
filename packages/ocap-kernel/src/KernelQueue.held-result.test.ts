import type { CapData } from '@endo/marshal';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import type { Logger } from '@metamask/logger';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import { kser, kslot } from './liveslots/kernel-marshal.ts';
import { makeKernelStore } from './store/index.ts';
import type { EndpointHandle, KRef } from './types.ts';
import { asVatId, asVRef } from '../test/branded.ts';

type Answer = { rejected: boolean; value: (gift: KRef) => CapData<KRef> };

const DATA: Answer = { rejected: false, value: () => kser('pong') };
const OBJECT: Answer = { rejected: false, value: (gift) => kser(kslot(gift)) };
const REJECTION_WITH_OBJECT: Answer = {
  rejected: true,
  value: (gift) => kser(kslot(gift)),
};

/**
 * A real store, queue, router and run loop, over a vat `v1` that answers every
 * message as the test says. `gift` is an object `v1` exports and nothing else
 * refers to.
 *
 * @param answer - How `v1` resolves each message's result.
 * @returns The pieces a test drives. `start` starts the run loop.
 */
async function setUp(answer: Answer) {
  const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernelStore = makeKernelStore(kdb);
  kernelStore.setRefCountAuditing(true);
  const v1 = asVatId('v1');
  kernelStore.setVatConfig(v1, { bundleName: 'vat1' });
  kernelStore.initEndpoint(v1);
  const root = kernelStore.exportFromEndpoint(v1, asVRef('o+0'));
  kernelStore.pinObject(root);
  const gift = kernelStore.exportFromEndpoint(v1, asVRef('o+1'));

  const kernelQueue = new KernelQueue(kernelStore, async () => undefined);
  const endpoint = {
    deliverMessage: vi.fn(async (_target, message) => {
      const kpid = kernelStore.erefToKref(v1, message.result) as KRef;
      kernelQueue.resolvePromises(
        v1,
        [[kpid, answer.rejected, answer.value(gift)]],
        false,
      );
      return {};
    }),
    deliverNotify: vi.fn().mockResolvedValue({}),
    deliverDropExports: vi.fn().mockResolvedValue({}),
    deliverRetireExports: vi.fn().mockResolvedValue({}),
    deliverRetireImports: vi.fn().mockResolvedValue({}),
    deliverBringOutYourDead: vi.fn().mockResolvedValue({}),
  } as unknown as EndpointHandle;
  const kernelRouter = new KernelRouter({
    kernelStore,
    kernelQueue,
    getEndpoint: () => endpoint,
    invokeKernelService: () => undefined,
    restartVat: async () => undefined,
    terminateVat: async () => undefined,
    applyIncarnationChange: () => ({}),
    performControl: async () => undefined,
    logger: { error: vi.fn(), log: vi.fn() } as unknown as Logger,
  });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  let running: Promise<void> | undefined;
  const start = (): void => {
    running = kernelQueue.run(kernelRouter.deliver.bind(kernelRouter));
  };
  const stop = async (): Promise<void> => {
    await kernelQueue.endRunLoop();
    await running;
  };

  return { kernelStore, kernelQueue, root, gift, start, stop, v1 };
}

describe('the hold on a queueMessage result', () => {
  it('is taken when the message is written', async () => {
    const { kernelStore, kernelQueue, root, start, stop } = await setUp(DATA);

    const answer = kernelQueue.enqueueMessage(root, 'ping', []);

    const [kpid] = kernelStore.getHeldResults();
    // The decision it is owed, the queued message, and the hold.
    expect(kernelStore.getRefCount(kpid as KRef)).toBe(3);
    expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    start();
    await answer;
    await stop();
  });

  it('is released at resolution when the answer carries no slots', async () => {
    const { kernelStore, kernelQueue, root, start, stop } = await setUp(DATA);
    start();

    const result = await kernelQueue.enqueueMessage(root, 'ping', []);

    expect(result).toStrictEqual(kser('pong'));
    expect(kernelStore.getHeldResults()).toStrictEqual([]);
    await stop();
  });

  it('is released at resolution when the answer is a rejection', async () => {
    const { kernelStore, kernelQueue, root, gift, start, stop } = await setUp(
      REJECTION_WITH_OBJECT,
    );
    start();

    await expect(
      kernelQueue.enqueueMessage(root, 'ping', []),
    ).rejects.toStrictEqual(kser(kslot(gift)));

    expect(kernelStore.getHeldResults()).toStrictEqual([]);
    await stop();
  });

  it('is kept, and named in the answer, when the answer carries slots', async () => {
    const { kernelStore, kernelQueue, root, gift, start, stop } =
      await setUp(OBJECT);
    start();

    const result = await kernelQueue.enqueueMessage(root, 'fetch', []);

    const [kpid] = kernelStore.getHeldResults();
    expect(result).toStrictEqual({ ...kser(kslot(gift)), kpid });
    expect(kernelStore.getKernelPromise(kpid as KRef).state).toBe('fulfilled');
    await stop();
  });

  it('keeps the krefs in the answer alive until it is released', async () => {
    const { kernelStore, kernelQueue, root, gift, start, stop, v1 } =
      await setUp(OBJECT);
    start();
    const result = await kernelQueue.enqueueMessage(root, 'fetch', []);
    const kpid = result.kpid as KRef;
    // The kernel does not yet retire the vat's entry for a settled promise
    // (#1229), which would keep the promise whether or not it is held.
    await kernelQueue.writeOutsideCrank(() => kernelStore.forgetKref(v1, kpid));
    await kernelQueue.enqueueMessage(root, 'fetch', []);
    expect(kernelStore.getObjectRefCount(gift).reachable).toBe(2);

    await kernelQueue.releaseResult(kpid);

    expect(kernelStore.kernelRefExists(kpid)).toBe(false);
    expect(kernelStore.getObjectRefCount(gift).reachable).toBe(1);
    expect(kernelStore.auditRefCounts()).toStrictEqual([]);
    await stop();
  });

  it('cannot be released twice', async () => {
    const { kernelQueue, root, start, stop } = await setUp(OBJECT);
    start();
    const { kpid } = await kernelQueue.enqueueMessage(root, 'fetch', []);
    await kernelQueue.releaseResult(kpid as KRef);

    await expect(kernelQueue.releaseResult(kpid as KRef)).rejects.toThrow(
      'is not a held result',
    );
    await stop();
  });

  it('is released for every result when a kernel starts', async () => {
    const { kernelStore, kernelQueue, root, start, stop } = await setUp(OBJECT);
    start();
    await kernelQueue.enqueueMessage(root, 'fetch', []);
    await kernelQueue.enqueueMessage(root, 'fetch', []);
    await stop();
    const nextKernelQueue = new KernelQueue(kernelStore, async () => undefined);

    expect(nextKernelQueue.releaseAbandonedResults()).toBe(2);

    expect(kernelStore.getHeldResults()).toStrictEqual([]);
    expect(kernelStore.auditRefCounts()).toStrictEqual([]);
  });
});
