// eslint-disable-next-line spaced-comment
/// <reference types="vite/client" />

import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import type { KernelDatabase } from '@metamask/kernel-store';
import { stringify, waitUntilQuiescent } from '@metamask/kernel-utils';
import {
  Logger,
  makeArrayTransport,
  makeConsoleTransport,
} from '@metamask/logger';
import type { LogEntry } from '@metamask/logger';
import { Kernel, kunser } from '@metamask/ocap-kernel';
import type {
  ClusterConfig,
  OnRunLoopFailure,
  PlatformServices,
} from '@metamask/ocap-kernel';
import { afterAll, afterEach, vi } from 'vitest';

/**
 * The first run loop death seen since it was last reported, held here rather
 * than passed to a test because the crank that kills the loop is often one no
 * test is awaiting — a garbage collection or reap crank, or one that lands
 * after the last assertion. The hooks below are the only thing guaranteed to
 * look, so they are registered for every file that imports this module.
 */
let runLoopFailure: Error | undefined;

/**
 * Fail the current test if a kernel's run loop has died since the last check.
 */
function assertRunLoopAlive(): void {
  const failure = runLoopFailure;
  runLoopFailure = undefined;
  if (failure) {
    throw failure;
  }
}

/**
 * Kernels made by {@link makeTrackedKernel} since the last teardown. Each vat
 * is a worker thread of about 250 MB, so kernels left running exhaust a CI
 * runner's memory within a few files.
 */
const trackedKernels: {
  kernel: Kernel;
  platformServices: PlatformServices;
  kernelDatabase: KernelDatabase;
}[] = [];

/**
 * Databases closed through a tracked kernel. Tests share one database between
 * kernels to simulate a restart, so whether it is open is not a fact about any
 * one kernel.
 */
const closedDatabases = new WeakSet<KernelDatabase>();

/**
 * How long a teardown waits for `stop`, which waits out the crank in flight.
 * A test that timed out may have left a crank that never finishes; its workers
 * are terminated anyway, within the 10 s hook timeout.
 */
const STOP_TIMEOUT_MS = 5_000;

/**
 * Stop a kernel, or throw if it takes longer than allowed.
 *
 * @param kernel - The kernel.
 * @param timeoutMs - How long to wait.
 */
