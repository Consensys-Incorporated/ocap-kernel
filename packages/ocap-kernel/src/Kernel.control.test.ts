import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import { describe, it, expect, vi } from 'vitest';

import { Kernel } from './Kernel.ts';
import { kser, makeFatalKernelError } from './liveslots/kernel-marshal.ts';
import { makeKernelStore } from './store/index.ts';
import type {
  CrankResult,
  EndpointMessage,
  PlatformServices,
  KRef,
  VatId,
} from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { VatSyscall } from './vats/VatSyscall.ts';
import { asVatId } from '../test/branded.ts';

/**
 * A crank result asking for the termination of a vat that does not exist,
 * which throws out of the crank and kills the run loop.
 *
 * @param vatId - The vat whose delivery this is.
 * @returns The crank result.
 */
function explosion(vatId: VatId): CrankResult {
  return {
    didDelivery: vatId,
    terminate: {
      vatId: asVatId('v404'),
      reject: true,
      info: makeFatalKernelError('INTERNAL_ERROR', 'exploded'),
    },
  };
}

/**
 * A kernel over a real store, running two mocked vats. A vat answers
 * `bootstrap` and `answer`; one sent `stall` holds its crank open until the
 * test calls `release`.
 *
 * @returns The kernel and what a test drives or watches it through.
 */
