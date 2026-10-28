import { makePromiseKit } from '@endo/promise-kit';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelServiceManager } from './KernelServiceManager.ts';
import {
  kser,
  kslot,
  makeFatalKernelError,
} from './liveslots/kernel-marshal.ts';
import { makeKernelStore } from './store/index.ts';
import type { CrankResult, KRef, RunLoopItem } from './types.ts';
import { asVatId, asVRef } from '../test/branded.ts';

const STOP_RUN_LOOP = 'test: stop run loop';

describe('pin taken for a kernel subscriber', () => {
  it('holds an object handed to a queueMessage caller when a kernel service answers during a crank that aborts', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const logger = new Logger('test');
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation(() => undefined);
    }
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kernelStore = makeKernelStore(kdb);
    for (const vatId of ['v1', 'v3'].map(asVatId)) {
      kernelStore.setVatConfig(vatId, { sourceSpec: 'test.js' });
      kernelStore.initEndpoint(vatId);
    }
    const doomed = kernelStore.exportFromEndpoint(asVatId('v1'), asVRef('o+1'));
    const gift = kernelStore.exportFromEndpoint(asVatId('v3'), asVRef('o+2'));
    const sentinel = kernelStore.exportFromEndpoint(
      asVatId('v3'),
      asVRef('o+3'),
    );
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

    // The host asks the service for the gift; its answer comes back later.
    const answered = kernelQueue.enqueueMessage(serviceKref, 'get', []);
    kernelQueue.enqueueSend(doomed, {
      methargs: kser(['work', []]),
      result: null,
    });

    let resultKpid: KRef | undefined;
    let abortedOnce = false;
    const deliver = async (
      item: RunLoopItem,
    ): Promise<CrankResult | undefined> => {
      if (item.type === 'send' && item.target === serviceKref) {
        resultKpid = item.message.result as KRef;
        kernelStore.setPromiseDecider(resultKpid, 'kernel');
        serviceManager.invokeKernelService(item.target, item.message);
        return undefined;
      }
      if (item.type === 'send' && item.target === doomed && !abortedOnce) {
        abortedOnce = true;
        // The service's answer arrives while v1's delivery is open.
        giftKit.resolve(kslot(gift));
        await delay(5);
        return {
          didDelivery: asVatId('v1'),
          abort: true,
          terminate: {
            vatId: asVatId('v1'),
            reject: true,
            info: makeFatalKernelError('INTERNAL_ERROR', 'delivery failed'),
          },
        };
      }
      if (item.type === 'send' && item.target === sentinel) {
        throw new Error(STOP_RUN_LOOP);
      }
      return undefined;
    };

    const running = kernelQueue.run(deliver);
    const answer = await answered;
    await kernelQueue.waitForCrank();
    kernelQueue.enqueueSend(sentinel, {
      methargs: kser(['stop', []]),
      result: null,
    });
    await expect(running).rejects.toThrow(STOP_RUN_LOOP);

    expect({
      answeredWith: answer.slots,
      pins: kernelStore.getPinCount(gift),
      resultState: kernelStore.getKernelPromise(resultKpid as KRef).state,
    }).toStrictEqual({
      answeredWith: [gift],
      pins: 1,
      resultState: 'fulfilled',
    });
  });
});
