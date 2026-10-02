import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from '../KernelQueue.ts';
import { kser } from '../liveslots/kernel-marshal.ts';
import { makeKernelStore } from '../store/index.ts';
import type {
  CrankResult,
  PlatformServices,
  RunQueueItem,
  VatConfig,
} from '../types.ts';
import { VatHandle } from './VatHandle.ts';
import { VatManager } from './VatManager.ts';

const STOP_RUN_LOOP = 'test: stop run loop';

/**
 * `VatManager`'s own tests mock the store and the run loop, so nothing there
 * can see what a failed restart's crank commits. These run the real run loop
 * against a real store.
 */
describe('a restart whose relaunch fails', () => {
  it.each([
    {
      what: 'a send',
      buffer: (kernelQueue: KernelQueue, target: string): void =>
        kernelQueue.enqueueSend(
          target,
          { methargs: kser(['hello', []]), result: null },
          false,
        ),
    },
    {
      what: 'a notify to the restarting vat',
      buffer: (kernelQueue: KernelQueue, _target: string, kpid: string): void =>
        kernelQueue.enqueueNotify('v1', kpid, false),
    },
  ])('discards $what its failed initVat buffered', async ({ buffer }) => {
    const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
    const kernelStore = makeKernelStore(kdb);
    kernelStore.setRefCountAuditing(true);
    const config: VatConfig = { sourceSpec: 'test.js' };
    for (const vatId of ['v1', 'v2']) {
      kernelStore.setVatConfig(vatId, config);
      kernelStore.initEndpoint(vatId);
    }
    const target = kernelStore.exportFromEndpoint('v2', 'o+1');
    const [kpid] = kernelStore.initKernelPromise();

    // The `terminateVat` `Kernel` passes, held in an object so the queue can
    // reach a manager that needs the queue to exist first.
    const kernel: { vatManager?: VatManager } = {};
    const kernelQueue = new KernelQueue(kernelStore, async (vatId, reason) =>
      kernel.vatManager?.stopVat(vatId, true, reason),
    );
    const platformServices = {
      launch: vi.fn().mockResolvedValue({
        end: vi.fn(),
      } as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>),
      terminate: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformServices;
    const logger = new Logger('test');
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const vatManager = new VatManager({
      platformServices,
      kernelStore,
      kernelQueue,
      logger,
    });
    kernel.vatManager = vatManager;
    vi.spyOn(VatHandle, 'make')
      .mockResolvedValueOnce({
        vatId: 'v1',
        config,
        terminate: vi.fn(),
      } as unknown as VatHandle)
      .mockImplementationOnce(async () => {
        // What the new worker's `initVat` syscalls leave in the crank buffer
        // before the handshake fails.
        buffer(kernelQueue, target, kpid);
        throw new Error('handshake timed out');
      });
    await vatManager.runVat('v1', config);

    const restarting = vatManager.restartVat('v1');
    const delivered: RunQueueItem['type'][] = [];
    const deliver = async (
      item: RunQueueItem,
    ): Promise<CrankResult | undefined> => {
      delivered.push(item.type);
      if (delivered.length === 1) {
        return vatManager.performVatRestart('v1');
      }
      // The next crank shows what the first committed. The caller is answered
      // once that first crank ends, so let it be before stopping the loop.
      await restarting.catch(() => undefined);
      throw new Error(STOP_RUN_LOOP);
    };

    await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
    await expect(restarting).rejects.toThrow('handshake timed out');

    // The rollback put the request back, where it finds no waiters and is
    // dropped; a committed buffer would have queued its item instead.
    expect(delivered).toStrictEqual(['restartVat', 'restartVat']);
    expect(kernelStore.getTerminatedVats()).toStrictEqual(['v1']);
  });
});
