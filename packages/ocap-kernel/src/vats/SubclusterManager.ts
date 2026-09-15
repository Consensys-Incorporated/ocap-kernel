import type { CapData } from '@endo/marshal';
import { SubclusterNotFoundError } from '@metamask/kernel-errors';
import { Logger } from '@metamask/logger';

import type { IOManager } from '../io/IOManager.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import type { VatManager } from './VatManager.ts';
import { kslot, kunser, makeKernelError } from '../liveslots/kernel-marshal.ts';
import type { SlotValue } from '../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  VatId,
  KRef,
  SubclusterId,
  ClusterConfig,
  Subcluster,
  SubclusterLaunchResult,
  SystemSubclusterConfig,
} from '../types.ts';
import { isClusterConfig } from '../types.ts';
import { Fail } from '../utils/assert.ts';

type SubclusterManagerOptions = {
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
  vatManager: VatManager;
  getKernelService: (
    name: string,
  ) => { kref: KRef; systemOnly: boolean } | undefined;
  queueMessage: (
    target: KRef,
    method: string,
    args: unknown[],
  ) => Promise<CapData<KRef>>;
  ioManager?: IOManager;
  logger?: Logger;
};

/**
 * Manages subcluster operations including creation and termination.
 */
export class SubclusterManager {
  /** Storage holding the kernel's persistent state */
  readonly #kernelStore: KernelStore;

  /** The kernel's run queue */
  readonly #kernelQueue: KernelQueue;

  /** The vat manager for vat operations */
  readonly #vatManager: VatManager;

