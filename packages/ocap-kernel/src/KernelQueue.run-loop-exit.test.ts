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
  VatId,
} from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { VatSyscall } from './vats/VatSyscall.ts';

/*
 * Invariant M2: each kind of caller waiting on queued work is rejected, not
 * left hanging, whichever way the run loop exits.
 *
 * Rows titled "(gap, ...)" assert what main does today, which breaks the
 * invariant. A PR that closes a gap turns its row red and must rewrite it to
 * assert the invariant.
 */

/**
 * A crank result asking for the termination of a vat that does not exist,
 * which throws out of the crank and kills the run loop.
 *
 * @param vatId - The vat whose delivery this is.
 * @returns The crank result.
 */
function explosion(vatId: string): CrankResult {
  return {
    didDelivery: vatId as VatId,
    terminate: {
      vatId: 'v404',
      reject: true,
      info: makeFatalKernelError('INTERNAL_ERROR', 'exploded'),
    },
  };
}

/**
 * A kernel over a real store, running two mocked vats that answer `bootstrap`
 * and nothing else. A vat sent `explode` returns {@link explosion}. A vat sent
 * `stall` holds its crank open until the test calls `release`.
 *
 * @returns The kernel, the root and ID of each vat, the methods vats were
 * sent, and `release`, which ends a stalled crank with the given result.
 */
async function setUp() {
  const received: string[] = [];
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
          received.push(method);
          if (method === 'bootstrap' && message.result) {
            vatSyscall.handleSyscall([
              'resolve',
              [[message.result, false, kser('ready')]],
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
  const vatIdOf = (sourceSpec: string): VatId =>
    kernel.getVats().find(({ config }) => config.sourceSpec === sourceSpec)
      ?.id as VatId;
  return {
    kernel,
    waiterRoot: vatRootKrefs.waiter as string,
    doomedRoot: vatRootKrefs.doomed as string,
    waiterId: vatIdOf('waiter.js'),
    doomedId: vatIdOf('doomed.js'),
    received,
    release: (result: CrankResult): void => releaseStall?.(result),
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

describe('a queueMessage caller the vat has not answered', () => {
  it.each([
    [
      'is rejected when the run loop dies in a crank',
      async ({ kernel, doomedRoot }: Harness): Promise<void> => {
        kernel.queueMessage(doomedRoot, 'explode', []).catch(() => undefined);
        await vi.waitFor(async () =>
          expect((await kernel.getStatus()).runLoop.state).toBe('failed'),
        );
      },
      'rejected',
    ],
    [
      'is rejected when the kernel is reset',
      async ({ kernel }: Harness): Promise<void> => kernel.reset(),
      'rejected',
    ],
    [
      'is rejected when the kernel stops',
      async ({ kernel }: Harness): Promise<void> => kernel.stop(),
      'rejected',
    ],
    [
      'is rejected when the storage is cleared',
      async ({ kernel }: Harness): Promise<void> => kernel.clearStorage(),
      'rejected',
    ],
  ] as const)('%s', async (_title, exit, settlement) => {
    expect(await waitThrough(exit)).toBe(settlement);
  });
});

describe('a restartVat or terminateVat caller the run loop has not reached', () => {
  const exits = [
    [
      'the run loop dies in a crank',
      async ({ kernel, release, waiterId }: Harness): Promise<void> => {
        release(explosion(waiterId));
        await vi.waitFor(async () =>
          expect((await kernel.getStatus()).runLoop.state).toBe('failed'),
        );
      },
    ],
    ...(
      [
        ['the kernel is reset', async (kernel: Kernel) => kernel.reset()],
        ['the kernel stops', async (kernel: Kernel) => kernel.stop()],
        [
          'the storage is cleared',
          async (kernel: Kernel) => kernel.clearStorage(),
        ],
      ] as const
    ).map(
      ([title, exit]) =>
        [
          title,
          async ({ kernel, release, waiterId }: Harness): Promise<void> => {
            const exiting = exit(kernel);
            // The exit is waiting for the stalled crank to end, so the loop
            // stops before it can carry out the request.
            await delay(0);
            release({ didDelivery: waiterId });
            await exiting;
          },
        ] as const,
    ),
  ] as const;
  const requests = [
    [
      'restartVat',
      async ({ kernel, doomedId }: Harness): Promise<unknown> =>
        kernel.restartVat(doomedId),
    ],
    [
      'terminateVat',
      async ({ kernel, doomedId }: Harness): Promise<unknown> =>
        kernel.terminateVat(doomedId),
    ],
  ] as const;

  it.each(
    requests.flatMap(([request, makeRequest]) =>
      exits.map(([exitTitle, exit]) => [request, exitTitle, makeRequest, exit]),
    ),
  )(
    'a %s caller is rejected when %s',
    async (_request, _exit, makeRequest, exit) => {
      const harness = await setUp();
      harness.kernel
        .queueMessage(harness.waiterRoot, 'stall', [])
        .catch(() => undefined);
      await vi.waitFor(() => expect(harness.received).toContain('stall'));
      let settlement: Settlement = 'pending';
      makeRequest(harness)
        .then(() => {
          settlement = 'fulfilled';
          return undefined;
        })
        .catch(() => {
          settlement = 'rejected';
        });
      await delay(0);
      expect(settlement).toBe('pending');

      await exit(harness);
      // Flushes the caller's settlement; not a timeout.
      await delay(0);
      expect(settlement).toBe('rejected');
    },
  );
});
