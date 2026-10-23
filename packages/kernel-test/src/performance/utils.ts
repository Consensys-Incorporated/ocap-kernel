import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { Logger } from '@metamask/logger';
import { kunser } from '@metamask/ocap-kernel';
import type { ClusterConfig, Kernel, KRef } from '@metamask/ocap-kernel';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeTrackedKernel } from '../utils.ts';

// Large enough to reach 1e6 in 100 messages, small enough that no one message
// carries an unrealistic number of slots.
const MINT_BATCH = 10_000;

const OUTPUT_DIR = new URL('../../logs/performance/', import.meta.url);

export type Stats = {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
};

/**
 * Read a number from the environment.
 *
 * @param name - The variable's name.
 * @param fallback - The value when it is unset.
 * @returns The number.
 */
export function envNumber(name: string, fallback: number): number {
  // oxlint-disable-next-line node/no-process-env
  return Number(process.env[name] ?? fallback);
}

/**
 * Read a comma-separated list of numbers from the environment.
 *
 * @param name - The variable's name.
 * @param fallback - The list when it is unset.
 * @returns The numbers.
 */
export function envNumbers(name: string, fallback: number[]): number[] {
  // oxlint-disable-next-line node/no-process-env
  const value = process.env[name];
  return value === undefined ? fallback : value.split(',').map(Number);
}

/**
 * Summarize a set of timings.
 *
 * @param samples - Timings in milliseconds.
 * @returns The summary statistics.
 */
export function summarize(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number): number =>
    sorted[
      Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))
    ] as number;
  return {
    min: at(0),
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: at(1),
    mean: sum(sorted) / sorted.length,
  };
}

/**
 * Add up some numbers.
 *
 * @param values - The numbers.
 * @returns Their total.
 */
export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Count rows in the kernel's KV table.
 *
 * @param kernelDatabase - The kernel's database.
 * @param glob - SQLite GLOB pattern for the keys to count.
 * @returns The number of matching rows.
 */
export function countKeys(kernelDatabase: KernelDatabase, glob = '*'): number {
  const [row] = kernelDatabase.executeQuery(
    `SELECT count(*) AS n FROM kv WHERE key GLOB '${glob}'`,
  );
  return Number(row?.n);
}

/**
 * A kernel to profile, with holder/minter vat pairs to send to.
 */
export type ProfileKernel = {
  kernel: Kernel;
  kernelDatabase: KernelDatabase;
  /** Bytes in the kernel's database file. */
  getDbBytes: () => Promise<number>;
  /** Send to the holder of pair `pair % pairs`, and unserialize the reply. */
  send: (pair: number, method: string, args?: unknown[]) => Promise<unknown>;
  /** How many tokens each pair's holder holds. */
  held: number[];
  /** Grow every pair's holdings to at least `perPair` tokens. */
  grow: (perPair: number) => Promise<void>;
  /** Delete the database. The kernel is stopped by the `utils.ts` teardown. */
  dispose: () => Promise<void>;
};

/**
 * Make a kernel with `pairs` holder/minter vat pairs, each in a subcluster of
 * its own. The holder imports and keeps every token its minter mints, so that
 * each token is a live kref.
 *
 * @param pairs - How many pairs to launch.
 * @returns The kernel and ways to drive it.
 */
