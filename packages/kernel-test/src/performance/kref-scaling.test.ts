import { afterEach, describe, expect, it } from 'vitest';

import {
  countKeys,
  describePlatform,
  envNumber,
  envNumbers,
  makeProfileKernel,
  mib,
  ms,
  summarize,
  sum,
  toMarkdown,
  writeReport,
} from './utils.ts';
import type { Stats } from './utils.ts';

const MAX_EXPONENT = envNumber('KREF_PERF_MAX_EXPONENT', 6);
const SAMPLES = envNumber('KREF_PERF_SAMPLES', 50);
// How many holder/minter pairs to spread the krefs over, one kernel each.
const PAIR_COUNTS = envNumbers('KREF_PERF_PAIRS', [1, 4, 16, 64]);
const WARMUP_SAMPLES = 5;

type LevelResult = {
  vats: number;
  target: number;
  krefs: number;
  kvRows: number;
  dbBytes: number;
  rssBytes: number;
  growMsPerKref: number;
  kernelToVatMs: Stats;
  vatToVatMs: Stats;
};

/**
 * Time repeated sends of one message.
 *
 * @param send - Sends the message and resolves with the unserialized reply.
 * @param count - How many timed sends to make, after a warmup.
 * @returns The timing of each send, in milliseconds.
 */
async function timeSends(
  send: (sample: number) => Promise<unknown>,
  count: number,
): Promise<number[]> {
  for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) {
    expect(await send(sample)).toBe('pong');
  }
  const timings: number[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    const start = performance.now();
    const reply = await send(sample);
    timings.push(performance.now() - start);
    expect(reply).toBe('pong');
  }
  return timings;
}

/**
 * Render results as a Markdown table.
 *
 * @param results - One result per kref count.
 * @returns The table.
 */
function renderResults(results: LevelResult[]): string {
  return toMarkdown(
    [
      'vats',
      'target',
      'krefs',
      'kv rows',
      'db MiB',
      'rss MiB',
      'grow ms/kref',
      'kernel→vat p50',
      'p95',
      'vat→vat p50',
      'p95',
    ],
    results.map((result) => [
      String(result.vats),
      String(result.target),
      String(result.krefs),
      String(result.kvRows),
      mib(result.dbBytes),
      mib(result.rssBytes),
      ms(result.growMsPerKref),
      ms(result.kernelToVatMs.p50),
      ms(result.kernelToVatMs.p95),
      ms(result.vatToVatMs.p50),
      ms(result.vatToVatMs.p95),
    ]),
  );
}

describe('message delivery against kref count', () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it.each(PAIR_COUNTS)(
    `profiles delivery from 1e1 to 1e${MAX_EXPONENT} krefs over %i holder/minter pairs`,
    async (pairs) => {
      const profile = await makeProfileKernel(pairs);
      ({ dispose } = profile);
      const { kernelDatabase, send, held, grow } = profile;

      const results: LevelResult[] = [];
      const report = {
        date: new Date().toISOString(),
        platform: describePlatform(),
        samples: SAMPLES,
        results,
      };
      const stem = `kref-scaling-${pairs * 2}-vats`;

      for (let exponent = 1; exponent <= MAX_EXPONENT; exponent += 1) {
        const target = 10 ** exponent;
        const perPair = Math.ceil(target / pairs);

        const growStart = performance.now();
        const before = sum(held);
        await grow(perPair);
        const growMsPerKref =
          (performance.now() - growStart) / (sum(held) - before);

        // Sample `n` goes to pair `n % pairs`, so that every pair is measured.
        const kernelToVat = await timeSends(
          async (sample) => send(sample, 'ping'),
          SAMPLES,
        );
        // Spread the targets across everything a pair holds, so that the
        // lookups are not all served from the same corner of the c-lists.
        const stride = perPair / Math.ceil(SAMPLES / pairs);
        const vatToVat = await timeSends(
          async (sample) =>
            send(sample, 'pingHeld', [
              Math.floor((Math.floor(sample / pairs) + 0.5) * stride) % perPair,
            ]),
          SAMPLES,
        );

        const krefs = countKeys(kernelDatabase, 'ko*.owner');
        expect(krefs).toBeGreaterThanOrEqual(target);
        results.push({
          vats: pairs * 2,
          target,
          krefs,
          kvRows: countKeys(kernelDatabase),
          dbBytes: await profile.getDbBytes(),
          // Vat workers are threads of this process, so this covers them too.
          rssBytes: process.memoryUsage.rss(),
          growMsPerKref,
          kernelToVatMs: summarize(kernelToVat),
          vatToVatMs: summarize(vatToVat),
        });
        // Rewritten after every count, so that a vat running out of memory
        // at the next one does not lose the counts already measured.
        await writeReport(stem, report);
      }

      console.log(`[performance] ${stem}\n\n${renderResults(results)}\n`);

      expect(results).toHaveLength(MAX_EXPONENT);
    },
    // Reaching 1e6 krefs takes minutes.
    60 * 60 * 1000,
  );
});
