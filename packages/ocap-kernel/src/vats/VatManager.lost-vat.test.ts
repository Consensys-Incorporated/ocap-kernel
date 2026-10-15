import { makePromiseKit } from '@endo/promise-kit';
import { StreamReadError } from '@metamask/kernel-errors';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay, isJsonRpcMessage } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { TestDuplexStream } from '@ocap/repo-tools/test-utils/streams';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, onTestFinished, vi } from 'vitest';

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
import { VatHandle } from './VatHandle.ts';
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

type InitHook = (worker: Worker) => Promise<void>;

const config: VatConfig = { sourceSpec: 'test.js' };

/**
 * Fake vat workers on in-memory streams, speaking the vat's side of the
 * JSON-RPC protocol: `initVat` and `deliver` are answered with an empty
 * checkpoint once the vat's hook for each, if any, has run; a `deliver` hook
 * can withhold the answer.
 *
 * @returns The launcher and the record of what each vat was delivered.
 */
function makeWorkers() {
  const hooks = new Map<VatId, DeliverHook>();
  const initHooks = new Map<VatId, InitHook>();
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
          if (!holder.stream) {
            throw new Error(`Vat ${vatId} has no channel to close`);
          }
          await holder.stream.return();
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
            if (method === 'initVat') {
              await initHooks.get(vatId)?.(worker);
            }
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
    onInit: (vatId: VatId, hook: InitHook) => initHooks.set(vatId, hook),
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
 * @param options - Options.
 * @param options.failToStart - Vats whose worker will not launch.
 * @returns The pieces a test drives.
 */
function boot(
  kdb: KernelDatabase,
  { failToStart = new Set() }: { failToStart?: Set<VatId> } = {},
) {
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
    launch: vi.fn(async (vatId: VatId) => {
      if (failToStart.has(vatId)) {
        throw new Error(`bundle for ${vatId} not found`);
      }
      return workers.launch(vatId);
    }),
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
 * @param options - Named options.
 * @param options.onDisk - Keep the store in a file, so `reboot` can open it
 *   again.
 * @returns The pieces a test drives, and a way to boot the same store again.
 */
async function setUp({ onDisk = false }: { onDisk?: boolean } = {}) {
  let dbFilename = ':memory:';
  if (onDisk) {
    const dir = await mkdtemp(join(tmpdir(), 'lost-vat-'));
    onTestFinished(async () => rm(dir, { recursive: true, force: true }));
    dbFilename = join(dir, 'store.db');
  }
  const kdb = await makeSQLKernelDatabase({ dbFilename });
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
    /**
     * Close the database, as `Kernel.stop` does, which discards an open
     * crank, and start a kernel over the same file with new workers.
     *
     * @param options - What `boot` takes.
     * @param options.failToStart - Vats whose worker will not launch.
     * @returns The new kernel's pieces, its run loop running, and whether a
     *   crank was still open when the database closed.
     */
    reboot: async (options: { failToStart?: Set<VatId> } = {}) => {
      if (!onDisk) {
        throw new Error('Only a store on disk can be booted again');
      }
      // A turn of the event loop first, as `Kernel.stop`'s own awaits give,
      // so every microtask chain a lost channel set off has run.
      await delay(0);
      const cutOff = kernel.kernelStore.isInCrank();
      kdb.close();
      const next = boot(await makeSQLKernelDatabase({ dbFilename }), options);
      await next.vatManager.initializeAllVats();
      next.run();
      return { ...next, cutOff };
    },
  };
}

type Harness = Awaited<ReturnType<typeof setUp>>;

/**
 * Wait until everything queued so far has been delivered. The run queue is
 * first in, first out, so once a message queued now reaches `v2`, anything
 * ahead of it has been delivered too.
 *
 * @param harness - The kernel.
 */
async function deliverEverythingQueued(harness: Harness): Promise<void> {
  const { kernelStore, kernelQueue, survivorRoot, workers } = harness;
  // Queued between cranks, where no rollback can take it back.
  while (kernelStore.isInCrank()) {
    await kernelQueue.waitForCrank();
  }
  kernelQueue.assertRunLoopAlive('queue the sentinel');
  kernelQueue
    .enqueueMessage(survivorRoot, 'sentinel', [])
    .catch(() => undefined);
  await vi.waitFor(() =>
    expect(workers.methodsDelivered('v2')).toContain('sentinel'),
  );
}

/**
 * Have the next vat to start lose its channel as its handshake ends, before or
 * after the manager registers its handle.
 *
 * @param options - Named options.
 * @param options.vatManager - The manager starting it.
 * @param options.vatId - The vat.
 * @param options.when - Whether the loss comes before or after registration.
 * @returns Where the loss landed: `'registered'`, `'unregistered'`, or
 *   `'never'`.
 */
function loseChannelAsItStarts({
  vatManager,
  vatId,
  when,
}: {
  vatManager: VatManager;
  vatId: VatId;
  when: 'before' | 'after';
}): () => string {
  let landed = 'never';
  const make = VatHandle.make.bind(VatHandle);
  vi.spyOn(VatHandle, 'make').mockImplementationOnce(async (params) => {
    const handle = await make(params);
    const lose = (): void => {
      landed = vatManager.hasVat(vatId) ? 'registered' : 'unregistered';
      params.onStreamFailure(
        new StreamReadError(
          { vatId },
          { cause: new Error('vat channel closed') },
        ),
      );
    };
    if (when === 'before') {
      lose();
    } else {
      // Polled a microtask at a time, so the loss lands once the handle is
      // registered and before the start's caller checks for one. Bounded, as
      // a registration that waits on a timer would otherwise spin forever.
      (async () => {
        for (let turn = 0; turn < 100 && !vatManager.hasVat(vatId); turn++) {
          await Promise.resolve();
        }
        lose();
      })().catch(() => undefined);
    }
    return handle;
  });
  return () => landed;
}

describe('a vat that loses its channel mid-delivery', () => {
  const deliveries = [
    {
      what: 'send',
      queue: async ({ kernelQueue, doomedRoot }: Harness): Promise<unknown> =>
        kernelQueue.enqueueMessage(doomedRoot, 'work', []),
      caller: /^\[KERNEL:VAT_TERMINATED\] Vat v1 lost its channel: /u,
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
      caller: /^none$/u,
    },
    {
      what: 'dropExports',
      queue: ({ kernelStore }: Harness): undefined => {
        const kref = kernelStore.initKernelObject('v1');
        kernelStore.addCListEntry('v1', kref, 'o+10');
        kernelStore.addGCActions([makeGCAction('v1', 'dropExport', kref)]);
        return undefined;
      },
      caller: /^none$/u,
    },
    {
      what: 'bringOutYourDead',
      queue: ({ kernelStore }: Harness): undefined => {
        kernelStore.scheduleReap('v1');
        return undefined;
      },
      caller: /^none$/u,
    },
  ];
  const deaths: Death[] = ['close', 'bad frame'];

  it.each(
    deaths.flatMap((death) =>
      deliveries.map((delivery) => ({ death, ...delivery })),
    ),
  )(
    'rolls back what the vat sent during the $what it lost its channel in ($death)',
    async ({ death, queue, caller: expectedCaller }) => {
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
      await vi.waitFor(() =>
        expect({
          doomedActive: kernelStore.isVatActive('v1'),
          caller,
        }).toStrictEqual({
          doomedActive: false,
          caller: expect.stringMatching(expectedCaller),
        }),
      );
      await deliverEverythingQueued(harness);

      expect({
        survivorGot: workers.methodsDelivered('v2'),
        runLoop: kernelQueue.getRunLoopStatus().state,
      }).toStrictEqual({
        survivorGot: ['sentinel'],
        runLoop: 'running',
      });
    },
  );
});

describe('a delivery a kernel stop cuts off', () => {
  it('is delivered again on the next start when the vat then loses its channel', async () => {
    const harness = await setUp({ onDisk: true });
    const { kernelQueue, vatManager, workers } = harness;
    let doomedWorker: Worker | undefined;
    workers.onDeliver('v1', async (worker) => {
      doomedWorker = worker;
      return 'silent';
    });
    kernelQueue
      .enqueueMessage(harness.doomedRoot, 'work', [])
      .catch(() => undefined);
    harness.run();
    await vi.waitFor(() => expect(doomedWorker).toBeDefined());

    vatManager.expectWorkersToStop();
    await doomedWorker?.die('close');
    const next = await harness.reboot();

    expect({
      cutOff: next.cutOff,
      running: vatManager.getVatIds(),
      runLoop: kernelQueue.getRunLoopStatus().state,
    }).toStrictEqual({
      cutOff: true,
      running: ['v1', 'v2'],
      runLoop: 'running',
    });
    await vi.waitFor(() =>
      expect(next.workers.methodsDelivered('v1')).toStrictEqual(['work']),
    );
  });
});

describe('a vat that failed to start at boot', () => {
  it('is terminated by terminateAllVats', async () => {
    const harness = await setUp({ onDisk: true });
    const next = await harness.reboot({ failToStart: new Set(['v1']) });

    await next.vatManager.terminateAllVats();

    expect({
      running: next.vatManager.getVatIds(),
      persisted: [...next.kernelStore.getAllVatRecords()].map(
        ({ vatID }) => vatID,
      ),
    }).toStrictEqual({ running: [], persisted: [] });
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
      // The delivery reached v1's worker, so `terminateAllVats` resumed inside
      // its crank, whose end is where a rollback would have undone the
      // retirement.
      await vi.waitFor(() => expect(v1Started).toBe(true));
      await kernelQueue.waitForCrank();

      expect({
        running: vatManager.getVatIds(),
        persisted: [...kernelStore.getAllVatRecords()].map(
          ({ vatID }) => vatID,
        ),
        runLoop: kernelQueue.getRunLoopStatus().state,
      }).toStrictEqual({
        running: [],
        persisted: [],
        runLoop: 'running',
      });
    },
  );
});

describe('terminateAllVats resuming inside a restart crank', () => {
  const relaunches = [
    {
      relaunch: 'succeeds',
      arrange: (): (() => void) => () => undefined,
    },
    {
      relaunch: 'fails',
      // Once the vat is retired, which a rollback would undo.
      arrange: ({ platformServices }: Harness): (() => void) => {
        const launch = makePromiseKit<never>();
        vi.mocked(platformServices.launch).mockImplementationOnce(
          async () => launch.promise,
        );
        return () => launch.reject(new Error('worker gone'));
      },
    },
  ];

  it.each(relaunches)(
    'leaves no vat running or persisted when the relaunch $relaunch',
    async ({ arrange }) => {
      const harness = await setUp();
      const { kernelStore, kernelQueue, vatManager, workers } = harness;
      const endRelaunch = arrange(harness);
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
      // Resumes inside the restart's crank, which starts as this one ends.
      const terminating = vatManager.terminateAllVats();
      v2Busy.resolve();
      await terminating;
      endRelaunch();

      // The restart is answered once its crank commits.
      await vi.waitFor(() =>
        expect({
          restart,
          running: vatManager.getVatIds(),
          persisted: [...kernelStore.getAllVatRecords()].map(
            ({ vatID }) => vatID,
          ),
          runLoop: kernelQueue.getRunLoopStatus().state,
        }).toStrictEqual({
          restart: 'Vat was deleted.',
          running: [],
          persisted: [],
          runLoop: 'running',
        }),
      );
    },
  );
});

describe('a restarted vat that loses its new channel as the restart ends', () => {
  /**
   * Have v1's next worker send to v2 while it starts.
   *
   * @param harness - The kernel.
   */
  const sendWhileStarting = (harness: Harness): void => {
    const { workers, survivorERef } = harness;
    workers.onInit('v1', async ({ syscall }) =>
      syscall([
        'send',
        survivorERef,
        { methargs: kser(['fromNewWorker', []]), result: 'p+5' },
      ]),
    );
  };

  it('commits what the new worker sent while starting when it is not lost', async () => {
    const harness = await setUp();
    sendWhileStarting(harness);
    harness.run();

    await harness.vatManager.restartVat('v1');
    await deliverEverythingQueued(harness);

    expect(harness.workers.methodsDelivered('v2')).toStrictEqual([
      'fromNewWorker',
      'sentinel',
    ]);
  });

  it.each([
    { when: 'before' as const, landed: 'unregistered' },
    { when: 'after' as const, landed: 'registered' },
  ])(
    'fails the restart when it is lost $when the manager registers its handle',
    async ({ when, landed }) => {
      const harness = await setUp();
      const { kernelStore, kernelQueue, vatManager, workers } = harness;
      sendWhileStarting(harness);
      const lossLanded = loseChannelAsItStarts({
        vatManager,
        vatId: 'v1',
        when,
      });
      harness.run();

      let restarted = 'pending';
      vatManager
        .restartVat('v1')
        .then(() => {
          restarted = 'fulfilled';
          return undefined;
        })
        .catch((error: unknown) => {
          restarted = (error as Error).message;
        });

      await vi.waitFor(() => expect(restarted).not.toBe('pending'));
      await deliverEverythingQueued(harness);

      expect({
        landed: lossLanded(),
        restarted,
        survivorGot: workers.methodsDelivered('v2'),
        running: vatManager.getVatIds(),
        active: kernelStore.isVatActive('v1'),
        runLoop: kernelQueue.getRunLoopStatus().state,
      }).toStrictEqual({
        landed,
        restarted:
          'Vat v1 was terminated after its restart failed: vat channel closed',
        survivorGot: ['sentinel'],
        running: ['v2'],
        active: false,
        runLoop: 'running',
      });
    },
  );
});

describe('a vat that loses its channel as it launches', () => {
  it.each([
    { when: 'before' as const, landed: 'unregistered' },
    { when: 'after' as const, landed: 'registered' },
  ])(
    'fails the launch and stops the worker when it is lost $when the manager registers its handle',
    async ({ when, landed }) => {
      const harness = await setUp();
      const { kernelStore, kernelQueue, vatManager, platformServices } =
        harness;
      const lossLanded = loseChannelAsItStarts({
        vatManager,
        vatId: 'v3',
        when,
      });
      harness.run();

      const failure = await vatManager
        .launchVat(config, 'late')
        .catch((error: Error) => error);

      expect({
        landed: lossLanded(),
        failure: (failure as Error).message,
        lostWith: (((failure as Error).cause as Error).cause as Error).message,
        stopped: vi.mocked(platformServices.terminate).mock.calls,
        running: vatManager.getVatIds(),
        active: kernelStore.isVatActive('v3'),
        runLoop: kernelQueue.getRunLoopStatus().state,
      }).toStrictEqual({
        landed,
        failure: 'Failed to launch vat v3 (late)',
        lostWith: 'vat channel closed',
        stopped: [['v3']],
        running: ['v1', 'v2'],
        active: false,
        runLoop: 'running',
      });
    },
  );
});

describe('a restart a kernel stop cuts short', () => {
  it('leaves messages to the vat for the next start', async () => {
    const harness = await setUp({ onDisk: true });
    const { kernelQueue, vatManager, platformServices } = harness;
    harness.run();
    const launch = makePromiseKit<never>();
    let launchStarted = false;
    vi.mocked(platformServices.launch).mockImplementationOnce(async () => {
      launchStarted = true;
      return launch.promise;
    });
    const restarting = vatManager.restartVat('v1');
    restarting.catch(() => undefined);
    kernelQueue
      .enqueueMessage(harness.doomedRoot, 'afterRestart', [])
      .catch(() => undefined);
    await vi.waitFor(() => expect(launchStarted).toBe(true));

    vatManager.expectWorkersToStop();
    launch.reject(new Error('channel closed by the stop'));

    await expect(restarting).rejects.toThrow('cut short by a kernel stop');
    const next = await harness.reboot();

    expect(next.cutOff).toBe(true);
    await vi.waitFor(() =>
      expect({
        delivered: next.workers.methodsDelivered('v1'),
        active: next.kernelStore.isVatActive('v1'),
      }).toStrictEqual({ delivered: ['afterRestart'], active: true }),
    );
  });
});
