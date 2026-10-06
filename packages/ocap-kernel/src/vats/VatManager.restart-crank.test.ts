import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from '../KernelQueue.ts';
import { kser } from '../liveslots/kernel-marshal.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  CrankResult,
  PlatformServices,
  RunQueueItem,
  VatConfig,
} from '../types.ts';
import { VatHandle } from './VatHandle.ts';
import { VatManager } from './VatManager.ts';

const STOP_RUN_LOOP = 'test: stop run loop';

type BufferArgs = {
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
  target: string;
  kpid: string;
};

/**
 * A real store and run loop, with `v1` running under a mocked worker and `v2`
 * persisted beside it.
 *
 * @param makeNewWorker - What the restart's `VatHandle.make` does.
 * @param vatRelaunchTimeoutMs - How long the restart waits for it.
 * @returns The pieces a test drives.
 */
async function setUp(
  makeNewWorker: (args: BufferArgs) => Promise<VatHandle>,
  vatRelaunchTimeoutMs?: number,
) {
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
      end: vi.fn().mockResolvedValue(undefined),
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
    vatRelaunchTimeoutMs,
  });
  kernel.vatManager = vatManager;
  vi.spyOn(VatHandle, 'make')
    .mockResolvedValueOnce({
      vatId: 'v1',
      config,
      terminate: vi.fn().mockResolvedValue(undefined),
    } as unknown as VatHandle)
    .mockImplementationOnce(async () =>
      makeNewWorker({ kernelStore, kernelQueue, target, kpid }),
    );
  await vatManager.runVat('v1', config);
  return { kernelStore, kernelQueue, vatManager, platformServices, target };
}

/**
 * `VatManager`'s own tests mock the store and the run loop, so nothing there
 * can see what a restart's crank commits. These run the real run loop against
 * a real store.
 */
describe('a restart whose relaunch fails', () => {
  it.each([
    {
      what: 'a send',
      buffer: ({ kernelQueue, target }: BufferArgs): void =>
        kernelQueue.enqueueSend(
          target,
          { methargs: kser(['hello', []]), result: null },
          false,
        ),
    },
    {
      what: 'a notify to the restarting vat',
      buffer: ({ kernelQueue, kpid }: BufferArgs): void =>
        kernelQueue.enqueueNotify('v1', kpid, false),
    },
  ])('discards $what its failed initVat buffered', async ({ buffer }) => {
    const { kernelStore, kernelQueue, vatManager, platformServices } =
      await setUp(async (args) => {
        // What the new worker's `initVat` syscalls leave in the crank buffer
        // before the handshake fails.
        buffer(args);
        throw new Error('handshake timed out');
      });

    const restarting = vatManager.restartVat('v1');
    const delivered: RunQueueItem['type'][] = [];
    let restored: CrankResult | undefined;
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
      restored = await vatManager.performVatRestart('v1');
      throw new Error(STOP_RUN_LOOP);
    };

    await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
    await expect(restarting).rejects.toThrow('handshake timed out');

    // The rollback put the request back, where it finds no waiters and is
    // dropped; a committed buffer would have queued its item instead.
    expect(delivered).toStrictEqual(['restartVat', 'restartVat']);
    expect(restored).toBeUndefined();
    expect(platformServices.launch).toHaveBeenCalledTimes(2);
    expect(kernelStore.getTerminatedVats()).toStrictEqual(['v1']);
  });
});

describe('a restart whose crank fails after the relaunch', () => {
  it('rejects its caller rather than handing it the new vat', async () => {
    const newWorker = {
      vatId: 'v1',
      terminate: vi.fn().mockResolvedValue(undefined),
    } as unknown as VatHandle;
    const { kernelQueue, vatManager } = await setUp(
      async ({ kernelStore, target }) => {
        // A reference count no one holds, for the crank's audit to find.
        kernelStore.incrementRefCount(target, 'test');
        return newWorker;
      },
    );

    const restarting = vatManager.restartVat('v1');
    const running = kernelQueue.run(async () =>
      vatManager.performVatRestart('v1'),
    );

    await expect(running).rejects.toThrow('reference count invariant violated');
    await expect(restarting).rejects.toThrow('Kernel run loop died');
  });
});

describe('a restart whose new worker never answers', () => {
  it('terminates the vat and goes on to the next item', async () => {
    const { kernelStore, kernelQueue, vatManager, target } = await setUp(
      async () => new Promise<VatHandle>(() => undefined),
      1,
    );
    const restarting = vatManager.restartVat('v1');
    restarting.catch(() => undefined);
    kernelQueue.enqueueSend(target, {
      methargs: kser(['hello', []]),
      result: null,
    });

    const delivered: RunQueueItem['type'][] = [];
    const running = kernelQueue.run(async (item) => {
      delivered.push(item.type);
      if (item.type === 'restartVat') {
        return vatManager.performVatRestart('v1');
      }
      throw new Error(STOP_RUN_LOOP);
    });

    await expect(running).rejects.toThrow(STOP_RUN_LOOP);
    await expect(restarting).rejects.toThrow(
      'Vat v1 was terminated after its restart failed: Vat v1 did not start within 1 ms',
    );
    expect(delivered).toStrictEqual(['restartVat', 'restartVat', 'send']);
    expect(kernelStore.isVatActive('v1')).toBe(false);
    expect(vatManager.hasVat('v1')).toBe(false);
  });
});
