import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import type { Kernel, KRef } from '@metamask/ocap-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import { getBundleSpec, makeKernel, makeTestLogger } from './utils.ts';

const VAT_COUNT = 4;
const SPIN_ITERATIONS = 12_000_000;
const SLEEP_MS = 300;
const TRIALS = 3;

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

  /**
   * Time the same sends several times and keep the fastest. Load from other
   * test files only ever adds time, and a spin lasts about 100 ms, so one
   * unlucky trial would otherwise decide the ratio.
   *
   * @param args - The arguments to {@link timeAll}.
   * @returns The fastest elapsed time in milliseconds.
   */
  const timeFastest = async (
    ...args: Parameters<typeof timeAll>
  ): Promise<number> => {
    let fastest = Infinity;
    for (let trial = 0; trial < TRIALS; trial++) {
      fastest = Math.min(fastest, await timeAll(...args));
    }
    return fastest;
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
    // Trials alternate between the two measurements, so a burst of load from
    // elsewhere is as likely to land on either.
    const eachFastest = roots.map(() => Infinity);
    let all = Infinity;
    for (let trial = 0; trial < TRIALS; trial++) {
      for (const [index, root] of roots.entries()) {
        eachFastest[index] = Math.min(
          eachFastest[index] as number,
          await timeAll([root], 'spin', SPIN_ITERATIONS),
        );
      }
      all = Math.min(all, await timeAll(roots, 'spin', SPIN_ITERATIONS));
    }
    const each = eachFastest.reduce((sum, time) => sum + time, 0);

    expect(
      all / each,
      `each vat alone ${each.toFixed(0)} ms in total, ${VAT_COUNT} at once ${all.toFixed(0)} ms`,
    ).toBeLessThan(1.25);
  });

  it('takes about as long for k vats waiting at once as for one', async () => {
    const one = await timeFastest(roots.slice(0, 1), 'sleep', SLEEP_MS);
    const all = await timeFastest(roots, 'sleep', SLEEP_MS);

    expect(
      all / one,
      `one vat ${one.toFixed(0)} ms, ${VAT_COUNT} vats ${all.toFixed(0)} ms`,
    ).toBeLessThan(1.5);
  });
});
