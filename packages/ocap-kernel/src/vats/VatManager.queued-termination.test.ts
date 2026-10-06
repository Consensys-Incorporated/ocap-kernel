import { makePromiseKit } from '@endo/promise-kit';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from '../KernelQueue.ts';
import { kser } from '../liveslots/kernel-marshal.ts';
import { makeKernelStore } from '../store/index.ts';
import type {
  CrankResult,
  KRef,
  PlatformServices,
  RunQueueItem,
  VatConfig,
  VatId,
} from '../types.ts';
import { VatHandle } from './VatHandle.ts';
import { VatManager } from './VatManager.ts';

type KernelDatabase = Awaited<ReturnType<typeof makeSQLKernelDatabase>>;

const config: VatConfig = { sourceSpec: 'test.js' };

/**
 * A real store, run loop and vat manager, with vat workers mocked out. The run
 * loop routes queued terminations to the vat manager, as `KernelRouter` does,
 * and holds a send to `gate` open until the test calls `openGate`.
 *
 * @param options - Options.
 * @param options.kdb - The database, to reuse one across a kernel restart.
 * @param options.vatIds - The vats to launch.
 * @param options.terminateWorker - The platform's worker teardown.
 * @returns The pieces the tests drive.
 */
async function setUp({
  kdb,
  vatIds = ['v1'],
  terminateWorker = async () => undefined,
}: {
  kdb?: KernelDatabase;
  vatIds?: VatId[];
  terminateWorker?: (vatId: VatId) => Promise<void>;
} = {}) {
  const database =
    kdb ?? (await makeSQLKernelDatabase({ dbFilename: ':memory:' }));
  const kernelStore = makeKernelStore(database);
  const kernelQueue = new KernelQueue(kernelStore, async (vatId) =>
    kernelStore.markVatAsTerminated(vatId),
  );
  const logger = new Logger('test');
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined);
  }
  vi.spyOn(logger, 'subLogger').mockReturnValue(logger);
  const platformServices = {
    launch: vi.fn().mockResolvedValue({
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>),
    terminate: vi.fn(terminateWorker),
  } as unknown as PlatformServices;
  vi.spyOn(VatHandle, 'make').mockImplementation(
    async ({ vatId }) =>
      ({
        vatId,
        config,
        terminate: vi.fn().mockResolvedValue(undefined),
      }) as unknown as VatHandle,
  );
  const vatManager = new VatManager({
    platformServices,
    kernelStore,
    kernelQueue,
    logger,
  });

  /**
   * Launch a vat as a kernel would, records and all.
   *
   * @param vatId - The vat.
   */
  const launch = async (vatId: VatId): Promise<void> => {
    kernelStore.setVatConfig(vatId, config);
    kernelStore.initEndpoint(vatId);
    await vatManager.runVat(vatId, config);
  };
  for (const vatId of vatIds) {
    await launch(vatId);
  }

  const gateOwner = 'v99';
  kernelStore.initEndpoint(gateOwner);
  const gate: KRef = kernelStore.exportFromEndpoint(gateOwner, 'o+1');
  const gateKit = makePromiseKit<void>();
  const crankOpen = makePromiseKit<void>();
  const delivered: RunQueueItem[] = [];
  const deliver = async (
    item: RunQueueItem,
  ): Promise<CrankResult | undefined> => {
    delivered.push(item);
    if (item.type === 'terminateVat') {
      return vatManager.performVatTermination(item.vatId, item.reason);
    }
    if (item.type === 'send' && item.target === gate) {
      crankOpen.resolve();
      await gateKit.promise;
    }
    return undefined;
  };

  return {
    kdb: database,
    kernelStore,
    kernelQueue,
    vatManager,
    launch,
    delivered,
    /** Start the run loop, logging rather than surfacing its death. */
    run: () => {
      kernelQueue.run(deliver).catch(() => undefined);
    },
    /** Queue a send whose crank stays open, and wait until it is. */
    openACrank: async () => {
      kernelQueue.enqueueSend(gate, {
        methargs: kser(['hold', []]),
        result: null,
      });
      await crankOpen.promise;
    },
    openGate: () => gateKit.resolve(),
  };
}

