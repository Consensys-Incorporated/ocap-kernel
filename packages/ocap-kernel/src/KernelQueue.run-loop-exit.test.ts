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
  VatId,
} from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { VatSyscall } from './vats/VatSyscall.ts';
import { asVatId } from '../test/branded.ts';

/*
 * Invariant M2: each kind of caller waiting on queued work is rejected, not
 * left hanging, whichever way the run loop exits.
 */

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
    kernel
      .getVats()
      .find(
        ({ config }) =>
          'sourceSpec' in config && config.sourceSpec === sourceSpec,
      )?.id as VatId;
  return {
    kernel,
    waiterRoot: vatRootKrefs.waiter as KRef,
    doomedRoot: vatRootKrefs.doomed as KRef,
    waiterId: vatIdOf('waiter.js'),
    doomedId: vatIdOf('doomed.js'),
    received,
    release: (result: CrankResult): void => releaseStall?.(result),
  };
}

type Harness = Awaited<ReturnType<typeof setUp>>;
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

/**
 * Leave a caller waiting on a message its vat has taken but not answered, end
 * the run loop by `exit`, and report how the caller has settled.
 *
 * @param exit - How the run loop ends.
 * @returns How the caller has settled once the exit is done.
 */
async function waitThrough(
  exit: (harness: Harness) => Promise<void>,
): Promise<string> {
  const harness = await setUp();
  const settlement = watch(
    harness.kernel.queueMessage(harness.waiterRoot, 'work', []),
  );
  await vi.waitFor(() => expect(harness.received).toContain('work'));
  await harness.kernel.getStatus();
  await delay(0);
  expect(settlement()).toBe('pending');

  await exit(harness);
  // Flushes the caller's settlement; not a timeout.
  await delay(0);
  return settlement();
}

async function explodeInCrank({ kernel, doomedRoot }: Harness): Promise<void> {
  kernel.queueMessage(doomedRoot, 'explode', []).catch(() => undefined);
  await vi.waitFor(async () =>
    expect((await kernel.getStatus()).runLoop.state).toBe('failed'),
  );
}

/**
 * End the crank a vat sent `stall` holds open by killing the run loop.
 *
 * @param harness - The kernel and the stalled crank's `release`.
 */
async function explodeStalledCrank(harness: Harness): Promise<void> {
  harness.release(explosion(harness.waiterId));
  await vi.waitFor(async () =>
    expect((await harness.kernel.getStatus()).runLoop.state).toBe('failed'),
  );
}

/**
 * Begin `exit` while a crank a vat sent `stall` holds open, then end that
 * crank, so the loop stops before it takes anything queued behind it.
 *
 * @param exit - The control-plane call.
 * @returns The exit, for a harness.
 */
function afterStalledCrank(
  exit: (kernel: Kernel) => Promise<void>,
): (harness: Harness) => Promise<void> {
  return async ({ kernel, release, waiterId }) => {
    const exiting = exit(kernel);
    await delay(0);
    release({ didDelivery: waiterId });
    await exiting;
  };
}

const RESET = 'Kernel was reset; queued work was abandoned';
const CLEARED = 'Kernel storage was cleared; queued work was abandoned';
const DEAD_RESULT =
  'Kernel run loop died; this message result will never be delivered';

describe('a queueMessage caller the vat has not answered', () => {
  it.each([
    ['the run loop dies in a crank', explodeInCrank, DEAD_RESULT],
    [
      'the kernel is reset',
      async ({ kernel }: Harness): Promise<void> => kernel.reset(),
      '[KERNEL:VAT_TERMINATED] Vat was deleted.',
    ],
    [
      'the kernel stops',
      async ({ kernel }: Harness): Promise<void> => kernel.stop(),
      'Kernel was stopped before this message was answered; one still queued is delivered on its next start',
    ],
    [
      'the storage is cleared',
      async ({ kernel }: Harness): Promise<void> => kernel.clearStorage(),
      CLEARED,
    ],
  ] as const)('is rejected when %s', async (_title, exit, reason) => {
    expect(await waitThrough(exit)).toBe(reason);
  });
});

describe('a restartVat or terminateVat caller the run loop has not reached', () => {
  const exits = [
    [
      'the run loop dies in a crank',
      explodeStalledCrank,
      'Kernel run loop died; this work will never be carried out',
    ],
    [
      'the kernel is reset',
      afterStalledCrank(async (kernel) => kernel.reset()),
      RESET,
    ],
    [
      'the kernel stops',
      afterStalledCrank(async (kernel) => kernel.stop()),
      'Kernel was stopped before answering; terminations already queued still take effect on its next start, restarts do not',
    ],
    [
      'the storage is cleared',
      afterStalledCrank(async (kernel) => kernel.clearStorage()),
      CLEARED,
    ],
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
      exits.map(
        ([exitTitle, exit, reason]) =>
          [request, exitTitle, makeRequest, exit, reason] as const,
      ),
    ),
  )(
    'a %s caller is rejected when %s',
    async (_request, _exit, makeRequest, exit, reason) => {
      const harness = await setUp();
      harness.kernel
        .queueMessage(harness.waiterRoot, 'stall', [])
        .catch(() => undefined);
      await vi.waitFor(() => expect(harness.received).toContain('stall'));
      const settlement = watch(makeRequest(harness));
      await delay(0);
      expect(settlement()).toBe('pending');

      await exit(harness);
      // Flushes the caller's settlement; not a timeout.
      await delay(0);
      expect(settlement()).toBe(reason);
    },
  );
});

describe('a queueMessage caller whose message waits for the open crank', () => {
  it.each([
    ['that crank kills the run loop', explodeStalledCrank, DEAD_RESULT],
    [
      'the kernel is reset',
      afterStalledCrank(async (kernel) => kernel.reset()),
      RESET,
    ],
    [
      'the kernel stops',
      afterStalledCrank(async (kernel) => kernel.stop()),
      'Kernel was stopped before this message was answered; one still queued is delivered on its next start',
    ],
    [
      'the storage is cleared',
      afterStalledCrank(async (kernel) => kernel.clearStorage()),
      CLEARED,
    ],
  ] as const)('is rejected when %s', async (_title, exit, reason) => {
    const harness = await setUp();
    harness.kernel
      .queueMessage(harness.waiterRoot, 'stall', [])
      .catch(() => undefined);
    await vi.waitFor(() => expect(harness.received).toContain('stall'));
    const settlement = watch(
      harness.kernel.queueMessage(harness.doomedRoot, 'work', []),
    );

    await exit(harness);
    await delay(0);

    expect({
      settlement: settlement(),
      received: harness.received,
    }).toStrictEqual({ settlement: reason, received: ['bootstrap', 'stall'] });
  });
});
