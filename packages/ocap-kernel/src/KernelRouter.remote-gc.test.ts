import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import { makeKernelStore } from './store/index.ts';
import type { EndpointHandle, KernelMessage, RunQueueItem } from './types.ts';
import { isRemoteId, makeGCAction } from './types.ts';

const STOP_RUN_LOOP = 'test: stop run loop';

const message: KernelMessage = {
  methargs: { body: '', slots: [] },
  result: null,
};

describe('a GC action for a remote that is offline', () => {
  it('waits while other work runs, and goes out once the remote is back', async () => {
    const kernelStore = makeKernelStore(
      await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
    );
    kernelStore.initEndpoint('v1');
    kernelStore.initEndpoint('r1');
    const kref = kernelStore.initKernelObject('v1');
    kernelStore.addCListEntry('r1', kref, 'ro-1');
    kernelStore.addGCActions([makeGCAction('r1', 'retireImport', kref)]);

    let online = false;
    const remote = {
      deliverRetireImports: vi.fn().mockResolvedValue({ didDelivery: 'r1' }),
    } as unknown as EndpointHandle;
    const kernelQueue = new KernelQueue(kernelStore, async () => undefined);
    const kernelRouter = new KernelRouter({
      kernelStore,
      kernelQueue,
      getEndpoint: (endpointId) => {
        if (!online) {
          throw new Error(`Remote not found: ${endpointId}`);
        }
        return remote;
      },
      invokeKernelService: () => undefined,
      restartVat: async () => undefined,
      terminateVat: async () => undefined,
    });

    let sends = 0;
    const running = kernelQueue.run(
      async (item: RunQueueItem) => {
        if (item.type !== 'send') {
          return kernelRouter.deliver(item);
        }
        sends += 1;
        if (sends === 2) {
          throw new Error(STOP_RUN_LOOP);
        }
        return undefined;
      },
      { isOffline: (endpointId) => isRemoteId(endpointId) && !online },
    );
    kernelQueue.enqueueSend(kref, message);
    await waitUntilQuiescent();

    expect(sends).toBe(1);
    expect(remote.deliverRetireImports).not.toHaveBeenCalled();
    expect([...kernelStore.getGCActions()]).toStrictEqual([
      makeGCAction('r1', 'retireImport', kref),
    ]);
    expect(kernelStore.hasCListEntry('r1', kref)).toBe(true);

    online = true;
    kernelQueue.recheckGCActions();
    await waitUntilQuiescent();

    expect(remote.deliverRetireImports).toHaveBeenCalledWith(['ro-1']);
    expect([...kernelStore.getGCActions()]).toStrictEqual([]);
    expect(kernelStore.hasCListEntry('r1', kref)).toBe(false);

    kernelQueue.enqueueSend(kref, message);
    await expect(running).rejects.toThrow(STOP_RUN_LOOP);
  });
});
