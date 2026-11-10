import { delay } from '@metamask/kernel-utils';
import { describe, it, expect, vi } from 'vitest';

import type { Kernel } from './Kernel.ts';
import { explosion, setUpRealKernel, watch } from '../test/real-kernel.ts';
import type { RealKernel as Harness } from '../test/real-kernel.ts';

/*
 * Invariant M2: each kind of caller waiting on queued work is rejected, not
 * left hanging, whichever way the run loop exits.
 */

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
  const harness = await setUpRealKernel();
  const settlement = watch(
    harness.kernel.queueMessage(harness.waiterRoot, 'work', []),
  );
  await vi.waitFor(() => expect(harness.received).toContain('v1:work'));
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
 * crank, so `exit` takes effect before anything queued behind it.
 *
 * @param exit - The host call.
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
      // The vat's termination rejects the promise it decides before the reset
      // abandons the rest.
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
      const harness = await setUpRealKernel();
      harness.kernel
        .queueMessage(harness.waiterRoot, 'stall', [])
        .catch(() => undefined);
      await vi.waitFor(() => expect(harness.received).toContain('v1:stall'));
      const settlement = watch(makeRequest(harness));
      await delay(0);
      expect(settlement()).toBe('pending');

      await exit(harness);
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
    const harness = await setUpRealKernel();
    harness.kernel
      .queueMessage(harness.waiterRoot, 'stall', [])
      .catch(() => undefined);
    await vi.waitFor(() => expect(harness.received).toContain('v1:stall'));
    const settlement = watch(
      harness.kernel.queueMessage(harness.doomedRoot, 'work', []),
    );

    await exit(harness);
    await delay(0);

    expect({
      settlement: settlement(),
      received: harness.received,
    }).toStrictEqual({
      settlement: reason,
      received: ['v1:bootstrap', 'v1:stall'],
    });
  });
});
