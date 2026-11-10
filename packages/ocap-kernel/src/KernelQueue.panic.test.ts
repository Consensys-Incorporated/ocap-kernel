import type { KernelDatabase } from '@metamask/kernel-store';
import { delay } from '@metamask/kernel-utils';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, onTestFinished, vi } from 'vitest';

import { setUpRealKernel, watch } from '../test/real-kernel.ts';

/**
 * Fail the kernel's writes that `matches` picks, as a full disk does.
 *
 * @param kernelDatabase - The kernel's database.
 * @param matches - Which writes fail.
 */
function failWrites(
  kernelDatabase: KernelDatabase,
  matches: (key: string, value: string) => boolean,
): void {
  const { kernelKVStore } = kernelDatabase;
  const set = kernelKVStore.set.bind(kernelKVStore);
  vi.spyOn(kernelKVStore, 'set').mockImplementation((key, value) => {
    if (matches(key, value)) {
      throw new Error('database or disk is full');
    }
    set(key, value);
  });
}

/**
 * Read every row the kernel keeps.
 *
 * @param kernelDatabase - The kernel's database.
 * @returns The rows of its tables.
 */
function dumpStore(kernelDatabase: KernelDatabase): Record<string, unknown> {
  return {
    kv: kernelDatabase.executeQuery('SELECT key, value FROM kv ORDER BY key'),
    vatState: kernelDatabase.executeQuery(
      'SELECT vatID, key, value FROM kv_vatstore ORDER BY vatID, key',
    ),
  };
}

describe('a store fault in a syscall', () => {
  it('stops the kernel, rolls the store back, and the next start delivers the message again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'panic-'));
    onTestFinished(async () => rm(dir, { recursive: true, force: true }));
    const dbFilename = join(dir, 'store.db');
    const first = await setUpRealKernel({ dbFilename });
    failWrites(
      first.kernelDatabase,
      (key, value) => /^kp\d+\.state$/u.test(key) && value !== 'unresolved',
    );
    const settlement = watch(
      first.kernel.queueMessage(first.doomedRoot, 'answer', []),
    );
    // Queued and not yet taken: the crank starts once this turn ends.
    const before = dumpStore(first.kernelDatabase);

    await vi.waitFor(async () =>
      expect((await first.kernel.getStatus()).runLoop.state).toBe('failed'),
    );
    await delay(0);
    const { runLoop } = await first.kernel.getStatus();
    const after = dumpStore(first.kernelDatabase);
    await first.kernel.stop();
    vi.restoreAllMocks();
    const second = await setUpRealKernel({ dbFilename });

    expect({ runLoop, settlement: settlement(), after }).toStrictEqual({
      runLoop: {
        state: 'failed',
        error: 'Kernel panic: syscall resolve from vat v2 failed',
        detail: expect.stringContaining('database or disk is full'),
      },
      settlement:
        'Kernel run loop died; this message result will never be delivered',
      after: before,
    });
    await vi.waitFor(() => expect(second.received).toContain('v2:answer'));
    await second.kernel.stop();
  });
});
