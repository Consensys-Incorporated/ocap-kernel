import { makePromiseKit } from '@endo/promise-kit';
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
  KRef,
} from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { VatSyscall } from './vats/VatSyscall.ts';
import { asVatId } from '../test/branded.ts';

/*
 * Invariant M2: each kind of caller waiting on queued work is rejected, not
 * left hanging, whichever way the run loop exits.
 *
 * Rows titled "(gap, ...)" assert what main does today, which breaks the
 * invariant. A PR that closes a gap turns its row red and must rewrite it to
 * assert the invariant.
 */

/**
 * A kernel over a real store, running two mocked vats that answer `bootstrap`
 * and nothing else. A vat sent `explode` asks for the termination of a vat
 * that does not exist, which throws out of the crank and kills the run loop.
 * One sent `explodeOnRelease` does the same once `release` is called.
 *
 * @returns The kernel, the root of each vat, the methods vats were sent, and
 * what lets `explodeOnRelease` go on.
 */
async function setUp() {
  const received: string[] = [];
  const released = makePromiseKit<void>();
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
          received.push(method);
          if (method === 'bootstrap' && message.result) {
            vatSyscall.handleSyscall([
              'resolve',
              [[message.result, false, kser('ready')]],
            ]);
          }
          if (method === 'explodeOnRelease') {
            await released.promise;
          }
          if (method === 'explode' || method === 'explodeOnRelease') {
            return {
              didDelivery: vatId,
              terminate: {
                vatId: asVatId('v404'),
                reject: true,
                info: makeFatalKernelError('INTERNAL_ERROR', 'exploded'),
              },
            };
          }
          return { didDelivery: vatId };
        },
        terminate: async (): Promise<void> => undefined,
        expectClose: (): void => undefined,
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
    waiterRoot: vatRootKrefs.waiter as KRef,
    doomedRoot: vatRootKrefs.doomed as KRef,
    received,
    release: () => released.resolve(),
  };
}

type Harness = Awaited<ReturnType<typeof setUp>>;
type Settlement = 'pending' | 'fulfilled' | 'rejected';

/**
 * Leave a caller waiting on a message its vat has taken but not answered, end
 * the run loop by `exit`, and report how the caller has settled.
 *
 * @param exit - How the run loop ends.
 * @returns How the caller has settled once the exit is done.
 */
async function waitThrough(
  exit: (harness: Harness) => Promise<void>,
): Promise<Settlement> {
  const harness = await setUp();
  let settlement: Settlement = 'pending';
  harness.kernel
    .queueMessage(harness.waiterRoot, 'work', [])
    .then(() => {
      settlement = 'fulfilled';
      return undefined;
    })
    .catch(() => {
      settlement = 'rejected';
    });
  await vi.waitFor(() => expect(harness.received).toContain('work'));
  await harness.kernel.getStatus();
  await delay(0);
  expect(settlement).toBe('pending');

  await exit(harness);
  // Flushes the caller's settlement; not a timeout.
  await delay(0);
  return settlement;
}

async function explodeInCrank({ kernel, doomedRoot }: Harness): Promise<void> {
  kernel.queueMessage(doomedRoot, 'explode', []).catch(() => undefined);
  await vi.waitFor(async () =>
    expect((await kernel.getStatus()).runLoop.state).toBe('failed'),
  );
}

describe('a queueMessage caller the vat has not answered', () => {
  it.each([
    [
      'is rejected when the run loop dies in a crank',
      explodeInCrank,
      'rejected',
    ],
    // Only because terminating the vat rejects the promises it decides;
    // reset does not fail the kernel's waiters itself.
    [
      'is rejected when the kernel is reset',
      async ({ kernel }: Harness): Promise<void> => kernel.reset(),
      'rejected',
    ],
    [
      'is left pending when the kernel stops (gap, #1105)',
      async ({ kernel }: Harness): Promise<void> => kernel.stop(),
      'pending',
    ],
    [
      'is left pending when the storage is cleared (gap, #1105)',
      async ({ kernel }: Harness): Promise<void> => kernel.clearStorage(),
      'pending',
    ],
  ] as const)('%s', async (_title, exit, settlement) => {
    expect(await waitThrough(exit)).toBe(settlement);
  });

  // No caller on main waits for a vat by id: `restartVat` hands back its
  // handle directly. #1096 queues the restart, giving that caller a wait.
  it.todo(
    'after reset, a vat that reuses a vat id is never handed to a caller from before the reset',
  );
});

describe('a queueMessage caller whose message waits for the open crank', () => {
  it('is rejected when that crank kills the run loop', async () => {
    const { kernel, waiterRoot, doomedRoot, received, release } = await setUp();
    kernel
      .queueMessage(doomedRoot, 'explodeOnRelease', [])
      .catch(() => undefined);
    await vi.waitFor(() => expect(received).toContain('explodeOnRelease'));

    const answered = kernel.queueMessage(waiterRoot, 'work', []);
    release();

    await expect(answered).rejects.toThrow(
      'Kernel run loop died; this message result will never be delivered',
    );
    expect(received).not.toContain('work');
  });
});
