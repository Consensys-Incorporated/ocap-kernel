import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { Logger } from '@metamask/logger';
import { Kernel } from '@metamask/ocap-kernel';
import type {
  IOListenerFactory,
  OnRunLoopFailure,
  SystemSubclusterConfig,
} from '@metamask/ocap-kernel';

import { NodejsPlatformServices } from './PlatformServices.ts';
import { makeIOListenerFactory } from '../io/index.ts';

/**
 * Result of {@link makeKernel}.
 */
export type MakeKernelResult = {
  kernel: Kernel;
  kernelDatabase: KernelDatabase;
};

/**
 * The main function for the kernel worker.
 *
 * @param options - The options for the kernel.
 * @param options.workerFilePath - The path to a file defining each vat worker's routine.
 * @param options.resetStorage - If true, clear kernel storage as part of setting up the kernel.
 * @param options.dbFilename - The filename of the SQLite database file.
 * @param options.logger - The logger to use for the kernel.
 * @param options.keySeed - Optional seed for libp2p key generation.
 * @param options.ioListenerFactory - Optional factory for creating IO listeners.
 * @param options.systemSubclusters - Optional system subcluster configurations.
 * @param options.onRunLoopFailure - Optional handler called if the kernel's run
 * loop dies, after which the kernel must be restarted.
 * @returns The kernel and its database.
 */
export async function makeKernel({
  workerFilePath,
  resetStorage = false,
  dbFilename,
  logger,
  keySeed,
  ioListenerFactory,
  systemSubclusters,
  onRunLoopFailure,
}: {
  workerFilePath?: string;
  resetStorage?: boolean;
  dbFilename?: string;
  logger?: Logger;
  keySeed?: string | undefined;
  ioListenerFactory?: IOListenerFactory;
  systemSubclusters?: SystemSubclusterConfig[];
  onRunLoopFailure?: OnRunLoopFailure;
}): Promise<MakeKernelResult> {
  const rootLogger = logger ?? new Logger('kernel-worker');
  const platformServicesClient = new NodejsPlatformServices({
    workerFilePath,
    logger: rootLogger.subLogger({ tags: ['platform-services-manager'] }),
  });

  // Initialize kernel store.
  const kernelDatabase = await makeSQLKernelDatabase({
    dbFilename,
    logger: rootLogger.subLogger({ tags: ['kernel-store'] }),
  });

  // Create and start kernel.
  const kernel = await Kernel.make(platformServicesClient, kernelDatabase, {
    resetStorage,
    logger: rootLogger.subLogger({ tags: ['kernel'] }),
    keySeed,
    ioListenerFactory: ioListenerFactory ?? makeIOListenerFactory(),
    ...(systemSubclusters ? { systemSubclusters } : {}),
    ...(onRunLoopFailure ? { onRunLoopFailure } : {}),
  });

  return { kernel, kernelDatabase };
}