/**
 * Let the run loop drain whatever is queued.
 */
async function settle(): Promise<void> {
  await delay(20);
}

describe('VatManager queued termination', () => {
  describe('bugs', () => {
    it('does not carry out a termination that reset abandoned', async () => {
      const harness = await setUp();
      const { kernelStore, vatManager } = harness;
      harness.run();
      await harness.openACrank();

      // An outside caller asks while a crank is open, so the request is held
      // in KernelQueue's memory until that crank ends.
      const termination = vatManager.terminateVat('v1');
      termination.catch(() => undefined);

      // `Kernel.reset`, after its `waitForCrank`, which can resume inside this
      // very crank: tear the vats down, wipe the store, abandon queued work.
      await vatManager.stopVat('v1', true);
      kernelStore.reset();
      vatManager.abandonQueuedWork(
        new Error('Kernel was reset; queued work was abandoned'),
      );
      await expect(termination).rejects.toThrow('Kernel was reset');

      // A vat launched into the fresh kernel gets the first id again.
      const vatId = kernelStore.getNextVatId();
      expect(vatId).toBe('v1');
      await harness.launch(vatId);

      harness.openGate();
      await settle();

      // The abandoned request was still written into the fresh store when the
      // crank ended, and the run loop then killed the new vat with it.
      expect({
        newVatActive: kernelStore.isVatActive('v1'),
        terminationsDelivered: harness.delivered.filter(
          (item) => item.type === 'terminateVat',
        ),
      }).toStrictEqual({ newVatActive: true, terminationsDelivered: [] });
    });

    it('terminates every vat even when a queued termination retires one first', async () => {
      const workerStopping = makePromiseKit<void>();
      const releaseWorker = makePromiseKit<void>();
      const harness = await setUp({
        vatIds: ['v1', 'v2'],
        // `terminateAllVats` goes newest first, so it is stopping v2 when the
        // queued termination of v1 runs.
        terminateWorker: async (vatId) => {
          if (vatId === 'v2') {
            workerStopping.resolve();
            await releaseWorker.promise;
          }
        },
      });
      const { kernelStore, vatManager } = harness;
      harness.run();

      // `Kernel.reset` starts tearing the vats down...
      const terminatingAll = vatManager.terminateAllVats();
      await workerStopping.promise;
      // ...and an outside caller's termination runs on the loop meanwhile.
      await vatManager.terminateVat('v1');

      releaseWorker.resolve();

      // Rejects with VatNotFoundError for v1, so `reset` stops before it
      // clears the kernel's state.
      expect(await terminatingAll).toBeUndefined();
      expect([
        kernelStore.isVatActive('v1'),
        kernelStore.isVatActive('v2'),
      ]).toStrictEqual([false, false]);
    });
  });

  describe('test gaps', () => {
    it('carries out a termination abandoned by stop on the next start', async () => {
      const first = await setUp();
      // Queued, but the run loop never got to it before the kernel stopped.
      const termination = first.vatManager.terminateVat('v1');
      termination.catch(() => undefined);
      first.vatManager.abandonQueuedWork(
        new Error(
          'Kernel was stopped before answering; queued terminations still take effect on its next start, restarts do not',
        ),
      );
      await expect(termination).rejects.toThrow('Kernel was stopped');
      expect(first.kernelStore.isVatActive('v1')).toBe(true);

      // The next start: a new kernel over the same database relaunches its
      // persisted vats and starts its run loop.
      const second = await setUp({ kdb: first.kdb, vatIds: [] });
      await second.vatManager.runVat('v1', config);
      second.run();
      await settle();

      expect(second.delivered).toStrictEqual([
        { type: 'terminateVat', vatId: 'v1' },
      ]);
      expect(second.kernelStore.isVatActive('v1')).toBe(false);
    });
  });
});
