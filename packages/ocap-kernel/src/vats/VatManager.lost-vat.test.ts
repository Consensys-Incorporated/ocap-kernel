import { makePromiseKit } from '@endo/promise-kit';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay, isJsonRpcMessage } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { TestDuplexStream } from '@ocap/repo-tools/test-utils/streams';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from '../KernelQueue.ts';
import { KernelRouter } from '../KernelRouter.ts';
import { kser, kunser } from '../liveslots/kernel-marshal.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  EndpointId,
  PlatformServices,
  VatConfig,
  VatId,
} from '../types.ts';
import { makeGCAction } from '../types.ts';
import { VatManager } from './VatManager.ts';

type Stream = TestDuplexStream<JsonRpcMessage, JsonRpcMessage>;

type KernelDatabase = Awaited<ReturnType<typeof makeSQLKernelDatabase>>;

/** How a vat loses its channel. */
type Death = 'close' | 'bad frame';

type Worker = {
  /** Make a syscall, as liveslots would mid-delivery. */
  syscall: (vso: unknown[]) => Promise<void>;
  /**
   * Lose the channel: a close ends it cleanly, as a runtime may for an exited
   * worker; a bad frame fails it, as a garbled message from a live worker
   * does.
   */
  die: (death: Death) => Promise<void>;
};

type DeliverHook = (
  worker: Worker,
  params: unknown,
) => Promise<'answer' | 'silent'>;

const config: VatConfig = { sourceSpec: 'test.js' };

/**
 * Fake vat workers on in-memory streams, speaking the vat's side of the
 * JSON-RPC protocol: `initVat` and `deliver` are answered with an empty
 * checkpoint unless a hook for the vat says otherwise.
 *
 * @returns The launcher and the record of what each vat was delivered.
 */
function makeWorkers() {
  const hooks = new Map<VatId, DeliverHook>();
  const delivered = new Map<VatId, unknown[]>();
  const launch = async (vatId: VatId): Promise<Stream> => {
    const holder: { stream?: Stream } = {};
    const receive = async (message: unknown): Promise<void> => {
      await holder.stream?.receiveInput(message);
    };
    const worker: Worker = {
      syscall: async (vso) =>
        receive({ jsonrpc: '2.0', method: 'syscall', params: vso }),
      die: async (death) => {
        if (death === 'close') {
          await holder.stream?.return();
        } else {
          await receive(NaN);
        }
      },
    };
    const answer = async (id: string): Promise<void> =>
      receive({ jsonrpc: '2.0', id, result: [[[], []], null] });
    const stream = await TestDuplexStream.make<JsonRpcMessage, JsonRpcMessage>(
      (request) => {
        const { id, method, params } = request as {
          id?: string;
          method?: string;
          params?: unknown;
        };
        if (!id || !method) {
          return;
        }
        // Off the kernel's write, as a worker on its own thread answers.
        setTimeout(() => {
          (async () => {
            if (method !== 'deliver') {
              await answer(id);
              return;
            }
            delivered.set(vatId, [...(delivered.get(vatId) ?? []), params]);
            const hook = hooks.get(vatId);
            const outcome = hook ? await hook(worker, params) : 'answer';
            if (outcome === 'answer') {
              await answer(id);
            }
          })().catch(() => undefined);
        }, 0);
      },
      { validateInput: isJsonRpcMessage },
    );
    holder.stream = stream;
    return stream;
  };
  return {
    launch,
    onDeliver: (vatId: VatId, hook: DeliverHook) => hooks.set(vatId, hook),
    /**
     * @param vatId - The vat.
     * @returns The method of each message delivered to it, in order.
     */
    methodsDelivered: (vatId: VatId): string[] =>
      (delivered.get(vatId) ?? []).flatMap((params) => {
        const [kind, , message] = params as [
          string,
          string,
          { methargs: { body: string; slots: string[] } },
        ];
        return kind === 'message'
          ? [(kunser(message.methargs) as [string])[0]]
          : [];
      }),
  };
}

/**
 * A kernel's run loop, router and vat manager over a store, with real
 * `VatHandle`s over fake workers, wired as `Kernel` wires them.
 *
 * @param kdb - The database.
 * @returns The pieces a test drives.
 */
function boot(kdb: KernelDatabase) {
  const kernelStore: KernelStore = makeKernelStore(kdb);
  const logger = new Logger('test');
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined);
  }
  vi.spyOn(logger, 'subLogger').mockReturnValue(logger);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  // The `terminateVat` `Kernel` passes, held in an object so the queue can
  // reach a manager that needs the queue to exist first.
  const kernel: { vatManager?: VatManager } = {};
  const kernelQueue = new KernelQueue(kernelStore, async (vatId, reason) =>
    kernel.vatManager?.stopVat(vatId, true, reason),
  );
  const workers = makeWorkers();
  const platformServices = {
    launch: vi.fn(async (vatId: VatId) => workers.launch(vatId)),
    terminate: vi.fn(async () => undefined),
  } as unknown as PlatformServices;
  const vatManager = new VatManager({
    platformServices,
    kernelStore,
    kernelQueue,
    logger,
  });
  kernel.vatManager = vatManager;
  const kernelRouter = new KernelRouter(
    kernelStore,
    kernelQueue,
    (endpointId: EndpointId) => vatManager.getVat(endpointId as VatId),
    () => undefined,
    vatManager.performVatRestart.bind(vatManager),
    vatManager.performVatTermination.bind(vatManager),
    logger,
  );
  return {
    kernelStore,
    kernelQueue,
    vatManager,
    workers,
    platformServices,
    run: (): void => {
      kernelQueue
        .run(kernelRouter.deliver.bind(kernelRouter))
        .catch(() => undefined);
    },
  };
}