  /** Function to get kernel services */
  readonly #getKernelService: (
    name: string,
  ) => { kref: KRef; systemOnly: boolean } | undefined;

  /** Function to queue messages */
  readonly #queueMessage: (
    target: KRef,
    method: string,
    args: unknown[],
  ) => Promise<CapData<KRef>>;

  /** Logger for diagnostic output */
  readonly #logger: Logger;

  /** Optional IO manager for creating/destroying IO channels */
  readonly #ioManager: IOManager | undefined;

  /** Stores bootstrap root krefs of launched system subclusters */
  readonly #systemSubclusterRoots: Map<string, KRef> = new Map();

  /**
   * Creates a new SubclusterManager instance.
   *
   * @param options - Constructor options.
   * @param options.kernelStore - The kernel's persistent state store.
   * @param options.kernelQueue - The kernel's message queue for scheduling deliveries.
   * @param options.vatManager - Manager for creating and managing vat instances.
   * @param options.getKernelService - Function to retrieve a kernel service by its kref.
   * @param options.queueMessage - Function to queue messages for delivery to targets.
   * @param options.ioManager - Optional IO manager for IO channel lifecycle.
   * @param options.logger - Optional logger for diagnostic output.
   */
  constructor({
    kernelStore,
    kernelQueue,
    vatManager,
    getKernelService,
    queueMessage,
    ioManager,
    logger,
  }: SubclusterManagerOptions) {
    this.#kernelStore = kernelStore;
    this.#kernelQueue = kernelQueue;
    this.#vatManager = vatManager;
    this.#getKernelService = getKernelService;
    this.#queueMessage = queueMessage;
    this.#ioManager = ioManager;
    this.#logger = logger ?? new Logger('SubclusterManager');
    harden(this);
  }

  /**
   * Launches a sub-cluster of vats.
   *
   * @param config - Configuration object for sub-cluster.
   * @param options - Launch options.
   * @param options.isSystem - Whether this is a system subcluster. System
   * subclusters may access restricted kernel services. Defaults to `false`.
   * @returns A promise for the subcluster ID, bootstrap root kref, and
   * bootstrap result.
   */
  async launchSubcluster(
    config: ClusterConfig,
    { isSystem = false }: { isSystem?: boolean } = {},
  ): Promise<SubclusterLaunchResult> {
    await this.#kernelQueue.waitForCrank();
    // It would fail at the bootstrap message anyway, but only refusing here fails
    // before spawning a worker per vat, which the catch below leaks.
    this.#kernelQueue.assertRunLoopAlive('launch a subcluster');
    isClusterConfig(config) || Fail`invalid cluster config`;
    if (!config.vats[config.bootstrap]) {
      Fail`invalid bootstrap vat name ${config.bootstrap}`;
    }
    const subclusterId = this.#kernelStore.addSubcluster(config);

    try {
      // Create IO channels before validating services so that IO service
      // names are registered and discoverable by #validateServices.
      if (config.io) {
        if (!this.#ioManager) {
          throw new Error(
            'Cluster config declares IO channels but no IO channel factory was provided to the kernel',
          );
        }
        await this.#ioManager.createChannels(subclusterId, config.io);
      }

      this.#validateServices(config, isSystem);
      const { rootKref, bootstrapResult, vatRootKrefs } =
        await this.#launchVatsForSubcluster(subclusterId, config);
      return { subclusterId, rootKref, bootstrapResult, vatRootKrefs };
    } catch (error) {
      // Roll back: terminate any vats that launched successfully, then clean
      // up IO channels and the persisted subcluster record.
      // Each step is best-effort — cleanup errors must not mask the original
      // failure.
      try {
        const vatIds = this.#kernelStore.getSubclusterVats(subclusterId);
        for (const vatId of vatIds.reverse()) {
          await this.#terminateVatQuietly(vatId);
        }
      } catch (vatCleanupError) {
        this.#logger.error(
          'Error during vat cleanup on failed launch:',
          vatCleanupError,
        );
      }
      try {
        if (this.#ioManager) {
          await this.#ioManager.destroyChannels(subclusterId);
        }
      } catch (cleanupError) {
        this.#logger.error(
          'Error during IO cleanup on failed launch:',
          cleanupError,
        );
      }
      this.#kernelStore.deleteSubcluster(subclusterId);
      throw error;
    }
  }

  /**
   * Terminate one vat as part of cleanup, absorbing any failure.
   *
   * Teardown of a single vat must not strand its siblings: a caller cleaning
   * up several vats keeps going after one of them fails to die, and reports
   * the failure rather than propagating it over whatever error prompted the
   * cleanup in the first place.
   *
   * A vat with neither a handle nor a record is skipped. That covers a vat
   * whose launch failed before either existed; one the store still lists is
   * retired on its records alone.
   *
   * @param vatId - The id of the vat to terminate.
   * @returns True if the vat is gone.
   */
  async #terminateVatQuietly(vatId: VatId): Promise<boolean> {
    if (
      !this.#vatManager.hasVat(vatId) &&
      !this.#kernelStore.isVatActive(vatId)
    ) {
      return true;
    }
    try {
      await this.#vatManager.terminateVat(vatId);
      this.#vatManager.collectGarbage();
      return true;
    } catch (error) {
      this.#logger.error(
        `Error terminating vat ${vatId} during cleanup:`,
        error,
      );
      return false;
    }
  }

  /**
   * Terminates a named sub-cluster of vats.
   *
   * @param subclusterId - The id of the subcluster to terminate.
   * @returns A promise that resolves when termination is complete.
   */
  async terminateSubcluster(subclusterId: SubclusterId): Promise<void> {
    // The run loop is what ends each member now, so a dead one cannot end any
    // of them — and the record deletion below must not go ahead regardless.
    this.#kernelQueue.assertRunLoopAlive('terminate a subcluster');
    if (!this.#kernelStore.getSubcluster(subclusterId)) {
      throw new SubclusterNotFoundError(subclusterId);
    }

    // Clean up system subcluster mapping if this is a system subcluster
    const mappings = this.#kernelStore.getAllSystemSubclusterMappings();
    for (const [name, mappedSubclusterId] of mappings) {
      if (mappedSubclusterId === subclusterId) {
        this.#systemSubclusterRoots.delete(name);
        this.#kernelStore.deleteSystemSubclusterMapping(name);
        this.#logger.info(`Cleaned up system subcluster mapping "${name}"`);
        break;
      }
    }

    // Persisted membership, so a vat the kernel has no handle for is still
    // retired rather than stranding the rest of the subcluster.
    const vatIdsToTerminate = this.#kernelStore.getSubclusterVats(subclusterId);
    const survivors: VatId[] = [];
    for (const vatId of vatIdsToTerminate.reverse()) {
      if (!(await this.#terminateVatQuietly(vatId))) {
        survivors.push(vatId);
      }
    }

    // Destroy IO channels after terminating vats so that any queued
    // messages targeting IO service krefs are drained first.
    try {
      if (this.#ioManager) {
        await this.#ioManager.destroyChannels(subclusterId);
      }
    } catch (error) {
      this.#logger.error('Error during IO cleanup on termination:', error);
    }
    if (survivors.length > 0) {
      // `deleteSubcluster` drops every member's vat-to-subcluster mapping, and
      // `getVatSubcluster` is a `Fail` — so deleting the record over a live
      // member breaks `getStatus` for the whole kernel from then on.
      throw Error(
        `subcluster ${subclusterId} still has running vats: ${survivors.join(', ')}`,
      );
    }
    // Each member's termination resolves from inside its own crank, so this
    // waits rather than writing the record into whichever one is open.
    await this.#kernelQueue.waitForCrank();
    this.#kernelStore.deleteSubcluster(subclusterId);
  }

  /**
   * Retrieves a subcluster by its ID.
   *
   * @param subclusterId - The id of the subcluster.
   * @returns The subcluster, or undefined if not found.
   */
  getSubcluster(subclusterId: SubclusterId): Subcluster | undefined {
    return this.#kernelStore.getSubcluster(subclusterId);
  }

  /**
   * Gets all subclusters.
   *
   * @returns An array of subcluster information records.
   */
  getSubclusters(): Subcluster[] {
    return this.#kernelStore.getSubclusters();
  }

  /**
   * Checks if a vat belongs to a specific subcluster.
   *
   * @param vatId - The ID of the vat to check.
   * @param subclusterId - The ID of the subcluster to check against.
   * @returns True if the vat belongs to the specified subcluster, false otherwise.
   */
  isVatInSubcluster(vatId: VatId, subclusterId: SubclusterId): boolean {
    return this.#kernelStore.getVatSubcluster(vatId) === subclusterId;
  }

  /**
   * Gets all vat IDs that belong to a specific subcluster.
   *
   * @param subclusterId - The ID of the subcluster to get vats for.
   * @returns An array of vat IDs that belong to the specified subcluster.
   */
  getSubclusterVats(subclusterId: SubclusterId): VatId[] {
    return this.#kernelStore.getSubclusterVats(subclusterId);
  }

  /**
   * Deletes a subcluster and its vat data from storage without terminating running vats.
   * This is used for cleaning up orphaned subclusters before vats are started.
   *
   * @param subclusterId - The ID of the subcluster to delete.
   */
  deleteSubcluster(subclusterId: SubclusterId): void {
    const subcluster = this.#kernelStore.getSubcluster(subclusterId);
    if (!subcluster) {
      return;
    }

    // Delete vat configs and mark vats as terminated so their data will be cleaned up
    for (const vatId of Object.values(subcluster.vats)) {
      // These vats are not running, so `stopVat` never gets to release the pin
      // its `launchVat` took in the incarnation that did run them. Without this
      // the root's count never reaches zero and the pin outlives the vat it
      // was taken for.
      this.#vatManager.releaseVatRootPin(vatId);
      this.#kernelStore.deleteVatConfig(vatId);
      this.#kernelStore.markVatAsTerminated(vatId);
    }

    // Delete the subcluster record
    this.#kernelStore.deleteSubcluster(subclusterId);
  }

  /**
   * Validates that all requested services exist and are accessible.
   *
   * @param config - The cluster configuration to validate.
   * @param isSystem - Whether this is a system subcluster.
   * @throws If a requested service does not exist or is system-only and the
   * subcluster is not a system subcluster.
   */
  #validateServices(config: ClusterConfig, isSystem: boolean): void {
    if (!config.services) {
      return;
    }
    const ioNames = config.io
      ? new Set(Object.keys(config.io))
      : new Set<string>();
    for (const name of config.services) {
      // IO services are registered by IOManager with scoped names
      if (ioNames.has(name)) {
        continue;
      }
      const service = this.#getKernelService(name);
      if (!service || (service.systemOnly && !isSystem)) {
        throw Error(`no registered kernel service '${name}'`);
      }
    }
  }

  /**
   * Launches all vats for a subcluster and sets up their bootstrap connections.
   *
   * @param subclusterId - The ID of the subcluster to launch vats for.
   * @param config - The configuration for the subcluster.
   * @returns A promise for the bootstrap root kref and bootstrap result.
   */
  async #launchVatsForSubcluster(
    subclusterId: SubclusterId,
    config: ClusterConfig,
  ): Promise<{
    rootKref: KRef;
    bootstrapResult: CapData<KRef> | undefined;
    vatRootKrefs: Record<string, KRef>;
  }> {
    const vatEntries = Object.entries(config.vats);

    const services: Record<string, SlotValue> = {};
    const ioNames = config.io
      ? new Set(Object.keys(config.io))
      : new Set<string>();

    // Collect all service names: explicit services plus IO channel names
    const allServiceNames = new Set([...(config.services ?? []), ...ioNames]);

    for (const name of allServiceNames) {
      // IO services are registered under scoped names to avoid collisions
      const lookupName = ioNames.has(name)
        ? `io:${subclusterId}:${name}`
        : name;
      const possibleService = this.#getKernelService(lookupName);
      if (possibleService) {
        const { kref } = possibleService;
        services[name] = kslot(kref);
      } else {
        throw Error(`no registered kernel service '${lookupName}'`);
      }
    }

    // Launch all vats concurrently. getNextVatId() runs synchronously before
    // each launchVat's first await, so vat-ID allocation order is deterministic.
    const launchResults = await Promise.allSettled(
      vatEntries.map(async ([vatName, vatConfig]) =>
        this.#vatManager.launchVat(vatConfig, vatName, subclusterId),
      ),
    );

    // If the bootstrap vat itself failed to launch, throw immediately.
    const bootstrapIdx = vatEntries.findIndex(
      ([name]) => name === config.bootstrap,
    );
    // bootstrapIdx is guaranteed ≥ 0 because launchSubcluster validates that
    // config.vats[config.bootstrap] exists. The undefined guard satisfies tsc.
    const bootstrapLaunchResult = launchResults[bootstrapIdx];
    if (bootstrapLaunchResult === undefined) {
      throw Fail`no launch result for bootstrap vat '${config.bootstrap}'`;
    }
    if (bootstrapLaunchResult.status === 'rejected') {
      throw bootstrapLaunchResult.reason;
    }
    const rootKref = bootstrapLaunchResult.value;

    // Build the roots map. Succeeded vats receive real ko<N> refs; failed peer
    // vats receive an immediately-rejected kernel promise so bootstrap can
    // observe the failure via E(roots.peer).method() pipelining.
    const rootsEntries: [string, SlotValue][] = [];
    const vatRootKrefsEntries: [string, KRef][] = [];
    let firstPeerFailure: Error | undefined;
    for (let i = 0; i < vatEntries.length; i++) {
      const vatEntry = vatEntries[i];
      const result = launchResults[i];
      if (vatEntry === undefined || result === undefined) {
        throw Fail`missing entry at index ${i}`;
      }
      const [vatName] = vatEntry;
      // Reject vat names that shadow Object.prototype built-ins (__proto__,
      // constructor, etc.) before using them as property keys.
      !(vatName in Object.prototype) || Fail`invalid vat name '${vatName}'`;
      if (result.status === 'fulfilled') {
        rootsEntries.push([vatName, kslot(result.value, 'vatRoot')]);
        vatRootKrefsEntries.push([vatName, result.value]);
      } else {
        // launchVat always wraps failures in new Error(...), so reason is an Error
        const peerError =
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason));
        firstPeerFailure ??= peerError;
        const [kpid] = this.#kernelStore.initKernelPromise();
        this.#kernelStore.setPromiseDecider(kpid, 'kernel');
        this.#kernelQueue.resolvePromises('kernel', [
          [kpid, true, makeKernelError('VAT_TERMINATED', peerError.message)],
        ]);
        rootsEntries.push([vatName, kslot(kpid)]);
      }
    }
    const roots = Object.fromEntries(rootsEntries);
    const vatRootKrefs = Object.fromEntries(vatRootKrefsEntries);

    const bootstrapResult = await this.#queueMessage(rootKref, 'bootstrap', [
      roots,
      services,
    ]);
    const unserialized = kunser(bootstrapResult);
    if (unserialized instanceof Error) {
      throw unserialized;
    }

    // If any peer vats failed to launch, propagate after bootstrap has had a
    // chance to observe and handle the failures.
    if (firstPeerFailure !== undefined) {
      throw firstPeerFailure;
    }

    return { rootKref, bootstrapResult, vatRootKrefs };
  }

  /**
   * Initialize system subclusters from persisted state.
   * Validates no duplicate names, deletes orphaned subclusters, and restores
   * mappings for existing ones. Must be called before vat initialization.
   *
   * @param configs - Array of system subcluster configurations.
   */
  initSystemSubclusters(configs: SystemSubclusterConfig[]): void {
    // Validate no duplicate system subcluster names
    const names = new Set(configs.map((config) => config.name));
    if (names.size !== configs.length) {
      throw new Error('Duplicate system subcluster names in config');
    }

    this.#restorePersistedSystemSubclusters(configs);
  }

  /**
   * Re-create IO channels for every persisted subcluster whose config
   * declares one.
   *
   * IO channels (`config.io`) are external to the kernel's durable
   * state — they're live OS-process resources (Unix sockets, pipes,
   * etc.) backed by the host's IOManager. `launchSubcluster` creates
   * them at subcluster-launch time, but on a kernel restart the vats
   * get re-incarnated from persisted state without going through
   * `launchSubcluster` again, so any IO channels they were using are
   * gone. This method bridges that gap: invoked from the kernel's
   * init path before `initializeAllVats`, it walks the persisted
   * subcluster table and re-creates each subcluster's declared IO
   * channels so the re-incarnated vats find their IOService
   * references live and ready when they make their first method call.
   *
   * If a particular subcluster's `createChannels` call fails (e.g.
   * the socket path is now in use by another process), the failure
   * is logged but does not abort the broader init — other
   * subclusters can still come up. Vats backed by the failed
   * subcluster will see method calls on their IOServices fail at
   * first use.
   *
   * No-op when no IOManager was provided to this SubclusterManager.
   */
  async restorePersistedIOChannels(): Promise<void> {
    if (!this.#ioManager) {
      return;
    }
    for (const subcluster of this.#kernelStore.getSubclusters()) {
      if (!subcluster.config.io) {
        continue;
      }
      try {
        await this.#ioManager.createChannels(
          subcluster.id,
          subcluster.config.io,
        );
        this.#logger.info(
          `Restored IO channels for persisted subcluster ${subcluster.id}`,
        );
      } catch (error) {
        this.#logger.error(
          `Failed to restore IO channels for subcluster ${subcluster.id}:`,
          error,
        );
      }
    }
  }

  /**
   * Launch new system subclusters that aren't already in persistence.
   * This must be called after the kernel queue is running since launchSubcluster
   * sends bootstrap messages.
   *
   * @param configs - Array of system subcluster configurations.
   */
  async launchNewSystemSubclusters(
    configs: SystemSubclusterConfig[],
  ): Promise<void> {
    // Filter to only configs that weren't restored from persistence
    const newConfigs = configs.filter(
      ({ name }) => !this.#systemSubclusterRoots.has(name),
    );

    if (newConfigs.length === 0) {
      return;
    }

    for (const { name, config } of newConfigs) {
      const result = await this.launchSubcluster(config, { isSystem: true });
      this.#systemSubclusterRoots.set(name, result.rootKref);

      // Persist the mapping
      this.#kernelStore.setSystemSubclusterMapping(name, result.subclusterId);

      this.#logger.info(`Launched new system subcluster "${name}"`);
    }
  }

  /**
   * Get the bootstrap root kref of a system subcluster by name.
   *
   * @param name - The name of the system subcluster.
   * @returns The bootstrap root kref.
   * @throws If the system subcluster is not found.
   */
  getSystemSubclusterRoot(name: string): KRef {
    const kref = this.#systemSubclusterRoots.get(name);
    if (kref === undefined) {
      throw new Error(`System subcluster "${name}" not found`);
    }
    return kref;
  }

  /**
   * Clear all system subcluster root state.
   * Called by the kernel during reset.
   */
  clearSystemSubclusters(): void {
    this.#systemSubclusterRoots.clear();
  }

  /**
   * Restore persisted system subclusters before vat initialization.
   * - Deletes orphaned subclusters (no longer in config) so their vats aren't started
   * - Restores mappings for existing subclusters
   *
   * @param configs - Array of system subcluster configurations.
   * @returns Whether any valid persisted subclusters were restored.
   */
  #restorePersistedSystemSubclusters(
    configs: SystemSubclusterConfig[],
  ): boolean {
    const persistedMappings =
      this.#kernelStore.getAllSystemSubclusterMappings();

    if (persistedMappings.size === 0) {
      return false;
    }

    const configNames = new Set(configs.map((config) => config.name));
    let hasValidPersistedSubclusters = false;

    for (const [name, subclusterId] of persistedMappings) {
      if (!configNames.has(name)) {
        // This system subcluster no longer has a config - delete it
        this.#logger.info(
          `System subcluster "${name}" no longer in config, deleting`,
        );
        this.deleteSubcluster(subclusterId);
        this.#kernelStore.deleteSystemSubclusterMapping(name);
        continue;
      }

      // Subcluster has a config - try to restore it
      const subcluster = this.getSubcluster(subclusterId);
      if (!subcluster) {
        this.#logger.warn(
          `System subcluster "${name}" mapping points to non-existent subcluster ${subclusterId}, cleaning up`,
        );
        this.#kernelStore.deleteSystemSubclusterMapping(name);
        continue;
      }

      const bootstrapVatId = subcluster.vats[subcluster.config.bootstrap];
      if (!bootstrapVatId) {
        throw new Error(
          `System subcluster "${name}" has no bootstrap vat - database may be corrupted`,
        );
      }

      const rootKref = this.#kernelStore.getRootObject(bootstrapVatId);
      if (!rootKref) {
        throw new Error(
          `System subcluster "${name}" has no root object - database may be corrupted`,
        );
      }

      this.#systemSubclusterRoots.set(name, rootKref);
      hasValidPersistedSubclusters = true;
      this.#logger.info(`Restored system subcluster "${name}"`);
    }

    return hasValidPersistedSubclusters;
  }
}
harden(SubclusterManager);
