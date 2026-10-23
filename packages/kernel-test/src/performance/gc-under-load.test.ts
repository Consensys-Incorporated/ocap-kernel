import type { KernelDatabase } from '@metamask/kernel-store';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  countKeys,
  describePlatform,
  envNumber,
  makeProfileKernel,
  mib,
  runClosedLoop,
  toMarkdown,
  writeReport,
} from './utils.ts';
import type { ProfileKernel } from './utils.ts';

// Live krefs held throughout, which collection must leave alone.
const KREFS = envNumber('GC_PERF_KREFS', 10_000);
const PAIRS = envNumber('GC_PERF_PAIRS', 4);
const ROUNDS = envNumber('GC_PERF_ROUNDS', 10);
const MESSAGES = envNumber('GC_PERF_MESSAGES', 1000);
const CONCURRENCY = envNumber('GC_PERF_CONCURRENCY', 16);
// Tokens each `churn` message mints and drops.
const CHURN = 10;
// A reap cascades: a holder's drop lets its minter collect, which only the
// minter's next reap reports, and so on.
const REAPS_PER_COLLECTION = 4;

type Workload = 'ping' | 'pingHeld' | 'churn' | 'fetch';

/**
 * What the kernel is holding on to.
 */
type Snapshot = {
  objects: number;
  promises: number;
  clistRows: number;
  vatstoreRows: number;
  kvRows: number;
  runQueue: number;
  gcActions: number;
};

const STORE_FIELDS = [
  'objects',
  'promises',
  'clistRows',
  'vatstoreRows',
  'kvRows',
] as const;

type RoundResult = {
  round: number;
  messages: number;
  /** In excess of the baseline, before collection. */
  natural: Snapshot;
  /** In excess of the baseline, after collection. */
  collected: Snapshot;
  rssBytes: number;
};

/**
 * Read one value from the kernel's KV table.
 *
 * @param kernelDatabase - The kernel's database.
 * @param key - The key.
 * @returns The value, if any.
 */
function getValue(
  kernelDatabase: KernelDatabase,
  key: string,
): string | undefined {
  const [row] = kernelDatabase.executeQuery(
    `SELECT value FROM kv WHERE key = '${key}'`,
  );
  return row?.value as string | undefined;
}

/**
 * Take stock of what the kernel holds.
 *
 * @param kernelDatabase - The kernel's database.
 * @returns The snapshot.
 */
function takeSnapshot(kernelDatabase: KernelDatabase): Snapshot {
  const [vatstore] = kernelDatabase.executeQuery(
    'SELECT count(*) AS n FROM kv_vatstore',
  );
  return {
    objects: countKeys(kernelDatabase, 'ko[0-9]*.owner'),
    promises: countKeys(kernelDatabase, 'kp[0-9]*.state'),
    clistRows: countKeys(kernelDatabase, 'v[0-9]*.c.*'),
    vatstoreRows: Number(vatstore?.n),
    kvRows: countKeys(kernelDatabase),
    runQueue:
      Number(getValue(kernelDatabase, 'queue.run.tail') ?? 0) -
      Number(getValue(kernelDatabase, 'queue.run.head') ?? 0),
    gcActions: (
      JSON.parse(getValue(kernelDatabase, 'gcActions') ?? '[]') as unknown[]
    ).length,
  };
}

/**
 * Subtract the store counts of one snapshot, scaled, from another's.
 *
 * @param snapshot - The snapshot.
 * @param base - What to subtract.
 * @param times - How many times to subtract it.
 * @returns The difference. Queues are carried over from `snapshot`.
 */
function subtract(snapshot: Snapshot, base: Snapshot, times = 1): Snapshot {
  const difference = { ...snapshot };
  for (const field of STORE_FIELDS) {
    difference[field] -= base[field] * times;
  }
  return difference;
}

/**
 * Reap every vat, as an embedder that wanted its garbage back would have to:
 * nothing in the kernel reaps vats on its own.
 *
 * @param profile - The kernel.
 */
async function collect(profile: ProfileKernel): Promise<void> {
  for (let reap = 0; reap < REAPS_PER_COLLECTION; reap += 1) {
    profile.kernel.reapVats();
    // Scheduling a reap does not wake the run loop, so give it a message to
    // wake for. The loop takes every pending reap before the message.
    expect(await profile.send(0, 'ping')).toBe('pong');
    await waitUntilQuiescent(100);
  }
}