/**
 * Boot a kernel and launch `v1` ("doomed"), which imports the root of `v2`
 * ("survivor").
 *
 * @returns The pieces a test drives, and a way to boot the same store again.
 */
async function setUp() {
  const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernel = boot(kdb);
  const { vatManager, kernelStore } = kernel;
  const doomedRoot = await vatManager.launchVat(config, 'doomed');
  const survivorRoot = await vatManager.launchVat(config, 'survivor');
  const survivorERef = kernelStore.translateRefKtoE('v1', survivorRoot, true);
  return {
    ...kernel,
    doomedRoot,
    survivorRoot,
    survivorERef,
  };
}

type Harness = Awaited<ReturnType<typeof setUp>>;

describe('a vat that loses its channel mid-delivery', () => {
  const deliveries = [
    {
      what: 'send',
      queue: async ({ kernelQueue, doomedRoot }: Harness): Promise<unknown> =>
        kernelQueue.enqueueMessage(doomedRoot, 'work', []),
    },
    {
      what: 'notify',
      queue: ({ kernelStore, kernelQueue }: Harness): undefined => {
        const [kpid] = kernelStore.initKernelPromise();
        kernelStore.translateRefKtoE('v1', kpid, true);
        kernelStore.addPromiseSubscriber('v1', kpid);
        kernelQueue.resolvePromises(undefined, [[kpid, false, kser('done')]]);
        return undefined;
      },
    },
    {
      what: 'dropExports',
      queue: ({ kernelStore }: Harness): undefined => {
        const kref = kernelStore.initKernelObject('v1');
        kernelStore.addCListEntry('v1', kref, 'o+10');
        kernelStore.addGCActions([makeGCAction('v1', 'dropExport', kref)]);
        return undefined;
      },
    },
    {
      what: 'bringOutYourDead',
      queue: ({ kernelStore }: Harness): undefined => {
        kernelStore.scheduleReap('v1');
        return undefined;
      },
    },
  ];
  const deaths: Death[] = ['close', 'bad frame'];

  it.each(
    deaths.flatMap((death) =>
      deliveries.map((delivery) => ({ death, ...delivery })),
    ),
  )(
    'rolls back what the vat sent during the $what it lost its channel in ($death)',
    async ({ death, queue }) => {
      const harness = await setUp();
      const { kernelStore, kernelQueue, workers, survivorERef } = harness;
      workers.onDeliver('v1', async ({ syscall, die }) => {
        await syscall([
          'send',
          survivorERef,
          { methargs: kser(['fromDyingVat', []]), result: 'p+5' },
        ]);
        await die(death);
        return 'silent';
      });

      let caller = 'none';
      queue(harness)
        ?.then(() => {
          caller = 'fulfilled';
          return undefined;
        })
        .catch((rejection: Parameters<typeof kunser>[0]) => {
          caller = (kunser(rejection) as Error).message;
        });
      harness.run();
      await delay(100);

      expect({
        doomedActive: kernelStore.isVatActive('v1'),
        survivorGot: workers.methodsDelivered('v2'),
        runLoop: kernelQueue.getRunLoopStatus().state,
      }).toStrictEqual({
        doomedActive: false,
        survivorGot: [],
        runLoop: 'running',
      });
      expect(caller).toMatch(
        caller === 'none'
          ? /^none$/u
          : /^\[KERNEL:VAT_TERMINATED\] Vat v1 lost its channel: /u,
      );
    },
  );
});

describe('a delivery a kernel stop cuts off', () => {
  it('is left uncommitted when the vat then loses its channel', async () => {
    const harness = await setUp();
    const { kernelStore, kernelQueue, vatManager, workers } = harness;
    let doomedWorker: Worker | undefined;
    workers.onDeliver('v1', async (worker) => {
      doomedWorker = worker;
      return 'silent';
    });
    let caller = 'pending';
    kernelQueue
      .enqueueMessage(harness.doomedRoot, 'work', [])
      .then(() => {
        caller = 'fulfilled';
        return undefined;
      })
      .catch(() => {
        caller = 'rejected';
      });
    harness.run();
    await vi.waitFor(() => expect(doomedWorker).toBeDefined());

    vatManager.expectWorkersToStop();
    await doomedWorker?.die('close');
    await delay(50);

    expect({
      caller,
      running: vatManager.getVatIds(),
      active: kernelStore.isVatActive('v1'),
    }).toStrictEqual({
      caller: 'pending',
      running: ['v1', 'v2'],
      active: true,
    });
  });
});

