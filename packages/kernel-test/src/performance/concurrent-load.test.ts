import { afterEach, describe, expect, it } from 'vitest';

import {
  countKeys,
  describePlatform,
  envNumber,
  envNumbers,
  makeProfileKernel,
  mib,
  ms,
  runClosedLoop,
  summarize,
  toMarkdown,
  writeReport,
} from './utils.ts';
import type { Stats } from './utils.ts';

const KREFS = envNumber('LOAD_PERF_KREFS', 100_000);
// How many holder/minter pairs to spread the krefs and the load over, one
// kernel each.
const PAIR_COUNTS = envNumbers('LOAD_PERF_PAIRS', [1, 8, 64]);
const CONCURRENCIES = envNumbers('LOAD_PERF_CONCURRENCY', [1, 4, 16, 64, 256]);
const MESSAGES = envNumber('LOAD_PERF_MESSAGES', 1000);
const WARMUP_MESSAGES = 20;

type Route = 'kernel→vat' | 'vat→vat';

type CellResult = {
  vats: number;
  route: Route;
  concurrency: number;
  messages: number;
  messagesPerSecond: number;
  latencyMs: Stats;
  rssBytes: number;
};

/**
 * Render results as a Markdown table.
 *
 * @param results - One result per route and concurrency.
 * @returns The table.
 */
function renderResults(results: CellResult[]): string {
  return toMarkdown(
    [
      'vats',
      'route',
      'concurrency',
      'msgs/s',
      'p50 ms',
      'p95 ms',
      'p99 ms',
      'max ms',
      'rss MiB',
    ],
    results.map((result) => [
      String(result.vats),
      result.route,
      String(result.concurrency),
      result.messagesPerSecond.toFixed(1),
      ms(result.latencyMs.p50),
      ms(result.latencyMs.p95),
      ms(result.latencyMs.p99),
      ms(result.latencyMs.max),
      mib(result.rssBytes),
    ]),
  );
}

describe('message delivery under concurrent load', () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it.each(PAIR_COUNTS)(
    `profiles throughput and latency at ${KREFS} krefs over %i holder/minter pairs`,
    async (pairs) => {
      const profile = await makeProfileKernel(pairs);
      ({ dispose } = profile);
      const { kernelDatabase, send, grow } = profile;
      const perPair = Math.ceil(KREFS / pairs);
      await grow(perPair);
      expect(
        countKeys(kernelDatabase, 'ko[0-9]*.owner'),
      ).toBeGreaterThanOrEqual(KREFS);

      // A vat→vat message pings a token scattered across the pair's holdings,
      // by the golden ratio, so that consecutive messages do not hit
      // neighbouring c-list entries.
      const routes: Record<Route, (message: number) => Promise<void>> = {
        'kernel→vat': async (message) => {
          expect(await send(message, 'ping')).toBe('pong');
        },
        'vat→vat': async (message) => {
          expect(
            await send(message, 'pingHeld', [
              Math.floor(((message * 0.618_033_988_75) % 1) * perPair),
            ]),
          ).toBe('pong');
        },
      };

      const results: CellResult[] = [];
      const report = {
        date: new Date().toISOString(),
        platform: describePlatform(),
        krefs: KREFS,
        messages: MESSAGES,
        results,
      };
      const stem = `concurrent-load-${pairs * 2}-vats`;

      for (const [route, routeSend] of Object.entries(routes) as [
        Route,
        (message: number) => Promise<void>,
      ][]) {
        for (const concurrency of CONCURRENCIES) {
          await runClosedLoop({
            send: routeSend,
            count: WARMUP_MESSAGES,
            concurrency: Math.min(concurrency, WARMUP_MESSAGES),
          });
          const { latencies, elapsedMs } = await runClosedLoop({
            send: routeSend,
            count: MESSAGES,
            concurrency,
          });
          results.push({
            vats: pairs * 2,
            route,
            concurrency,
            messages: MESSAGES,
            messagesPerSecond: (MESSAGES / elapsedMs) * 1000,
            latencyMs: summarize(latencies),
            rssBytes: process.memoryUsage.rss(),
          });
          await writeReport(stem, report);
        }
      }

      console.log(`[performance] ${stem}\n\n${renderResults(results)}\n`);

      expect(results).toHaveLength(2 * CONCURRENCIES.length);
    },
    60 * 60 * 1000,
  );
});
