import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import {
  Logger,
  makeArrayTransport,
  makeConsoleTransport,
} from '@metamask/logger';
import type { LogEntry } from '@metamask/logger';
import { Kernel } from '@metamask/ocap-kernel';

import { filterTransports } from './utils.ts';

/**
 * Make a fresh kernel on an in-memory database, with its log entries captured
 * for the test to inspect and echoed to the console, less the ignored tags.
 *
 * @returns The kernel and its captured log entries.
 */
export const makeLocalKernel = async (): Promise<{
  kernel: Kernel;
  entries: LogEntry[];
}> => {
  const kernelDatabase = await makeSQLKernelDatabase({
    dbFilename: ':memory:',
  });

  const entries: LogEntry[] = [];
  const logger = new Logger({
    transports: [
      filterTransports(makeConsoleTransport(), makeArrayTransport(entries)),
    ],
  });

  const platformServices = new NodejsPlatformServices({
    logger: logger.subLogger({ tags: ['vat-worker-manager'] }),
  });

  const kernel = await Kernel.make(platformServices, kernelDatabase, {
    resetStorage: true,
    logger,
  });
  return { kernel, entries };
};