describe('terminateAllVats while the run loop runs', () => {
  const deliveries = [
    {
      what: 'send with a result',
      queue: ({ kernelQueue, doomedRoot }: Harness): void => {
        kernelQueue
          .enqueueMessage(doomedRoot, 'second', [])
          .catch(() => undefined);
      },
    },
    {
      what: 'send with no result',
      queue: ({ kernelQueue, doomedRoot }: Harness): void => {
        kernelQueue.enqueueSend(doomedRoot, {
          methargs: kser(['second', []]),
          result: null,
        });
      },
    },
    {
      what: 'notify',
      queue: ({ kernelStore, kernelQueue }: Harness): void => {
        const [kpid] = kernelStore.initKernelPromise();
        kernelStore.translateRefKtoE('v1', kpid, true);
        kernelStore.addPromiseSubscriber('v1', kpid);
        kernelQueue.resolvePromises(undefined, [[kpid, false, kser('done')]]);
      },
    },
  ];

  it.each(deliveries)(
    'keeps a vat it stops mid-$what terminated',
    async ({ queue }) => {
      const harness = await setUp();
      const { kernelStore, kernelQueue, vatManager, workers } = harness;
      const v2Busy = makePromiseKit<void>();
      let v2Started = false;
      workers.onDeliver('v2', async () => {
        v2Started = true;
        await v2Busy.promise;
        return 'answer';
      });
      let v1Started = false;
      workers.onDeliver('v1', async () => {
        v1Started = true;
        return 'silent';
      });
      kernelQueue
        .enqueueMessage(harness.survivorRoot, 'first', [])
        .catch(() => undefined);
      queue(harness);
      harness.run();
      await vi.waitFor(() => expect(v2Started).toBe(true));

      // Resumes inside the crank that delivers to v1, whose stop then fails
      // that delivery.
      const terminating = vatManager.terminateAllVats();
      v2Busy.resolve();
      await terminating;
      await delay(50);

      expect({
        v1Started,
        running: vatManager.getVatIds(),
        persisted: [...kernelStore.getAllVatRecords()].map(
          ({ vatID }) => vatID,
        ),
        runLoop: kernelQueue.getRunLoopStatus().state,
      }).toStrictEqual({
        v1Started: true,
        running: [],
        persisted: [],
        runLoop: 'running',
      });
    },
  );
});

describe('terminateAllVats resuming inside a restart crank', () => {
  it('leaves the vat neither running nor persisted', async () => {
    const harness = await setUp();
    const { kernelStore, kernelQueue, vatManager, workers } = harness;
    const v2Busy = makePromiseKit<void>();
    let v2Started = false;
    workers.onDeliver('v2', async () => {
      v2Started = true;
      await v2Busy.promise;
      return 'answer';
    });
    kernelQueue
      .enqueueMessage(harness.survivorRoot, 'first', [])
      .catch(() => undefined);
    harness.run();
    await vi.waitFor(() => expect(v2Started).toBe(true));

    let restart = 'pending';
    vatManager
      .restartVat('v1')
      .then(() => {
        restart = 'fulfilled';
        return undefined;
      })
      .catch((error: Error) => {
        restart = error.message;
      });
    // Held behind the restart, whose crank starts as this one ends.
    const terminating = vatManager.terminateAllVats();
    v2Busy.resolve();
    await terminating;
    await delay(50);

    expect({
      restart,
      running: vatManager.getVatIds(),
      persisted: [...kernelStore.getAllVatRecords()].map(({ vatID }) => vatID),
      runLoop: kernelQueue.getRunLoopStatus().state,
    }).toStrictEqual({
      restart: 'Vat was deleted.',
      running: [],
      persisted: [],
      runLoop: 'running',
    });
  });
});

describe('a restart a kernel stop cuts short', () => {
  it('leaves messages to the vat for the next start', async () => {
    const harness = await setUp();
    const { kernelStore, kernelQueue, vatManager, platformServices } = harness;
    harness.run();
    await delay(10);
    const launch = makePromiseKit<never>();
    let launchStarted = false;
    vi.mocked(platformServices.launch).mockImplementationOnce(async () => {
      launchStarted = true;
      return launch.promise;
    });
    const restarting = vatManager.restartVat('v1');
    restarting.catch(() => undefined);
    let settled = 'pending';
    kernelQueue
      .enqueueMessage(harness.doomedRoot, 'afterRestart', [])
      .then(() => {
        settled = 'fulfilled';
        return undefined;
      })
      .catch(() => {
        settled = 'rejected';
      });
    await vi.waitFor(() => expect(launchStarted).toBe(true));

    vatManager.expectWorkersToStop();
    launch.reject(new Error('channel closed by the stop'));

    await expect(restarting).rejects.toThrow('cut short by a kernel stop');
    await delay(50);
    expect({
      settled,
      queued: kernelStore.runQueueLength(),
      active: kernelStore.isVatActive('v1'),
    }).toStrictEqual({ settled: 'pending', queued: 1, active: true });
  });
});