export async function makeProfileKernel(pairs: number): Promise<ProfileKernel> {
  // A file rather than `:memory:`, so the profile includes disk I/O as a
  // deployed kernel sees it.
  const dbDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-perf-'));
  const dbFilename = path.join(dbDir, 'kernel.db');
  const kernelDatabase = await makeSQLKernelDatabase({ dbFilename });
  const logger = new Logger({ transports: [] });
  // Reference count auditing walks the whole store every crank, so it is left
  // off here.
  const kernel = await makeTrackedKernel(
    new NodejsPlatformServices({ logger }),
    kernelDatabase,
    { resetStorage: true, logger },
  );

  const config: ClusterConfig = {
    bootstrap: 'holder',
    vats: {
      holder: { bundleSpec: getBundleSpec('kref-holder-vat') },
      minter: { bundleSpec: getBundleSpec('kref-minter-vat') },
    },
  };
  const holders: KRef[] = [];
  for (let pair = 0; pair < pairs; pair += 1) {
    holders.push((await kernel.launchSubcluster(config)).rootKref);
  }

  const send = async (
    pair: number,
    method: string,
    args: unknown[] = [],
  ): Promise<unknown> =>
    kunser(
      await kernel.queueMessage(holders[pair % pairs] as KRef, method, args),
    );

  const held: number[] = Array.from({ length: pairs }, () => 0);
  const grow = async (perPair: number): Promise<void> => {
    // Round robin, so that every pair's c-lists grow together.
    while (held.some((count) => count < perPair)) {
      for (let pair = 0; pair < pairs; pair += 1) {
        const count = held[pair] as number;
        if (count < perPair) {
          held[pair] = (await send(pair, 'grow', [
            Math.min(MINT_BATCH, perPair - count),
          ])) as number;
        }
      }
    }
  };

  return {
    kernel,
    kernelDatabase,
    getDbBytes: async () => (await stat(dbFilename)).size,
    send,
    held,
    grow,
    dispose: async () => rm(dbDir, { recursive: true, force: true }),
  };
}

/**
 * Send `count` messages from `concurrency` clients at once, each sending its
 * next as soon as its last is answered.
 *
 * @param options - Options bag.
 * @param options.send - Sends message `n`, and checks the reply.
 * @param options.count - How many messages to send in all.
 * @param options.concurrency - How many clients send at once.
 * @returns The latency of each message and the time it took to send them all.
 */
export async function runClosedLoop({
  send,
  count,
  concurrency,
}: {
  send: (message: number) => Promise<void>;
  count: number;
  concurrency: number;
}): Promise<{ latencies: number[]; elapsedMs: number }> {
  const latencies: number[] = [];
  let next = 0;
  const client = async (): Promise<void> => {
    while (next < count) {
      const message = next;
      next += 1;
      const start = performance.now();
      await send(message);
      latencies.push(performance.now() - start);
    }
  };
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, client));
  return { latencies, elapsedMs: performance.now() - start };
}

/**
 * Describe the machine a profile ran on.
 *
 * @returns The platform description.
 */
export function describePlatform(): Record<string, unknown> {
  return {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    node: process.version,
    store: 'sqlite (nodejs, file)',
  };
}

/**
 * Render rows as a Markdown table.
 *
 * @param headers - The column headers.
 * @param rows - The cells, row by row.
 * @returns The table.
 */
export function toMarkdown(headers: string[], rows: string[][]): string {
  return [headers, headers.map(() => '---:'), ...rows]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
}

/**
 * Write a profile's report to `logs/performance/`, as JSON and as Markdown.
 *
 * @param stem - The file name, less its extension.
 * @param report - The report.
 * @param markdown - The report's table.
 */
export async function writeReport(
  stem: string,
  report: unknown,
  markdown: string,
): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    new URL(`${stem}.json`, OUTPUT_DIR),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(new URL(`${stem}.md`, OUTPUT_DIR), `${markdown}\n`);
}

/**
 * Format milliseconds for a table.
 *
 * @param value - Milliseconds.
 * @returns The formatted value.
 */
export const ms = (value: number): string => value.toFixed(3);

/**
 * Format bytes as MiB for a table.
 *
 * @param bytes - Bytes.
 * @returns The formatted value.
 */
export const mib = (bytes: number): string => (bytes / 2 ** 20).toFixed(1);

/**
 * Locate a bundle among the performance vats.
 *
 * @param name - The bundle's name.
 * @returns The bundle's URL.
 */
function getBundleSpec(name: string): string {
  return new URL(`./vats/${name}.bundle`, import.meta.url).toString();
}
