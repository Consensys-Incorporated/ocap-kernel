import { E } from '@endo/eventual-send';
import type { ERef } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import type { PromiseKit } from '@endo/promise-kit';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import { Logger } from '@metamask/logger';
import type {
  Baggage,
  ClusterConfig,
  SubclusterLaunchResult,
} from '@metamask/ocap-kernel';

import { makeBaggageStorageAdapter } from './storage/baggage-adapter.ts';
import { CapletController } from '../controllers/caplet/caplet-controller.ts';
import type { CapletControllerFacet } from '../controllers/caplet/index.ts';
import type { StorageAdapter } from '../controllers/storage/types.ts';

/**
 * Vat powers provided to the controller vat.
 */
type VatPowers = {
  logger?: Logger;
};

/**
 * Kernel facet interface for system vat operations.
 */
type KernelFacet = {
  launchSubcluster: (config: ClusterConfig) => Promise<SubclusterLaunchResult>;
  terminateSubcluster: (subclusterId: string) => Promise<void>;
  getPresence: (kref: string, iface?: string) => Promise<unknown>;
};

/**
 * Services provided to the controller vat.
 */
type BootstrapServices = {
  kernelFacet?: KernelFacet;
};

/**
 * Initialize the CapletController with the given kernelFacet.
 *
 * @param options - Initialization options.
 * @param options.kernelFacet - The kernel facet for kernel operations.
 * @param options.storageAdapter - The storage adapter for persistence.
 * @param options.logger - Logger for the vat.
 * @param options.resolve - Function to resolve the caplet facet promise.
 * @param options.reject - Function to reject the caplet facet promise.
 */
async function initializeCapletController(options: {
  kernelFacet: KernelFacet;
  storageAdapter: StorageAdapter;
  logger: Logger;
  resolve: (facet: CapletControllerFacet) => void;
  reject: (error: unknown) => void;
}): Promise<void> {
  const { kernelFacet, storageAdapter, logger, resolve, reject } = options;

  try {
    const capletFacet = await CapletController.make(
      { logger: logger.subLogger({ tags: ['caplet'] }) },
      {
        adapter: storageAdapter,
        launchSubcluster: async (
          config: ClusterConfig,
        ): Promise<SubclusterLaunchResult> =>
          E(kernelFacet).launchSubcluster(config),
        terminateSubcluster: async (subclusterId: string): Promise<void> =>
          E(kernelFacet).terminateSubcluster(subclusterId),
        getVatRoot: async (krefString: string): Promise<unknown> =>
          E(kernelFacet).getPresence(krefString, 'vatRoot'),
      },
    );
    resolve(capletFacet);
  } catch (error) {
    reject(error);
    throw error;
  }
}

/**
 * Controller vat for Omnium system services.
 * Hosts controllers with baggage-backed persistence.
 *
 * Methods are exposed directly on root (not nested) for queueMessage access.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param _parameters - Initialization parameters (unused).
 * @param baggage - Root of vat's persistent state.
 * @returns The root object for the new vat.
 */
export function buildRootObject(
  vatPowers: VatPowers,
  _parameters: unknown,
  baggage: Baggage,
): object {
  const logger = (vatPowers.logger ?? new Logger()).subLogger({
    tags: ['controller-vat'],
  });

  // Create baggage-backed storage adapter
  const storageAdapter = makeBaggageStorageAdapter(baggage);

  // Promise kit for the caplet controller facet
  const {
    promise: capletFacetP,
    resolve: resolveCapletFacet,
    reject: rejectCapletFacet,
  }: PromiseKit<CapletControllerFacet> = makePromiseKit<CapletControllerFacet>();

  // Restore kernelFacet from baggage if available (for resuscitation)
  const persistedKernelFacet: KernelFacet | undefined = baggage.has(
    'kernelFacet',
  )
    ? (baggage.get('kernelFacet') as KernelFacet)
    : undefined;

  // If we have a persisted kernelFacet, initialize the controller immediately
  if (persistedKernelFacet) {
    logger.info('Restoring controller from baggage');
    // Fire-and-forget: the promise kit will be resolved/rejected when initialization completes
    initializeCapletController({
      kernelFacet: persistedKernelFacet,
      storageAdapter,
      logger,
      resolve: resolveCapletFacet,
      reject: rejectCapletFacet,
    }).catch((error) => {
      logger.error('Failed to restore controller from baggage:', error);
      rejectCapletFacet(error);
    });
  }

  // Define delegating methods for caplet operations
  const capletMethods = defineMethods(capletFacetP, [
    'install',
    'uninstall',
    'list',
    'get',
    'getCapletRoot',
  ]);

  return makeDefaultExo('omnium-controllers', {
    /**
     * Initialize the controller vat with services from the kernel.
     *
     * @param _vats - Other vats in this subcluster (unused).
     * @param services - Services provided by the kernel.
     */
    async bootstrap(
      _vats: unknown,
      services: BootstrapServices,
    ): Promise<void> {
      logger.info('Bootstrap called');

      const { kernelFacet } = services;
      if (!kernelFacet) {
        throw new Error('kernelFacet service is required');
      }

      // Store in baggage for persistence across restarts
      baggage.init('kernelFacet', kernelFacet);

      await initializeCapletController({
        kernelFacet,
        storageAdapter,
        logger,
        resolve: resolveCapletFacet,
        reject: rejectCapletFacet,
      });
    },

    ...capletMethods,
  });
}

/**
 * Create delegating methods that forward calls to a source object via E().
 * Useful for exposing methods from a promise-based source on an exo.
 *
 * @param source - The source object (or promise) to delegate to.
 * @param methodNames - Array of method names to delegate.
 * @returns An object with delegating methods.
 */
function defineMethods(
  source: ERef<object>,
  methodNames: string[],
): Record<string, (...args: unknown[]) => unknown> {
  const output: Record<string, (...args: unknown[]) => unknown> = {};
  for (const methodName of methodNames) {
    output[methodName] = (...args: unknown[]) =>
      // oxlint-disable-next-line typescript/no-explicit-any
      (E(source) as any)[methodName](...args);
  }
  return output;
}
