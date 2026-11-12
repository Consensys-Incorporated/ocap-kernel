import { makePromiseKit } from '@endo/promise-kit';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import { KernelServiceManager } from './KernelServiceManager.ts';
import {
  kser,
  kslot,
  makeFatalKernelError,
} from './liveslots/kernel-marshal.ts';
import { makeKernelStore } from './store/index.ts';
import type { CrankResult, EndpointHandle, KRef } from './types.ts';
import { asVatId, asVRef } from '../test/branded.ts';

describe('hold on a result a kernel service answers during an aborted crank', () => {
  it('holds an object handed to a queueMessage caller when a kernel service answers during a crank that aborts', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const logger = new Logger('test');
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation(() => undefined);
    }
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kernelStore = makeKernelStore(kdb);
    kernelStore.setRefCountAuditing(true);
    const v1 = asVatId('v1');
    const v3 = asVatId('v3');
    for (const vatId of [v1, v3]) {
      kernelStore.setVatConfig(vatId, { sourceSpec: 'test.js' });
      kernelStore.initEndpoint(vatId);
    }
    const doomed = kernelStore.exportFromEndpoint(v1, asVRef('o+1'));
    kernelStore.pinObject(doomed);
    const gift = kernelStore.exportFromEndpoint(v3, asVRef('o+2'));
    const kernelQueue = new KernelQueue(kernelStore, async (vatId) =>
      kernelStore.markVatAsTerminated(vatId),
    );
    const serviceManager = new KernelServiceManager({
      kernelStore,
      kernelQueue,
      logger,
    });
    const giftKit = makePromiseKit<unknown>();
    const { kref: serviceKref } = serviceManager.registerKernelServiceObject(
      'svc',
      { get: async () => giftKit.promise },
    );

    let abortedOnce = false;
    const v1Endpoint = {
      deliverMessage: vi.fn(async (): Promise<CrankResult> => {
        if (abortedOnce) {
          return { didDelivery: v1 };
        }
        abortedOnce = true;
        // The service's answer arrives while v1's delivery is open.
        giftKit.resolve(kslot(gift));
        await delay(5);
        return {
          didDelivery: v1,
          abort: true,
          terminate: {
            vatId: v1,
            reject: true,
            info: makeFatalKernelError('INTERNAL_ERROR', 'delivery failed'),
          },
        };
      }),
      deliverNotify: vi.fn().mockResolvedValue({}),
      deliverDropExports: vi.fn().mockResolvedValue({}),
      deliverRetireExports: vi.fn().mockResolvedValue({}),
      deliverRetireImports: vi.fn().mockResolvedValue({}),
      deliverBringOutYourDead: vi.fn().mockResolvedValue({}),
    } as unknown as EndpointHandle;
    const quietEndpoint = {
      ...v1Endpoint,
      deliverMessage: vi.fn().mockResolvedValue({}),
    } as unknown as EndpointHandle;
    const kernelRouter = new KernelRouter({
      kernelStore,
      kernelQueue,
      getEndpoint: (endpointId) =>
        endpointId === v1 ? v1Endpoint : quietEndpoint,
      invokeKernelService: (target, message) =>
        serviceManager.invokeKernelService(target, message),
      restartVat: async () => undefined,
      terminateVat: async () => undefined,
      applyIncarnationChange: () => ({}),
      performControl: async () => undefined,
      logger: { error: vi.fn(), log: vi.fn() } as unknown as Logger,
    });

    // The host asks the service for the gift; its answer comes back later.
    const answered = kernelQueue.enqueueMessage(serviceKref, 'get', []);
    kernelQueue.enqueueSend(doomed, {
      methargs: kser(['work', []]),
      result: null,
    });
    const running = kernelQueue.run(kernelRouter.deliver.bind(kernelRouter));
    running.catch(() => undefined);

    const answer = await answered;
    await kernelQueue.waitForCrank();
    const kpid = answer.kpid as KRef;

    // The caller holds `gift`, named by `answer.kpid`; the store must agree
    // that the promise it was told to release is held and keeps `gift` alive.
    const observed = {
      answer,
      runLoop: kernelQueue.getRunLoopStatus?.(),
      held: kernelStore.getHeldResults(),
      resultState: kpid ? kernelStore.getKernelPromise(kpid).state : undefined,
      giftExists: kernelStore.kernelRefExists(gift),
      giftDroppedByExporter: (
        quietEndpoint.deliverDropExports as unknown as {
          mock: { calls: unknown[] };
        }
      ).mock.calls,
      giftReachable: kernelStore.kernelRefExists(gift)
        ? kernelStore.getObjectRefCount(gift).reachable
        : 0,
      audit: kernelStore.auditRefCounts(),
    };
    console.log('observed after abort', JSON.stringify(observed));
    expect.soft(observed).toStrictEqual({
      answer: { ...kser(kslot(gift)), kpid },
      runLoop: observed.runLoop,
      held: [kpid],
      resultState: 'fulfilled',
      giftExists: true,
      giftDroppedByExporter: [],
      giftReachable: 1,
      audit: [],
    });

    // Releasing what the caller was handed frees the promise.
    await kernelQueue.releaseResult(kpid);
    await kernelQueue.waitForCrank();
    expect({
      held: kernelStore.getHeldResults(),
      kpidState: kernelStore.kernelRefExists(kpid)
        ? kernelStore.getKernelPromise(kpid).state
        : 'deleted',
      gcActions: kernelStore.getGCActions(),
      audit: kernelStore.auditRefCounts(),
    }).toStrictEqual({
      held: [],
      kpidState: 'deleted',
      gcActions: new Set(),
      audit: [],
    });
    await kernelQueue.endRunLoop();
    await running;
  });
});
