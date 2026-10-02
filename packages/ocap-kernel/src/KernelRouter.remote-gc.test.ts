import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import { makeKernelStore } from './store/index.ts';
import type { EndpointHandle, RunQueueItem } from './types.ts';
import { makeGCAction } from './types.ts';

const STOP_RUN_LOOP = 'test: stop run loop';

/**
 * That the aborted crank really does give the action back, against a real store
 * — the claim rests on `rollbackCrank` reverting the cached `gcActions` set as
 * well as the database row, which no mocked store can show.
 */
describe('a GC action a remote refused', () => {
  it('is still there after the crank that could not deliver it', async () => {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kernelStore = makeKernelStore(kdb);

    kernelStore.initEndpoint('v1');
    kernelStore.initEndpoint('r1');
    const kref = kernelStore.initKernelObject('v1');
    kernelStore.addCListEntry('r1', kref, 'ro-1');
    const action = makeGCAction('r1', 'retireImport', kref);
    kernelStore.addGCActions([action]);
    // Ordinary work for the crank after the refusal, so the loop reaches a
    // second crank rather than parking, and something stops it there.
    kernelStore.enqueueRun({
      type: 'send',
      target: kref,
      message: { methargs: { body: '', slots: [] }, result: null },
    } as unknown as RunQueueItem);

    const kernelQueue = new KernelQueue(kernelStore, async () => undefined);
    const endpoint = {
      deliverRetireImports: vi
        .fn()
        .mockRejectedValue(new Error('send queue full')),
    } as unknown as EndpointHandle;
    const kernelRouter = new KernelRouter({
      kernelStore,
      kernelQueue,
      getEndpoint: () => endpoint,
      invokeKernelService: () => undefined,
      restartVat: async () => undefined,
      terminateVat: async () => undefined,
    });

    // GC actions come before the run queue, so the first crank is the refusal
    // and the second is the send, which stops the loop.
    await expect(
      kernelQueue.run(async (item: RunQueueItem) => {
        if (item.type === 'send') {
          throw new Error(STOP_RUN_LOOP);
        }
        return kernelRouter.deliver(item);
      }),
    ).rejects.toThrow(STOP_RUN_LOOP);

    expect(endpoint.deliverRetireImports).toHaveBeenCalledOnce();
    expect([...kernelStore.getGCActions()]).toStrictEqual([action]);
    // The kernel's half is back too, so the peer and the kernel still agree.
    expect(kernelStore.hasCListEntry('r1', kref)).toBe(true);
  });
});
