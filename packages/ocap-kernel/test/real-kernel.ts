import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { TestDuplexStream } from '@ocap/repo-tools/test-utils/streams';
import { expect, vi } from 'vitest';

import { asVatId } from './branded.ts';
import { Kernel } from '../src/Kernel.ts';
import { kser, makeFatalKernelError } from '../src/liveslots/kernel-marshal.ts';
import type {
  CrankResult,
  EndpointMessage,
  KRef,
  PlatformServices,
  VatId,
} from '../src/types.ts';
import { VatHandle } from '../src/vats/VatHandle.ts';
import { VatSyscall } from '../src/vats/VatSyscall.ts';

/**
 * A crank result asking for the termination of a vat that does not exist,
 * which throws out of the crank and kills the run loop.
 *
 * @param vatId - The vat whose delivery this is.
 * @returns The crank result.
 */
export function explosion(vatId: VatId): CrankResult {
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
 * Follow how a promise settles.
 *
 * @param promise - The promise.
 * @returns A function reporting `pending`, `fulfilled`, or the message it was
 * rejected with.
 */
export function watch(promise: Promise<unknown>): () => string {
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

/**
 * A kernel over a real store, running two vats whose handles are faked:
 * `waiter` (v1), the bootstrap vat, and `doomed` (v2). A vat answers
 * `bootstrap` and `answer`, returns {@link explosion} for `explode`, and holds
 * its crank open on `stall` until the test calls `release`.
 *
 * @param options - Options bag.
 * @param options.dbFilename - Where the store lives.
 * @returns The kernel and what a test drives or watches it through.
 */
export async function setUpRealKernel({
  dbFilename = ':memory:',
}: { dbFilename?: string } = {}) {
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
    launch: vi.fn(async () =>
      TestDuplexStream.make<JsonRpcMessage, JsonRpcMessage>(() => undefined),
    ),
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
          if (method === 'explode') {
            return explosion(vatId);
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

  const kernelDatabase = await makeSQLKernelDatabase({ dbFilename });
  const close = vi.spyOn(kernelDatabase, 'close');
  const onRunLoopFailure = vi.fn();
  const kernel = await Kernel.make(platformServices, kernelDatabase, {
    logger,
    onRunLoopFailure,
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
  const { waiter, doomed } = await launch();
  /**
   * Hold a crank open on a vat, and wait until it is.
   *
   * @param root - The root of the vat, the waiter's by default.
   */
  const stall = async (root: KRef = waiter as KRef): Promise<void> => {
    const vatId = root === waiter ? 'v1' : 'v2';
    kernel.queueMessage(root, 'stall', []).catch(() => undefined);
    await vi.waitFor(() => expect(received).toContain(`${vatId}:stall`));
  };
  /** Kill the run loop in the crank `stall` holds open on the waiter. */
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
    onRunLoopFailure,
    platformServices,
    launch,
    waiterRoot: waiter as KRef,
    doomedRoot: doomed as KRef,
    waiterId: asVatId('v1'),
    doomedId: asVatId('v2'),
    received,
    terminated,
    stall,
    explode,
    release: (result: CrankResult): void => releaseStall?.(result),
    onTerminate: (hook: (vatId: VatId) => void): void => {
      onTerminate = hook;
    },
  };
}

export type RealKernel = Awaited<ReturnType<typeof setUpRealKernel>>;