async function stopWithin(kernel: Kernel, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      kernel.stop(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error(`Kernel did not stop within ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop every kernel the test left running, then fail the test if any stop
 * failed or any run loop died, this teardown's stops included.
 */
async function tearDownKernels(): Promise<void> {
  const errors: unknown[] = [];
  for (const {
    kernel,
    platformServices,
    kernelDatabase,
  } of trackedKernels.splice(0)) {
    // A second `stop` throws on the closed database: expected for a kernel the
    // test stopped, or one whose database another kernel closed.
    const wasClosed = closedDatabases.has(kernelDatabase);
    try {
      await stopWithin(kernel, STOP_TIMEOUT_MS);
    } catch (error) {
      if (!wasClosed) {
        errors.push(error);
      }
    }
    // `stop` skips this if anything before it throws.
    try {
      await platformServices.terminateAll();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    assertRunLoopAlive();
  } catch (error) {
    errors.unshift(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Kernel teardown failed');
  }
}

afterEach(tearDownKernels);
afterAll(tearDownKernels);

/**
 * Kernel options under which reference count drift fails the test run.
 *
 * Drift is invisible to ordinary assertions until something gets collected out
 * from under a live holder, so the audit runs every crank. It reports by
 * throwing, which kills the run loop — and the kernel hands run loop death to
 * `onRunLoopFailure` rather than rethrowing it, deliberately, so that an
 * embedder can decide what to do. Without a handler a violation therefore
 * surfaces only if the killed crank happened to have a caller waiting on it.
 *
 * @returns Options to pass to `Kernel.make`.
 */
export function makeAuditedKernelOptions(): {
  auditRefCounts: true;
  onRunLoopFailure: OnRunLoopFailure;
} {
  return {
    auditRefCounts: true,
    // The first failure is the informative one: a dead loop cannot process
    // anything, so whatever follows is downstream of it.
    onRunLoopFailure: (failure: Error): void => {
      runLoopFailure ??= failure;
    },
  };
}

/**
 * `Kernel.make`, with the kernel stopped after the current test unless the test
 * stops it first.
 *
 * @param platformServices - As for `Kernel.make`.
 * @param kernelDatabase - As for `Kernel.make`.
 * @param options - As for `Kernel.make`.
 * @returns The new kernel.
 */
export async function makeTrackedKernel(
  platformServices: PlatformServices,
  kernelDatabase: KernelDatabase,
  options?: Parameters<typeof Kernel.make>[2],
): Promise<Kernel> {
  let kernel: Kernel;
  try {
    kernel = await Kernel.make(
      platformServices,
      {
        ...kernelDatabase,
        close: () => {
          closedDatabases.add(kernelDatabase);
          kernelDatabase.close();
        },
      },
      options,
    );
  } catch (error) {
    // A kernel that restarts vats has launched their workers by now.
    await platformServices.terminateAll().catch(() => undefined);
    throw error;
  }
  trackedKernels.push({ kernel, platformServices, kernelDatabase });
  return kernel;
}

/**
 * Construct a bundle path URL from a bundle name.
 *
 * @param bundleName - The name of the bundle.
 *
 * @returns a path string for the named bundle.
 */
export function getBundleSpec(bundleName: string): string {
  return new URL(`./vats/${bundleName}.bundle`, import.meta.url).toString();
}

/**
 * Run the set of test vats.
 *
 * @param kernel - The kernel to run in.
 * @param config - Subcluster configuration telling what vats to run.
 *
 * @returns the bootstrap result.
 */
export async function runTestVats(
  kernel: Kernel,
  config: ClusterConfig,
): Promise<unknown> {
  const { bootstrapResult } = await kernel.launchSubcluster(config);
  await waitUntilQuiescent();
  if (bootstrapResult === undefined) {
    throw Error(`this can't happen but eslint is stupid`);
  }
  return kunser(bootstrapResult);
}

/**
 * Send the `resume message to the root of one of the test vats.
 *
 * @param kernel - Our kernel.
 * @param rootRef - KRef of the object to which the message is sent.
 *
 * @returns the result returned from `resume`.
 */
export async function runResume(
  kernel: Kernel,
  rootRef: string,
): Promise<unknown> {
  const resumeResultRaw = await kernel.queueMessage(rootRef, 'resume', []);
  return kunser(resumeResultRaw);
}

/**
 * Handle all the boilerplate to set up a kernel instance.
 *
 * @param kernelDatabase - The database that will hold the persistent state.
 * @param resetStorage - If true, reset the database as part of setting up.
 * @param logger - The logger to use for the kernel.
 * @param workerFilePath - The path to the worker file to use for the vat workers.
 * @param platformServices - The platform services client to use for the kernel.
 * @param keySeed - Optional seed for libp2p key generation.
 *
 * @returns the new kernel instance.
 */
export async function makeKernel(
  kernelDatabase: KernelDatabase,
  resetStorage: boolean,
  logger: Logger,
  workerFilePath?: string,
  platformServices?: PlatformServices,
  keySeed?: string,
): Promise<Kernel> {
  const platformServicesConfig: { logger: Logger; workerFilePath?: string } = {
    logger: logger.subLogger({ tags: ['vat-worker-manager'] }),
  };
  if (workerFilePath) {
    platformServicesConfig.workerFilePath = workerFilePath;
  }
  const platformServicesClient =
    platformServices ?? new NodejsPlatformServices(platformServicesConfig);
  return await makeTrackedKernel(platformServicesClient, kernelDatabase, {
    resetStorage,
    logger,
    keySeed,
    ...makeAuditedKernelOptions(),
  });
}

/**
 * De-interleave various vats' output to squeeze out interprocess I/O
 * non-determinism in CI.
 *
 * @param logs - An array of log lines.
 *
 * @returns `logs` sorted by vat.
 */
export function sortLogs(logs: string[]): string[] {
  logs.sort((a: string, b: string): number => {
    const colonA = a.indexOf(':');
    if (colonA < 0) {
      return 0;
    }
    const prefixA = a.substring(0, colonA);
    const colonB = b.indexOf(':');
    if (colonB < 0) {
      return 0;
    }
    const prefixB = b.substring(0, colonB);
    return prefixA.localeCompare(prefixB);
  });
  return logs;
}

/**
 * Convert a list of log entries into a list of lines suitable for examination.
 *
 * @param entries - The list of log entries to convert.
 * @param withTags - The tags to filter by.
 *
 * @returns the relevant contents of `entries`, massaged for use.
 */
export function extractTestLogs(
  entries: LogEntry[],
  ...withTags: string[]
): string[] {
  const hasTag =
    withTags.length > 0
      ? (tags: string[]) => withTags.some((tag) => tags.includes(tag))
      : () => true;
  return entries
    .filter(({ tags }) => tags.includes('test') && hasTag(tags))
    .map(({ message }) => message ?? '')
    .filter((message) => message.length > 0);
}

/**
 * Parse a message body into a JSON object.
 *
 * @param body - The message body to parse.
 *
 * @returns The parsed JSON object, or the original body if parsing fails.
 */
export function parseReplyBody(body: string): unknown {
  try {
    return JSON.parse(body.slice(1));
  } catch {
    return body;
  }
}

/**
 * Debug the database.
 *
 * @param kernelDatabase - The database to debug.
 * @param logger - The logger to use for the database.
 */
export function logDatabase(
  kernelDatabase: KernelDatabase,
  logger: Logger = console as unknown as Logger,
): void {
  const result = kernelDatabase.executeQuery('SELECT * FROM kv');
  logger.log('kv result', stringify(result));
}

/**
 * Create a logger that records log entries in an array.
 *
 * @returns A logger that records log entries in an array.
 */
export const makeTestLogger = (): { logger: Logger; entries: LogEntry[] } => {
  const entries: LogEntry[] = [];
  const logger = new Logger({
    transports: [makeConsoleTransport(), makeArrayTransport(entries)],
  });
  return { logger, entries };
};

/**
 * Create a mock logger that can be used to spy on the logger methods.
 * Derived sub-loggers will invoke the parent logger methods directly.
 * The injectStream method is a no-op.
 *
 * @returns A mock logger.
 */
export const makeMockLogger = (): Logger => {
  const mockLogger = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    subLogger: vi.fn(() => mockLogger),
    injectStream: vi.fn(),
  } as unknown as Logger;
  return mockLogger;
};
