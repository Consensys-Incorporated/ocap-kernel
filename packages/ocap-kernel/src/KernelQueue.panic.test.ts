import type { KernelDatabase } from '@metamask/kernel-store';
import { delay } from '@metamask/kernel-utils';
import { describe, it, expect, vi } from 'vitest';

import { setUpRealKernel, watch } from '../test/real-kernel.ts';

/*
 * Whole cranks: a fault that is the kernel's own, here a store write that
 * fails, stops the kernel and rolls back the crank it happened in, rather than
 * be blamed on a vat or committed without the write.
 */

const DEAD_RESULT =
  'Kernel run loop died; this message result will never be delivered';
const DEAD_WORK = 'Kernel run loop died; this work will never be carried out';

/**
 * Fail the kernel's writes that `matches` picks, as a full disk does.
 *
 * @param kernelDatabase - The kernel's database.
 * @param matches - Which writes fail.
 * @returns The error they fail with.
 */
function failWrites(
  kernelDatabase: KernelDatabase,
  matches: (key: string, value: string) => boolean,
): Error {
  const fault = new Error('database or disk is full');
  const { kernelKVStore } = kernelDatabase;
  const set = kernelKVStore.set.bind(kernelKVStore);
  vi.spyOn(kernelKVStore, 'set').mockImplementation((key, value) => {
    if (matches(key, value)) {
      throw fault;
    }
    set(key, value);
  });
  return fault;
}

/**
 * Count the items on the store's run queue.
 *
 * @param kernelDatabase - The kernel's database.
 * @returns How many there are.
 */
function runQueueLength(kernelDatabase: KernelDatabase): number {
  const { get } = kernelDatabase.kernelKVStore;
  return Number(get('queue.run.head')) - Number(get('queue.run.tail'));
}

/**
 * Wait for the run loop to die.
 *
 * @param kernel - The kernel.
 * @param kernel.getStatus - How to ask it.
 */
async function waitForDeath(kernel: {
  getStatus: () => Promise<{ runLoop: { state: string } }>;
}): Promise<void> {
  await vi.waitFor(async () =>
    expect((await kernel.getStatus()).runLoop.state).toBe('failed'),
  );
  // Flushes the callers' settlements; not a timeout.
  await delay(0);
}

describe('a store fault', () => {
  it("in a syscall's write stops the kernel and leaves the vat as it was (#1166)", async () => {
    const { kernel, kernelDatabase, doomedRoot, terminated } =
      await setUpRealKernel();
    const fault = failWrites(
      kernelDatabase,
      (key, value) => /^kp\d+\.state$/u.test(key) && value !== 'unresolved',
    );
    const settlement = watch(kernel.queueMessage(doomedRoot, 'answer', []));

    await waitForDeath(kernel);

    expect({
      runLoop: (await kernel.getStatus()).runLoop,
      settlement: settlement(),
      terminated,
      queued: runQueueLength(kernelDatabase),
    }).toStrictEqual({
      runLoop: {
        state: 'failed',
        error: 'Kernel panic: syscall resolve from vat v2 failed',
        detail: expect.stringContaining(fault.message),
      },
      settlement: DEAD_RESULT,
      terminated: [],
      queued: 1,
    });
  });

  it("writing a vat's state stops the kernel rather than fail the message (#1167)", async () => {
    const { kernel, kernelDatabase, waiterRoot, terminated } =
      await setUpRealKernel();
    const fault = new Error('database or disk is full');
    vi.spyOn(kernelDatabase, 'makeVatStore').mockReturnValue({
      getKVData: () => [],
      updateKVData: () => {
        throw fault;
      },
    });
    const settlement = watch(kernel.queueMessage(waiterRoot, 'remember', []));

    await waitForDeath(kernel);

    expect({
      runLoop: (await kernel.getStatus()).runLoop,
      settlement: settlement(),
      terminated,
      queued: runQueueLength(kernelDatabase),
    }).toStrictEqual({
      runLoop: {
        state: 'failed',
        error: fault.message,
        detail: expect.any(String),
      },
      settlement: DEAD_RESULT,
      terminated: [],
      queued: 1,
    });
  });

  it('in a termination stops the kernel and leaves the termination queued (#1172)', async () => {
    const { kernel, kernelDatabase, doomedId, terminated } =
      await setUpRealKernel();
    const fault = failWrites(
      kernelDatabase,
      (key) => key === 'vats.terminated',
    );
    const settlement = watch(kernel.terminateVat(doomedId));

    await waitForDeath(kernel);

    expect({
      runLoop: (await kernel.getStatus()).runLoop,
      settlement: settlement(),
      // The worker is stopped first, and the next start relaunches it.
      terminated,
      recorded: kernelDatabase.kernelKVStore.get('vats.terminated'),
      queued: runQueueLength(kernelDatabase),
    }).toStrictEqual({
      runLoop: {
        state: 'failed',
        error: fault.message,
        detail: expect.any(String),
      },
      settlement: DEAD_WORK,
      terminated: ['v2'],
      recorded: '[]',
      queued: 1,
    });
  });
});
