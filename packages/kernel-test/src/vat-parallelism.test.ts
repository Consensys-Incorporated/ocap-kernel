import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import type { Kernel, KRef } from '@metamask/ocap-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import { getBundleSpec, makeKernel, makeTestLogger } from './utils.ts';

const VAT_COUNT = 4;
const SPIN_ITERATIONS = 12_000_000;
const SLEEP_MS = 300;

const vatNames = Array.from({ length: VAT_COUNT }, (_, i) => `vat${i}`);

const testSubcluster = {
  bootstrap: 'vat0',
  forceReset: true,
  vats: Object.fromEntries(
    vatNames.map((name) => [
      name,
      {
        bundleSpec: getBundleSpec('parallelism-vat'),
        globals: ['setTimeout' as const],
      },
    ]),
  ),
};

// Each vat runs in its own worker thread, and the crank only carries messages
// between them, so k vats doing the same work shouldn't take k times as long as
// one. Compute can't beat the CPU, so its speed-up depends on the cores
// available, and only its upper bound is pinned. Waits use no CPU, so k vats
// waiting should take about as long as one on any hardware.
describe('vat parallelism', () => {
  let kernel: Kernel;
  let roots: KRef[];

  /**
   * Send one message to each of the given vats at once, and time how long it
   * takes for all of them to answer.
   *
   * @param targets - The root krefs to send to.
   * @param method - The method to call on each.
   * @param arg - Its argument.
   * @returns The elapsed time in milliseconds.
   */
  const timeAll = async (
    targets: KRef[],
    method: 'spin' | 'sleep',
    arg: number,
  ): Promise<number> => {
    const start = performance.now();
    await Promise.all(
      targets.map(async (target) => kernel.queueMessage(target, method, [arg])),
    );
    return performance.now() - start;
  };

  // Launching the workers takes seconds.
  beforeEach(async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    kernel = await makeKernel(kernelDatabase, true, makeTestLogger().logger);
    const { vatRootKrefs } = await kernel.launchSubcluster(testSubcluster);
    roots = vatNames.map((name) => vatRootKrefs[name] as KRef);
    await waitUntilQuiescent();
    // Warm each worker's JIT so the first timed run isn't the slow one.
    await timeAll(roots, 'spin', SPIN_ITERATIONS);
  }, 60_000);

  it('takes no longer for k vats computing at once than for each alone, summed', async () => {
    let each = 0;
    for (const root of roots) {
      each += await timeAll([root], 'spin', SPIN_ITERATIONS);
    }
    const all = await timeAll(roots, 'spin', SPIN_ITERATIONS);

    expect(
      all / each,
      `each vat alone ${each.toFixed(0)} ms in total, ${VAT_COUNT} at once ${all.toFixed(0)} ms`,
    ).toBeLessThan(1.25);
  });

  it('takes about as long for k vats waiting at once as for one', async () => {
    const one = await timeAll(roots.slice(0, 1), 'sleep', SLEEP_MS);
    const all = await timeAll(roots, 'sleep', SLEEP_MS);

    expect(
      all / one,
      `one vat ${one.toFixed(0)} ms, ${VAT_COUNT} vats ${all.toFixed(0)} ms`,
    ).toBeLessThan(1.5);
  });
});