async function setUp() {
  const received: string[] = [];
  const terminated: string[] = [];
  let onTerminate: ((vatId: VatId) => void) | undefined;
  let releaseStall: ((result: CrankResult) => void) | undefined;
  const logger = new Logger('test');
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined);
  }
  vi.spyOn(logger, 'subLogger').mockReturnValue(logger);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  const platformServices = {
    launch: vi.fn().mockResolvedValue({
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>),
    terminate: vi.fn().mockResolvedValue(undefined),
    terminateAll: vi.fn().mockResolvedValue(undefined),
    stopRemoteComms: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlatformServices;

  vi.spyOn(VatHandle, 'make').mockImplementation(
    async ({ vatId, vatConfig, kernelQueue, kernelStore }) => {
      const vatSyscall = new VatSyscall({ vatId, kernelQueue, kernelStore });
      return {
        vatId,
        config: vatConfig,
        deliverMessage: async (
          _target: string,
          message: EndpointMessage,
        ): Promise<CrankResult> => {
          const [method] = JSON.parse(message.methargs.body.slice(1));
          received.push(`${vatId}:${method}`);
          if (
            (method === 'bootstrap' || method === 'answer') &&
            message.result
          ) {
            vatSyscall.handleSyscall([
              'resolve',
              [[message.result, false, kser(method)]],
            ]);
          }
          if (method === 'stall') {
            return new Promise<CrankResult>((resolve) => {
              releaseStall = resolve;
            });
          }
          return { didDelivery: vatId };
        },
        terminate: async (): Promise<void> => {
          terminated.push(vatId);
          onTerminate?.(vatId);
        },
        expectClose: (): void => undefined,
      } as unknown as VatHandle;
    },
  );

  const kernelDatabase = await makeSQLKernelDatabase({
    dbFilename: ':memory:',
  });
  const close = vi.spyOn(kernelDatabase, 'close');
  const kernel = await Kernel.make(platformServices, kernelDatabase, {
    logger,
  });
  const launch = async (): Promise<Record<string, KRef>> => {
    const { vatRootKrefs } = await kernel.launchSubcluster({
      bootstrap: 'waiter',
      vats: {
        waiter: { sourceSpec: 'waiter.js' },
        doomed: { sourceSpec: 'doomed.js' },
      },
    });
    return vatRootKrefs as Record<string, KRef>;
  };
  const { waiter } = await launch();
  /** Hold a crank open on the waiter vat, and wait until it is. */
  const stall = async (): Promise<void> => {
    kernel.queueMessage(waiter as KRef, 'stall', []).catch(() => undefined);
    await vi.waitFor(() => expect(received).toContain('v1:stall'));
  };
  /** Kill the run loop in the crank `stall` holds open. */
  const explode = async (): Promise<void> => {
    releaseStall?.(explosion(asVatId('v1')));
    await vi.waitFor(async () =>
      expect((await kernel.getStatus()).runLoop.state).toBe('failed'),
    );
  };
  return {
    kernel,
    kernelDatabase,
    close,
    platformServices,
    launch,
    waiterRoot: waiter as KRef,
    terminated,
    stall,
    explode,
    release: (result: CrankResult): void => releaseStall?.(result),
    onTerminate: (hook: (vatId: VatId) => void): void => {
      onTerminate = hook;
    },
  };
}

/**
 * Follow how a promise settles.
 *
 * @param promise - The promise.
 * @returns A function reporting `pending`, `fulfilled`, or the message it was
 * rejected with.
 */
function watch(promise: Promise<unknown>): () => string {
  let settlement = 'pending';
  promise
    .then(() => {
      settlement = 'fulfilled';
      return undefined;
    })
    .catch((error: Error) => {
      settlement = error.message;
    });
  return () => settlement;
}

describe('a control operation on a real kernel', () => {
  it.each(['terminateAllVats', 'clearStorage'] as const)(
    'keeps what %s wrote when the crank it waited for aborts',
    async (method) => {
      const harness = await setUp();
      await harness.stall();
      const asked = harness.kernel[method]();
      const settlement = watch(asked);
      await delay(0);
      const whileCrankOpen = settlement();

      harness.release({ didDelivery: asVatId('v1'), abort: true });
      await asked;

      expect({
        whileCrankOpen,
        persisted: makeKernelStore(harness.kernelDatabase).getVatIDs(),
      }).toStrictEqual({ whileCrankOpen: 'pending', persisted: [] });
    },
  );

  it('terminateAllVats waits out the crank in flight, then the run loop runs on', async () => {
    const harness = await setUp();
    await harness.stall();
    const terminating = harness.kernel.terminateAllVats();
    await delay(0);
    const terminatedDuringCrank = [...harness.terminated];

    harness.release({ didDelivery: asVatId('v1') });
    await terminating;
    const { doomed } = await harness.launch();
    const answer = await harness.kernel.queueMessage(
      doomed as KRef,
      'answer',
      [],
    );

    expect({
      terminatedDuringCrank,
      terminated: harness.terminated,
      answer: answer.body,
      runLoop: (await harness.kernel.getStatus()).runLoop.state,
    }).toStrictEqual({
      terminatedDuringCrank: [],
      terminated: ['v2', 'v1'],
      answer: '#"answer"',
      runLoop: 'running',
    });
  });

  it.each([
    {
      request: 'message',
      make: async (kernel: Kernel, root: KRef): Promise<unknown> =>
        kernel.queueMessage(root, 'late', []),
    },
    {
      request: 'termination',
      make: async (kernel: Kernel): Promise<unknown> =>
        kernel.terminateVat(asVatId('v1')),
    },
  ])(
    'abandons a $request asked for while the reset awaits a worker',
    async ({ make }) => {
      const harness = await setUp();
      let late: (() => string) | undefined;
      harness.onTerminate(() => {
        late ??= watch(make(harness.kernel, harness.waiterRoot));
      });

      await harness.kernel.reset();
      harness.onTerminate(() => undefined);
      await delay(0);
      const lateSettlement = late?.();
      await harness.launch();
      await delay(20);
      const status = await harness.kernel.getStatus();

      expect({
        late: lateSettlement,
        vats: status.vats.map(({ id }) => id),
        runLoop: status.runLoop.state,
      }).toStrictEqual({
        late: 'Kernel was reset; queued work was abandoned',
        vats: ['v1', 'v2'],
        runLoop: 'running',
      });
    },
  );

  it('resets a dead kernel twice, one reset after the other', async () => {
    const harness = await setUp();
    await harness.stall();
    await harness.explode();
    const order: string[] = [];
    harness.onTerminate((vatId) => order.push(`terminate ${vatId}`));

    await Promise.all([
      harness.kernel.reset().then(() => order.push('first done')),
      harness.kernel.reset().then(() => order.push('second done')),
    ]);

    expect(order).toStrictEqual([
      'terminate v2',
      'terminate v1',
      'first done',
      'second done',
    ]);
  });
});

describe('stop on a real kernel', () => {
  it('tears down even when the run loop dies before taking it', async () => {
    const harness = await setUp();
    await harness.stall();
    const stopping = watch(harness.kernel.stop());
    await delay(0);

    await harness.explode();
    await vi.waitFor(() => expect(stopping()).toBe('fulfilled'));

    const { platformServices } = harness;
    expect({
      stopRemoteComms: vi.mocked(platformServices.stopRemoteComms).mock.calls
        .length,
      terminateAll: vi.mocked(platformServices.terminateAll).mock.calls.length,
      closed: harness.close.mock.calls.length,
    }).toStrictEqual({ stopRemoteComms: 1, terminateAll: 1, closed: 1 });
  });

  it('settles two concurrent stops together, closing the database once', async () => {
    const harness = await setUp();

    await Promise.all([harness.kernel.stop(), harness.kernel.stop()]);

    expect(harness.close).toHaveBeenCalledOnce();
  });
});
