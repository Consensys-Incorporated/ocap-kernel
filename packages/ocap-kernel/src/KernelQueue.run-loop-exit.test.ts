import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import { describe, it, expect, vi } from 'vitest';

import { Kernel } from './Kernel.ts';
import { kser, makeFatalKernelError } from './liveslots/kernel-marshal.ts';
import type {
  CrankResult,
  EndpointMessage,
  PlatformServices,
} from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { VatSyscall } from './vats/VatSyscall.ts';

/*
 * Invariant M2: each kind of caller waiting on queued work is rejected, not
 * left hanging, whichever way the run loop exits.
 *
 * `it.fails` rows are known gaps on main. A PR that closes one must flip its
 * row to `it`.
 */

/** How long a caller may stay pending before it counts as hung. */
const HANG_MS = 100;

/**
 * A kernel over a real store, running two mocked vats that answer `bootstrap`
 * and nothing else. A vat sent `explode` exits with a channel that will not
 * close, which kills the run loop.
 *
 * @returns The kernel and the root of each vat.
 */
async function setUp() {
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
      let exploded = false;
      return {
        vatId,
        config: vatConfig,
        deliverMessage: async (
          _target: string,
          message: EndpointMessage,
        ): Promise<CrankResult> => {
          const [method] = JSON.parse(message.methargs.body.slice(1));
          if (method === 'bootstrap' && message.result) {
            vatSyscall.handleSyscall([
              'resolve',
              [[message.result, false, kser('ready')]],
            ]);
          }
          if (method === 'explode') {
            exploded = true;
            return {
              didDelivery: vatId,
              terminate: {
                vatId,
                reject: true,
                info: makeFatalKernelError('INTERNAL_ERROR', 'exploded'),
              },
            };
          }
          return { didDelivery: vatId };
        },
        terminate: async (): Promise<void> => {
          if (exploded) {
            throw new Error('channel would not close');
          }
        },
      } as unknown as VatHandle;
    },
  );

  const kernel = await Kernel.make(
    platformServices,
    await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
    { logger },
  );
  const { vatRootKrefs } = await kernel.launchSubcluster({
    bootstrap: 'waiter',
    vats: {
      waiter: { sourceSpec: 'waiter.js' },
      doomed: { sourceSpec: 'doomed.js' },
    },
  });
  return {
    kernel,
    waiterRoot: vatRootKrefs.waiter as string,
    doomedRoot: vatRootKrefs.doomed as string,
  };
}

/**
 * @param promise - A caller's promise.
 * @returns How it settled, or `hung` if it had not within {@link HANG_MS}.
 */
async function outcome(
  promise: Promise<unknown>,
): Promise<'fulfilled' | 'rejected' | 'hung'> {
  return Promise.race([
    promise.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    delay(HANG_MS).then(() => 'hung' as const),
  ]);
}

type Harness = Awaited<ReturnType<typeof setUp>>;

/**
 * Leave a caller waiting on a message its vat has taken but not answered, end
 * the run loop by `exit`, and report how the caller settled.
 *
 * @param exit - How the run loop ends.
 * @returns How the caller settled.
 */
async function waitThrough(
  exit: (harness: Harness) => Promise<void>,
): Promise<'fulfilled' | 'rejected' | 'hung'> {
  const harness = await setUp();
  const caller = harness.kernel.queueMessage(harness.waiterRoot, 'work', []);
  expect(await outcome(caller)).toBe('hung');
  await exit(harness);
  return outcome(caller);
}

describe('a queueMessage caller the vat has not answered', () => {
  it.each([
    {
      exit: 'a crank failure',
      run: async ({ kernel, doomedRoot }: Harness): Promise<void> => {
        kernel.queueMessage(doomedRoot, 'explode', []).catch(() => undefined);
        // `getStatus` waits out the crank in progress.
        while ((await kernel.getStatus()).runLoop.state !== 'failed') {
          await delay(1);
        }
      },
    },
    // Only because terminating the vat rejects the promises it decides; reset
    // does not fail the kernel's waiters itself.
    {
      exit: 'reset',
      run: async ({ kernel }: Harness): Promise<void> => kernel.reset(),
    },
  ])('is rejected when the run loop exits by $exit', async ({ run }) => {
    expect(await waitThrough(run)).toBe('rejected');
  });

  it.fails.each([
    {
      exit: 'stop',
      run: async ({ kernel }: Harness): Promise<void> => kernel.stop(),
    },
    {
      exit: 'clearStorage',
      run: async ({ kernel }: Harness): Promise<void> => kernel.clearStorage(),
    },
  ])('is rejected when the run loop exits by $exit', async ({ run }) => {
    expect(await waitThrough(run)).toBe('rejected');
  });

  // No caller on main waits for a vat by id: `restartVat` hands back its
  // handle directly. #1096 queues the restart, giving that caller a wait.
  it.todo(
    'after reset, a vat that reuses a vat id is never handed to a caller from before the reset',
  );
});
