import type { KernelDatabase } from '@metamask/kernel-store';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { Kernel, kunser } from '@metamask/ocap-kernel';
import type {
  ClusterConfig,
  IOListenerFactory,
  SystemSubclusterConfig,
} from '@metamask/ocap-kernel';

import { NodejsPlatformServices } from '../../src/kernel/PlatformServices.ts';

type MakeTestKernelOptions = {
  resetStorage?: boolean;
  mnemonic?: string;
  systemSubclusters?: SystemSubclusterConfig[];
  ioListenerFactory?: IOListenerFactory;
};

/**
 * Helper function to create a kernel with an existing database.
 * This avoids creating the database twice.
 *
 * @param kernelDatabase - The kernel database to use.
 * @param options - Options for the test kernel.
 * @param options.resetStorage - Whether to reset the storage (default: true).
 * @param options.mnemonic - Optional BIP39 mnemonic string.
 * @param options.systemSubclusters - Optional system subcluster configurations.
 * @param options.ioListenerFactory - Optional IO listener factory.
 * @returns The kernel.
 */
export async function makeTestKernel(
  kernelDatabase: KernelDatabase,
  options: MakeTestKernelOptions = {},
): Promise<Kernel> {
  const { resetStorage = true, ...kernelOptions } = options;

  const logger = new Logger('test-kernel');
  const platformServices = new NodejsPlatformServices({
    logger: logger.subLogger({ tags: ['platform-services'] }),
  });
  const kernel = await Kernel.make(platformServices, kernelDatabase, {
    resetStorage,
    ...kernelOptions,
    logger: logger.subLogger({ tags: ['kernel'] }),
  });

  return kernel;
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
  return bootstrapResult && kunser(bootstrapResult);
}
