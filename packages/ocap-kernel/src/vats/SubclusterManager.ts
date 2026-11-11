import type { CapData } from '@endo/marshal';
import { SubclusterNotFoundError } from '@metamask/kernel-errors';
import { Logger } from '@metamask/logger';

import type { IOManager } from '../io/IOManager.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import type { VatManager } from './VatManager.ts';
import { kslot, kunser } from '../liveslots/kernel-marshal.ts';
import type { SlotValue } from '../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  VatId,
  KRef,
  SubclusterId,
  ClusterConfig,
  InboxOutcome,
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
  writeMessage: (
    target: KRef,
    method: string,
    args: unknown[],
  ) => Promise<CapData<KRef>>;
  ioManager?: IOManager;
  logger?: Logger;
};

/** What a subcluster's launch crank hands back, for the bootstrap's answer. */
type Launched = {
  subclusterId: SubclusterId;
  rootKref: KRef;
  vatRootKrefs: Record<string, KRef>;
  answer: Promise<CapData<KRef>>;
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

  /**
   * Writes a message from the kernel inside the open crank, for the run loop
   * to deliver, and gives a promise for its answer.
   */
  readonly #writeMessage: (
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
   * @param options.writeMessage - Function that writes a message from the
   * kernel inside the open crank and gives a promise for its answer.
   * @param options.ioManager - Optional IO manager for IO channel lifecycle.
   * @param options.logger - Optional logger for diagnostic output.
   */
  constructor({
    kernelStore,
    kernelQueue,
    vatManager,
    getKernelService,
    writeMessage,
    ioManager,
    logger,
  }: SubclusterManagerOptions) {
    this.#kernelStore = kernelStore;
    this.#kernelQueue = kernelQueue;
    this.#vatManager = vatManager;
    this.#getKernelService = getKernelService;
    this.#writeMessage = writeMessage;
    this.#ioManager = ioManager;
    this.#logger = logger ?? new Logger('SubclusterManager');
    harden(this);
  }

  /**
   * Launches a sub-cluster of vats, in a crank of its own: its record, IO
   * channels and vats are written together with the bootstrap message, and a
   * vat that will not start rolls them all back. The bootstrap message is
   * answered in a later crank, and a subcluster whose bootstrap fails is
   * terminated.
   *
   * @param config - Configuration object for sub-cluster.
   * @param options - Launch options.
   * @param options.isSystem - Whether this is a system subcluster. System
   * subclusters may access restricted kernel services. Defaults to `false`.
   * @param options.systemName - The name to record a system subcluster under,
   * written with its record.
   * @returns A promise for the subcluster ID, bootstrap root kref, and
   * bootstrap result.
   */
  async launchSubcluster(
    config: ClusterConfig,
    {
      isSystem = false,
      systemName,
    }: { isSystem?: boolean; systemName?: string } = {},
  ): Promise<SubclusterLaunchResult> {
    isClusterConfig(config) || Fail`invalid cluster config`;
    if (!config.vats[config.bootstrap]) {
      Fail`invalid bootstrap vat name ${config.bootstrap}`;
    }
    for (const vatName of Object.keys(config.vats)) {
      // Reject vat names that shadow Object.prototype built-ins (__proto__,
      // constructor, etc.) before using them as property keys.
      !(vatName in Object.prototype) || Fail`invalid vat name '${vatName}'`;
    }
    const { subclusterId, rootKref, vatRootKrefs, answer } =
      await this.#kernelQueue.enqueueInbox('launch a subcluster', async () =>
        this.#launch(config, { isSystem, systemName }),
      );
    let bootstrapResult: CapData<KRef>;
    try {
      bootstrapResult = await answer;
      const unserialized = kunser(bootstrapResult);
      if (unserialized instanceof Error) {
        throw unserialized;
      }
    } catch (error) {
      await this.terminateSubcluster(subclusterId).catch(
        (teardownError: unknown) =>
          this.#logger.error(
            `Error terminating subcluster ${subclusterId} after its bootstrap failed:`,
            teardownError,
          ),
      );
      throw error;
    }
    return { subclusterId, rootKref, bootstrapResult, vatRootKrefs };
  }

  /**
   * Carry out a subcluster's launch, in the crank the run loop opened for it.
   *
   * @param config - Configuration object for sub-cluster.
   * @param options - Launch options.
   * @param options.isSystem - Whether this is a system subcluster.
   * @param options.systemName - The name to record a system subcluster under.
   * @returns The crank's outcome: what was launched, or a failure that rolls
   * the crank back, after every worker it started has been stopped.
   */
  async #launch(
    config: ClusterConfig,
    {
      isSystem,
      systemName,
    }: { isSystem: boolean; systemName?: string | undefined },
  ): Promise<InboxOutcome<Launched>> {
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
      const services = this.#serviceSlots(subclusterId, config);
      const { rootKref, vatRootKrefs } = await this.#launchVats(
        subclusterId,
        config,
      );
      if (systemName !== undefined) {
        this.#kernelStore.setSystemSubclusterMapping(systemName, subclusterId);
      }
      const roots = Object.fromEntries(
        Object.entries(vatRootKrefs).map(([vatName, root]) => [
          vatName,
          kslot(root, 'vatRoot'),
        ]),
      );
      // Last: a failure after it would leave the answer's subscription behind.
      const answer = this.#writeMessage(rootKref, 'bootstrap', [
        roots,
        services,
      ]);
      // Awaited once the crank commits; a crank that dies first abandons the
      // answer with nobody holding it.
      answer.catch(() => undefined);
      return { value: { subclusterId, rootKref, vatRootKrefs, answer } };
    } catch (error) {
      // The rollback forgets the records; the workers and channels are the
      // kernel's to stop. A store fault is reported to the caller the same way
      // until the kernel can tell it from a vat's failure (#1291).
      await this.#stopMembers(subclusterId);
      try {
        await this.#ioManager?.destroyChannels(subclusterId);
      } catch (cleanupError) {
        this.#logger.error(
          'Error during IO cleanup on failed launch:',
          cleanupError,
        );
      }
      return {
        abort: true,
        failure: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Launch every vat of a subcluster, concurrently.
   *
   * @param subclusterId - The subcluster.
   * @param config - Its configuration.
   * @returns The bootstrap vat's root and every vat's, by name.
   * @throws What the first vat that failed to launch threw, once every launch
   * has settled, so that each worker that did start is there to be stopped.
   */
  async #launchVats(
    subclusterId: SubclusterId,
    config: ClusterConfig,
  ): Promise<{ rootKref: KRef; vatRootKrefs: Record<string, KRef> }> {
    // `getNextVatId()` runs synchronously before each launch's first await, so
    // vat-ID allocation order is deterministic.
    const launches = await Promise.allSettled(
      Object.entries(config.vats).map(
        async ([vatName, vatConfig]): Promise<[string, KRef]> => [
          vatName,
          await this.#vatManager.launchVat(vatConfig, vatName, subclusterId),
        ],
      ),
    );
    const failed = launches.find((launch) => launch.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }
    const vatRootKrefs = Object.fromEntries(
      launches.flatMap((launch) =>
        launch.status === 'fulfilled' ? [launch.value] : [],
      ),
    );
    const rootKref = vatRootKrefs[config.bootstrap];
    if (rootKref === undefined) {
      throw Fail`no launch result for bootstrap vat '${config.bootstrap}'`;
    }
    return { rootKref, vatRootKrefs };
  }

  /**
   * Stop the worker of every member of a subcluster that has one, last
   * launched first, inside a crank that is about to roll the members' records
   * back.
   *
   * @param subclusterId - The subcluster.
   */
  async #stopMembers(subclusterId: SubclusterId): Promise<void> {
    for (const vatId of this.#kernelStore
      .getSubclusterVats(subclusterId)
      .reverse()) {
      // A vat that failed to start has no worker left to stop.
      if (this.#vatManager.hasVat(vatId)) {
        await this.#vatManager.stopVat(vatId, true);
      }
    }
  }

  /**
   * Whether a vat has neither a handle nor a record, and so nothing to retire.
   *
   * @param vatId - The vat.
   * @returns True if the vat is gone.
   */
  #isVatGone(vatId: VatId): boolean {
    return (
      !this.#vatManager.hasVat(vatId) && !this.#kernelStore.isVatActive(vatId)
    );
  }

  /**
   * Terminates a named sub-cluster of vats, in a crank of its own: every
   * member is stopped and its death written, with the record's deletion.
   *
   * @param subclusterId - The id of the subcluster to terminate.
   * @returns A promise that resolves once the crank has committed.
   */
  async terminateSubcluster(subclusterId: SubclusterId): Promise<void> {
    await this.#kernelQueue.enqueueInbox(
      'terminate a subcluster',
      async (): Promise<InboxOutcome<undefined>> => {
        const subcluster = this.#kernelStore.getSubcluster(subclusterId);
        if (!subcluster) {
          return { failure: new SubclusterNotFoundError(subclusterId) };
        }
        for (const vatId of Object.values(subcluster.vats).reverse()) {
          // A member can be gone already: lost, and retired by a crank before
          // this one.
          if (!this.#isVatGone(vatId)) {
            await this.#vatManager.stopVat(vatId, true);
          }
          this.#vatManager.collectGarbage();
        }
        try {
          await this.#ioManager?.destroyChannels(subclusterId);
        } catch (error) {
          this.#logger.error('Error during IO cleanup on termination:', error);
        }
        this.#dropSystemSubclusterMapping(subclusterId);
        this.#kernelStore.deleteSubcluster(subclusterId);
        return { value: undefined };
      },
    );
  }

  /**
   * Forget the system name a subcluster is registered under, if it has one.
   *
   * @param subclusterId - The subcluster.
   */
  #dropSystemSubclusterMapping(subclusterId: SubclusterId): void {
    const mappings = this.#kernelStore.getAllSystemSubclusterMappings();
    for (const [name, mappedSubclusterId] of mappings) {
      if (mappedSubclusterId === subclusterId) {
        this.#systemSubclusterRoots.delete(name);
        this.#kernelStore.deleteSystemSubclusterMapping(name);
        this.#logger.info(`Cleaned up system subcluster mapping "${name}"`);
        break;
      }
    }
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
   * The services a subcluster's bootstrap vat is handed, as slots by name:
   * the services its config names, and its IO channels.
   *
   * @param subclusterId - The subcluster.
   * @param config - Its configuration.
   * @returns The slots by name.
   */
  #serviceSlots(
    subclusterId: SubclusterId,
    config: ClusterConfig,
  ): Record<string, SlotValue> {
    const ioNames = config.io
      ? new Set(Object.keys(config.io))
      : new Set<string>();
    const allServiceNames = new Set([...(config.services ?? []), ...ioNames]);
    // Object.fromEntries so that a name like `__proto__` becomes an own
    // property instead of replacing the prototype.
    return Object.fromEntries(
      [...allServiceNames].map((name) => {
        // IO services are registered under scoped names to avoid collisions
        const lookupName = ioNames.has(name)
          ? `io:${subclusterId}:${name}`
          : name;
        const possibleService = this.#getKernelService(lookupName);
        if (!possibleService) {
          throw Error(`no registered kernel service '${lookupName}'`);
        }
        return [name, kslot(possibleService.kref)];
      }),
    );
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
   * Remove each system subcluster whose bootstrap vat is gone, terminating its
   * other vats, so that `launchNewSystemSubclusters` launches it again from its
   * config.
   *
   * Only before the run loop starts, since it writes each vat's death directly.
   */
  async removeSystemSubclustersWithoutBootstrapVat(): Promise<void> {
    const mappings = this.#kernelStore.getAllSystemSubclusterMappings();
    for (const [name, subclusterId] of mappings) {
      const subcluster = this.#kernelStore.getSubcluster(subclusterId);
      if (subcluster?.vats[subcluster.config.bootstrap]) {
        continue;
      }
      this.#logger.error(
        `System subcluster "${name}" lost its bootstrap vat; launching it again from its config`,
      );
      for (const vatId of Object.values(subcluster?.vats ?? {}).reverse()) {
        // `stopVat` throws for a vat that is gone.
        if (!this.#isVatGone(vatId)) {
          await this.#vatManager.stopVat(vatId, true);
        }
      }
      try {
        await this.#ioManager?.destroyChannels(subclusterId);
      } catch (error) {
        this.#logger.error('Error during IO cleanup on removal:', error);
      }
      this.#kernelStore.deleteSubcluster(subclusterId);
      this.#dropSystemSubclusterMapping(subclusterId);
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
      const result = await this.launchSubcluster(config, {
        isSystem: true,
        systemName: name,
      });
      this.#systemSubclusterRoots.set(name, result.rootKref);
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
        // Left for `removeSystemSubclustersWithoutBootstrapVat`.
        continue;
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