/**
 * Render results as a Markdown table.
 *
 * @param results - One result per round.
 * @returns The table.
 */
function renderResults(results: RoundResult[]): string {
  const signed = (value: number): string =>
    value > 0 ? `+${value}` : String(value);
  const columns = (snapshot: Snapshot): string[] => [
    signed(snapshot.objects),
    signed(snapshot.promises),
    signed(snapshot.clistRows),
    signed(snapshot.vatstoreRows),
  ];
  return toMarkdown(
    [
      'round',
      'messages',
      'natural objects',
      'promises',
      'c-list rows',
      'vatstore rows',
      'collected objects',
      'promises',
      'c-list rows',
      'vatstore rows',
      'rss MiB',
    ],
    results.map((result) => [
      String(result.round),
      String(result.messages),
      ...columns(result.natural),
      ...columns(result.collected),
      mib(result.rssBytes),
    ]),
  );
}

describe('garbage collection under load', () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it.each<Workload>(['ping', 'pingHeld', 'churn', 'fetch'])(
    `returns the store to its baseline after ${ROUNDS} rounds of %s`,
    async (workload) => {
      const profile = await makeProfileKernel(PAIRS);
      ({ dispose } = profile);
      const { kernelDatabase, send, grow } = profile;
      const perPair = Math.ceil(KREFS / PAIRS);
      await grow(perPair);

      // Message `n` goes to pair `n % PAIRS`.
      const workloads: Record<Workload, (message: number) => Promise<void>> = {
        ping: async (message) => {
          expect(await send(message, 'ping')).toBe('pong');
        },
        pingHeld: async (message) => {
          expect(
            await send(message, 'pingHeld', [
              Math.floor(((message * 0.618_033_988_75) % 1) * perPair),
            ]),
          ).toBe('pong');
        },
        churn: async (message) => {
          expect(await send(message, 'churn', [CHURN])).toBe('pong');
        },
        // The token comes back to the kernel and is dropped here.
        fetch: async (message) => {
          expect(await send(message, 'fetch')).toBeDefined();
        },
      };

      await collect(profile);
      const baseline = takeSnapshot(kernelDatabase);
      // Collecting sends messages of its own, so measure what one collection
      // leaves behind on an idle kernel and discount it from every round.
      await collect(profile);
      const collectionCost = subtract(takeSnapshot(kernelDatabase), baseline);

      const results: RoundResult[] = [];
      const report = {
        date: new Date().toISOString(),
        platform: describePlatform(),
        workload,
        krefs: KREFS,
        pairs: PAIRS,
        concurrency: CONCURRENCY,
        baseline,
        collectionCost,
        results,
      };
      const stem = `gc-under-load-${workload}-${report.date.replaceAll(':', '-')}`;

      for (let round = 1; round <= ROUNDS; round += 1) {
        await runClosedLoop({
          send: workloads[workload],
          count: MESSAGES,
          concurrency: CONCURRENCY,
        });
        await waitUntilQuiescent(100);
        // `round` collections so far, counting the calibration.
        const natural = subtract(
          subtract(takeSnapshot(kernelDatabase), baseline),
          collectionCost,
          round,
        );
        await collect(profile);
        const collected = subtract(
          subtract(takeSnapshot(kernelDatabase), baseline),
          collectionCost,
          round + 1,
        );
        results.push({
          round,
          messages: round * MESSAGES,
          natural,
          collected,
          // Vat workers are threads of this process, so this covers them too.
          rssBytes: process.memoryUsage.rss(),
        });
        // Rewritten after every round, so that a failure in the next does not
        // lose the rounds already measured.
        await writeReport(stem, report, renderResults(results));
      }

      console.log(`[performance] ${stem}\n\n${renderResults(results)}\n`);

      // Collection takes nothing still held.
      expect(await send(0, 'pingHeld', [perPair - 1])).toBe('pong');
      const final = results.at(-1)?.collected;
      expect(final).toStrictEqual({
        objects: 0,
        promises: 0,
        clistRows: 0,
        vatstoreRows: 0,
        kvRows: 0,
        runQueue: 0,
        gcActions: 0,
      });
    },
    60 * 60 * 1000,
  );
});
