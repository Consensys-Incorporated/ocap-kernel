import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { Logger } from '@metamask/logger';
import { kunser } from '@metamask/ocap-kernel';
import type { ClusterConfig, Kernel, KRef } from '@metamask/ocap-kernel';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTrackedKernel } from '../utils.ts';

// oxlint-disable-next-line node/no-process-env
const MAX_EXPONENT = Number(process.env.KREF_PERF_MAX_EXPONENT ?? 7);
// oxlint-disable-next-line node/no-process-env
const SAMPLES = Number(process.env.KREF_PERF_SAMPLES ?? 50);
const WARMUP_SAMPLES = 5;
// Large enough to reach 1e7 in 1000 messages, small enough that no one message
// carries an unrealistic number of slots.
const MINT_BATCH = 10_000;

const OUTPUT_DIR = new URL('../../logs/performance/', import.meta.url);

type Stats = {
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
};

type LevelResult = {
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
 * Summarize a set of timings.
 *
 * @param samples - Timings in milliseconds.
 * @returns The summary statistics.
 */
function summarize(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!;
  return {
    min: sorted[0]!,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1)!,
    mean: sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length,
  };
}

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
 * Count rows in the kernel's KV table.
 *
 * @param kernelDatabase - The kernel's database.
 * @param glob - SQLite GLOB pattern for the keys to count.
 * @returns The number of matching rows.
 */
function countKeys(kernelDatabase: KernelDatabase, glob = '*'): number {
  const [row] = kernelDatabase.executeQuery(
    `SELECT count(*) AS n FROM kv WHERE key GLOB '${glob}'`,
  );
  return Number(row?.n);
}

/**
 * Render results as a Markdown table.
 *
 * @param results - One result per kref count.
 * @returns The table.
 */
function toMarkdown(results: LevelResult[]): string {
  const ms = (value: number): string => value.toFixed(3);
  const mib = (bytes: number): string => (bytes / 2 ** 20).toFixed(1);
  return [
    '| target | krefs | kv rows | db MiB | rss MiB | grow ms/kref | kernel→vat p50 | p95 | vat→vat p50 | p95 |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.map(
      (result) =>
        `| ${result.target} | ${result.krefs} | ${result.kvRows} | ${mib(result.dbBytes)} | ${mib(result.rssBytes)} | ${ms(result.growMsPerKref)} | ${ms(result.kernelToVatMs.p50)} | ${ms(result.kernelToVatMs.p95)} | ${ms(result.vatToVatMs.p50)} | ${ms(result.vatToVatMs.p95)} |`,
    ),
  ].join('\n');
}

const getBundleSpec = (name: string): string =>
  new URL(`./vats/${name}.bundle`, import.meta.url).toString();

describe('message delivery against kref count', () => {
  let dbDir: string | undefined;

  afterEach(async () => {
    if (dbDir) {
      await rm(dbDir, { recursive: true, force: true });
    }
  });

  it(
    `profiles delivery from 1e1 to 1e${MAX_EXPONENT} krefs`,
    async () => {
      // A file rather than `:memory:`, so the profile includes disk I/O as a
      // deployed kernel sees it.
      dbDir = await mkdtemp(path.join(os.tmpdir(), 'kref-scaling-'));
      const dbFilename = path.join(dbDir, 'kernel.db');
      const kernelDatabase = await makeSQLKernelDatabase({ dbFilename });
      const logger = new Logger({ transports: [] });
      // Reference count auditing walks the whole store every crank, so it is
      // left off here.
      const kernel: Kernel = await makeTrackedKernel(
        new NodejsPlatformServices({ logger }),
        kernelDatabase,
        { resetStorage: true, logger },
      );

      const config: ClusterConfig = {
        bootstrap: 'holder',
        forceReset: true,
        vats: {
          holder: { bundleSpec: getBundleSpec('kref-holder-vat') },
          minter: { bundleSpec: getBundleSpec('kref-minter-vat') },
        },
      };
      const { rootKref: holder } = await kernel.launchSubcluster(config);
      const send = async (
        method: string,
        args: unknown[] = [],
      ): Promise<unknown> =>
        kunser(await kernel.queueMessage(holder as KRef, method, args));

      const results: LevelResult[] = [];
      const report = {
        date: new Date().toISOString(),
        platform: {
          os: `${os.platform()} ${os.release()}`,
          arch: os.arch(),
          cpu: os.cpus()[0]?.model,
          cpus: os.cpus().length,
          memoryBytes: os.totalmem(),
          node: process.version,
          store: 'sqlite (nodejs, file)',
        },
        samples: SAMPLES,
        results,
      };
      const stem = `kref-scaling-${report.date.replaceAll(':', '-')}`;
      await mkdir(OUTPUT_DIR, { recursive: true });

      let held = 0;
      for (let exponent = 1; exponent <= MAX_EXPONENT; exponent += 1) {
        const target = 10 ** exponent;

        const growStart = performance.now();
        const grown = target - held;
        while (held < target) {
          held = (await send('grow', [
            Math.min(MINT_BATCH, target - held),
          ])) as number;
        }
        const growMsPerKref = (performance.now() - growStart) / grown;

        const kernelToVat = await timeSends(async () => send('ping'), SAMPLES);
        // Spread the targets across everything held, so that the lookups are
        // not all served from the same corner of the c-lists.
        const stride = held / SAMPLES;
        const vatToVat = await timeSends(
          async (sample) =>
            send('pingHeld', [Math.floor((sample + 0.5) * stride)]),
          SAMPLES,
        );

        const krefs = countKeys(kernelDatabase, 'ko*.owner');
        expect(krefs).toBeGreaterThanOrEqual(target);
        results.push({
          target,
          krefs,
          kvRows: countKeys(kernelDatabase),
          dbBytes: (await stat(dbFilename)).size,
          // Vat workers are threads of this process, so this covers them too.
          rssBytes: process.memoryUsage.rss(),
          growMsPerKref,
          kernelToVatMs: summarize(kernelToVat),
          vatToVatMs: summarize(vatToVat),
        });
        // Rewritten after every count, so that a vat running out of memory
        // at the next one does not lose the counts already measured.
        await writeFile(
          new URL(`${stem}.json`, OUTPUT_DIR),
          `${JSON.stringify(report, null, 2)}\n`,
        );
        await writeFile(
          new URL(`${stem}.md`, OUTPUT_DIR),
          `${toMarkdown(results)}\n`,
        );
      }

      console.log(`[performance] ${stem}\n\n${toMarkdown(results)}\n`);

      expect(results).toHaveLength(MAX_EXPONENT);
    },
    // Reaching 1e7 krefs takes most of this.
    60 * 60 * 1000,
  );
});
