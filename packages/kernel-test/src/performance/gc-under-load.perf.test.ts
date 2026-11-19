import type { KernelDatabase } from '@metamask/kernel-store';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GC_PERF_CONCURRENCY as CONCURRENCY,
  GC_PERF_KREFS as KREFS,
  GC_PERF_MESSAGES as MESSAGES,
  GC_PERF_PAIRS as PAIRS,
  GC_PERF_ROUNDS as ROUNDS,
} from './constants.ts';
import thresholds from './gc-under-load.thresholds.json' with { type: 'json' };
import {
  countKeys,
  makeProfileKernel,
  mib,
  printTable,
  runClosedLoop,
  toMarkdown,
  writeTable,
} from './utils.ts';
import type { ProfileKernel } from './utils.ts';

const CHURN_TOKENS = 10;
// A reap cascades: a holder's drop lets its minter collect, which only the
// minter's next reap reports, and so on.
const REAPS_PER_COLLECTION = 4;

type Workload = keyof typeof thresholds;

const STORE_FIELDS = [
  'objects',
  'promises',
  'clistRows',
  'vatstoreRows',
  'kvRows',
] as const;

/**
 * What the kernel is holding on to.
 */
type Snapshot = Record<(typeof STORE_FIELDS)[number], number> & {
  runQueue: number;
  gcActions: number;
};

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

  it.each(Object.keys(thresholds) as Workload[])(
    `leaves no more than its threshold in the store after ${ROUNDS} rounds of %s`,
    async (workload) => {
      const profile = await makeProfileKernel(PAIRS);
      ({ dispose } = profile);
      const { kernel, kernelDatabase, send, sendRaw, grow } = profile;
      const perPair = Math.ceil(KREFS / PAIRS);
      await grow(perPair);

      const workloads: Record<Workload, (message: number) => Promise<void>> = {
        // A host's message, answered with data.
        ping: async (message) => {
          expect(await send(message, 'ping')).toBe('pong');
        },
        // The same, relayed by the holder to an object another vat exports.
        pingHeld: async (message) => {
          expect(
            await send(message, 'pingHeld', [
              Math.floor(((message * 0.618_033_988_75) % 1) * perPair),
            ]),
          ).toBe('pong');
        },
        // The holder mints objects in another vat, uses one and drops them.
        churn: async (message) => {
          expect(await send(message, 'churn', [CHURN_TOKENS])).toBe('pong');
        },
        // A host's message, answered with a new object the host gives up.
        fetch: async (message) => {
          const result = await sendRaw(message, 'fetch');
          expect(result.slots).toHaveLength(1);
          await kernel.releaseResult(result);
        },
      };

      await collect(profile);
      const baseline = takeSnapshot(kernelDatabase);
      // Collecting sends messages of its own, so measure what one collection
      // leaves behind on an idle kernel and discount it from every round.
      await collect(profile);
      const collectionCost = subtract(takeSnapshot(kernelDatabase), baseline);

      const results: RoundResult[] = [];
      const stem = `gc-under-load-${workload}`;

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
          rssBytes: process.memoryUsage.rss(),
        });
        await writeTable(stem, renderResults(results));
      }

      printTable(stem, renderResults(results));

      // Collection takes nothing still held.
      expect(await send(0, 'pingHeld', [perPair - 1])).toBe('pong');

      const { collected, messages } = results.at(-1) as RoundResult;
      const perMessage = Object.fromEntries(
        STORE_FIELDS.map((field) => [field, collected[field] / messages]),
      );
      const overThreshold = Object.fromEntries(
        STORE_FIELDS.filter(
          (field) => collected[field] > thresholds[workload][field] * messages,
        ).map((field) => [
          field,
          {
            perMessage: perMessage[field],
            threshold: thresholds[workload][field],
          },
        ]),
      );
      console.log(
        `[performance] ${stem} left per message ${JSON.stringify(perMessage)}`,
      );
      expect({
        overThreshold,
        runQueue: collected.runQueue,
        gcActions: collected.gcActions,
      }).toStrictEqual({ overThreshold: {}, runQueue: 0, gcActions: 0 });
    },
    60 * 60 * 1000,
  );
});
