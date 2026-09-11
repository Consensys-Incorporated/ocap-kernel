import type { CapData } from '@endo/marshal';
import type { KernelDatabase } from '@metamask/kernel-store';
import { isCapData } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';

import { IOManager } from './io/IOManager.ts';
import type { IOListenerFactory } from './io/types.ts';
import { makeKernelFacet } from './kernel-facet.ts';
import type { KernelFacet } from './kernel-facet.ts';
import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import { KernelServiceManager } from './KernelServiceManager.ts';
import type { KernelService } from './KernelServiceManager.ts';
import { kslot, kunser } from './liveslots/kernel-marshal.ts';
import type { SlotValue } from './liveslots/kernel-marshal.ts';
import { OcapURLManager } from './remotes/kernel/OcapURLManager.ts';
import { RemoteManager } from './remotes/kernel/RemoteManager.ts';
import type { RemoteCommsOptions } from './remotes/types.ts';
import type { PingVatResult } from './rpc/index.ts';
import { makeKernelStore } from './store/index.ts';
import type { KernelStore } from './store/index.ts';
import type {
  VatId,
  RemoteId,
  EndpointId,
  SubclusterId,
  KRef,
  PlatformServices,
  ClusterConfig,
  VatConfig,
  KernelStatus,
  OnRunLoopFailure,
  Subcluster,
  SubclusterLaunchResult,
  EndpointHandle,
  SystemSubclusterConfig,
} from './types.ts';
import { isVatId, isRemoteId } from './types.ts';
import type { AllowedGlobalName } from './vats/endowments.ts';
import { SubclusterManager } from './vats/SubclusterManager.ts';
import type { VatHandle } from './vats/VatHandle.ts';
import { VatManager } from './vats/VatManager.ts';

/**
 * The main class for the ocap kernel. It is responsible for
 * managing the lifecycle of the kernel and the vats.
 *
 * @param commandStream - Command channel from whatever external software is driving the kernel.
 * @param platformServices - Service to do things the kernel worker can't.
 * @param kernelDatabase - Database holding the kernel's persistent state.
 * @param options - Options for the kernel constructor.
 * @param options.resetStorage - If true, the storage will be cleared.
 * @param options.logger - Optional logger for error and diagnostic output.
 * @param options.keySeed - Optional seed for libp2p key generation.
 * @returns A new {@link Kernel}.
 */
export class Kernel {
  /** Manages vat lifecycle operations */
  readonly #vatManager: VatManager;

  /** Manages subcluster operations */
  readonly #subclusterManager: SubclusterManager;

  /** Manages remote kernel connections */
  readonly #remoteManager: RemoteManager;

  /** Manages OCAP URL issuing and redemption */
  readonly #ocapURLManager: OcapURLManager;

  /** Manages kernel service registration and invocation */
  readonly #kernelServiceManager: KernelServiceManager;

  /**
   * Service to to things the kernel worker can't do: network communications
   * and spawning workers (in iframes) for vats to run in
   */
  readonly #platformServices: PlatformServices;

  /** Storage holding the kernel's own persistent state */
  readonly #kernelStore: KernelStore;

  /** Logger for outputting messages (such as errors) to the console */
  readonly #logger: Logger;

  /** The kernel's run queue */
  readonly #kernelQueue: KernelQueue;

  /** The kernel's router */
  readonly #kernelRouter: KernelRouter;

  /** Database holding the kernel's persistent state */
  readonly #kernelDatabase: KernelDatabase;

  /** Manages IO channel lifecycle (optional, requires factory injection) */
  readonly #ioManager: IOManager | undefined;

  readonly #onRunLoopFailure: OnRunLoopFailure | undefined;

  /**
   * Construct a new kernel instance.
   *
   * @param platformServices - Service to do things the kernel worker can't.
   * @param kernelDatabase - Database holding the kernel's persistent state.
   * @param options - Options for the kernel constructor.
   * @param options.resetStorage - If true, the storage will be cleared.
   * @param options.logger - Optional logger for error and diagnostic output.
   * @param options.keySeed - Optional seed for libp2p key generation.
   * @param options.mnemonic - Optional BIP39 mnemonic for deriving the kernel identity.
   * @param options.ioListenerFactory - Optional factory for creating IO listeners.
   * @param options.allowedGlobalNames - Optional list of allowed global names for vat endowments.
   * @param options.onRunLoopFailure - Optional handler called if the run loop dies.
   * @param options.auditRefCounts - If true, verify every kref's reference
   * counts against the references the kernel actually holds at the end of each
   * crank, and throw on any mismatch. Intended for tests and debugging; the
   * audit walks the whole store.
   */
  // eslint-disable-next-line no-restricted-syntax
  private constructor(
    platformServices: PlatformServices,
    kernelDatabase: KernelDatabase,
    options: {
      resetStorage?: boolean;
      logger?: Logger;
      keySeed?: string | undefined;
      mnemonic?: string | undefined;
      ioListenerFactory?: IOListenerFactory;
      allowedGlobalNames?: AllowedGlobalName[];
      onRunLoopFailure?: OnRunLoopFailure;
      auditRefCounts?: boolean;
    } = {},
  ) {
    this.#platformServices = platformServices;
    this.#kernelDatabase = kernelDatabase;
    this.#onRunLoopFailure = options.onRunLoopFailure;
    this.#logger = options.logger ?? new Logger('ocap-kernel');
    this.#kernelStore = makeKernelStore(kernelDatabase, this.#logger);
    if (options.auditRefCounts) {
      this.#kernelStore.setRefCountAuditing(true);
    }
    if (!this.#kernelStore.isInitialized()) {
      this.#kernelStore.markInitialized();
    }

    if (options.resetStorage) {
      // If mnemonic is provided with resetStorage, also clear identity
      // to allow recovery with the new mnemonic
      this.#resetKernelState({ resetIdentity: Boolean(options.mnemonic) });
    }

    // Bypass VatManager.terminateVat() here because it calls waitForCrank(),
    // which would deadlock — this callback is invoked from within a crank.
    this.#kernelQueue = new KernelQueue(
      this.#kernelStore,
      async (vatId, reason) => {
        await this.#vatManager.stopVat(vatId, true, reason);
        this.#kernelStore.markVatAsTerminated(vatId);
      },
    );

    this.#vatManager = new VatManager({
      platformServices,
      kernelStore: this.#kernelStore,
      kernelQueue: this.#kernelQueue,
      logger: this.#logger.subLogger({ tags: ['VatManager'] }),
      allowedGlobalNames: options.allowedGlobalNames,
    });

    this.#remoteManager = new RemoteManager({
      platformServices,
      kernelStore: this.#kernelStore,
      kernelQueue: this.#kernelQueue,
      logger: this.#logger.subLogger({ tags: ['RemoteManager'] }),
      keySeed: options.keySeed,
      mnemonic: options.mnemonic,
    });

    this.#ocapURLManager = new OcapURLManager({
      remoteManager: this.#remoteManager,
      kernelStore: this.#kernelStore,
    });

    this.#kernelServiceManager = new KernelServiceManager({
      kernelStore: this.#kernelStore,
      kernelQueue: this.#kernelQueue,
      logger: this.#logger.subLogger({ tags: ['KernelServiceManager'] }),
    });

    if (options.ioListenerFactory) {
      this.#ioManager = new IOManager({
        factory: options.ioListenerFactory,
        registerService:
          this.#kernelServiceManager.registerKernelServiceObject.bind(
            this.#kernelServiceManager,
          ),
        unregisterService:
          this.#kernelServiceManager.unregisterKernelServiceObject.bind(
            this.#kernelServiceManager,
          ),
        registerAnonymous:
          this.#kernelServiceManager.registerAnonymousKernelObject.bind(
            this.#kernelServiceManager,
          ),
        releaseAnonymous:
          this.#kernelServiceManager.releaseAnonymousKernelObject.bind(
            this.#kernelServiceManager,
          ),
        logger: this.#logger.subLogger({ tags: ['IOManager'] }),
      });
    }

    this.#subclusterManager = new SubclusterManager({
      kernelStore: this.#kernelStore,
      kernelQueue: this.#kernelQueue,
      vatManager: this.#vatManager,
      getKernelService: (name) =>
        this.#kernelServiceManager.getKernelService(name),
      queueMessage: this.queueMessage.bind(this),
      ...(this.#ioManager ? { ioManager: this.#ioManager } : {}),
      logger: this.#logger.subLogger({ tags: ['SubclusterManager'] }),
    });

    this.#kernelRouter = new KernelRouter(
      this.#kernelStore,
      this.#kernelQueue,
      this.#getEndpoint.bind(this),
      this.#kernelServiceManager.invokeKernelService.bind(
        this.#kernelServiceManager,
      ),
      this.#logger,
    );

    // Register OCAP URL services
    const { issuerService, redemptionService } =
      this.#ocapURLManager.getServices();
    this.#kernelServiceManager.registerKernelServiceObject(
      issuerService.name,
      issuerService.service,
    );
    this.#kernelServiceManager.registerKernelServiceObject(
      redemptionService.name,
      redemptionService.service,
    );

    harden(this);
  }

  /**
   * Create a new kernel instance.
   *
   * @param platformServices - Service to do things the kernel worker can't.
   * @param kernelDatabase - Database holding the kernel's persistent state.
   * @param options - Options for the kernel constructor.
   * @param options.resetStorage - If true, the storage will be cleared.
   * @param options.logger - Optional logger for error and diagnostic output.
   * @param options.keySeed - Optional seed for libp2p key generation.
   * @param options.mnemonic - Optional BIP39 mnemonic for deriving the kernel identity.
   * @param options.ioListenerFactory - Optional factory for creating IO listeners.
   * @param options.systemSubclusters - Optional array of system subcluster configurations.
   * @param options.allowedGlobalNames - Optional list of allowed global names for vat endowments. When set, only these names from the `VatSupervisor`'s configured endowments (see `createDefaultEndowments`) are available to vats.
   * @param options.onRunLoopFailure - Optional handler called if the run loop dies. The kernel must be restarted after that, so an embedder that outlives it (e.g. a daemon) should use this to terminate or restart.
   * @param options.auditRefCounts - If true, verify reference counts against
   * ground truth at the end of each crank and throw on any mismatch.
   * @returns A promise for the new kernel instance.
   */
  static async make(
    platformServices: PlatformServices,
    kernelDatabase: KernelDatabase,
    options: {
      resetStorage?: boolean;
      logger?: Logger;
      keySeed?: string | undefined;
      mnemonic?: string | undefined;
      ioListenerFactory?: IOListenerFactory;
      systemSubclusters?: SystemSubclusterConfig[];
      allowedGlobalNames?: AllowedGlobalName[];
      onRunLoopFailure?: OnRunLoopFailure;
      auditRefCounts?: boolean;
    } = {},
  ): Promise<Kernel> {
    const kernel = new Kernel(platformServices, kernelDatabase, options);
    await kernel.#init(options.systemSubclusters);
    return kernel;
  }

  /**
   * Start the kernel running.
   *
   * @param systemSubclusterConfigs - Optional array of system subcluster configurations.
   */
  async #init(
    systemSubclusterConfigs?: SystemSubclusterConfig[],
  ): Promise<void> {
    const configs = systemSubclusterConfigs ?? [];

    // Set up the remote message handler
    this.#remoteManager.setMessageHandler(
      async (from: string, message: string) =>
        this.#remoteManager.handleRemoteMessage(from, message),
    );

    // Always provide the kernel facet, even when there are no system subcluster
    // configs. The run queue may contain messages targeting the kernel facet kref
    // from a previous incarnation's system subclusters. If the facet is not
    // registered, invokeKernelService throws and crashes the kernel queue.
    // Ideally, orphaned messages would be purged before the queue starts, but
    // the run queue has no selective removal capability.
    this.provideFacet();

    // Discard anonymous kernel objects from a previous incarnation. They
    // host things that cannot outlive the process — an accepted socket
    // connection, say — and unlike a named service there is no name to
    // re-register one under, so a survivor is unreachable but still pinned,
    // accumulating with every restart.
    //
    // This unpins; it does not by itself make a delivery to a survivor safe,
    // because the object outlives the sweep whenever a vat import or queued
    // message still references it. `invokeKernelService` is what makes that
    // case survivable, by rejecting the caller instead of throwing. Swept
    // before the queue starts regardless, so the unreachable objects are gone
    // before anything can address them.
    const abandoned =
      this.#kernelServiceManager.releaseAbandonedAnonymousKernelObjects();
    if (abandoned > 0) {
      this.#logger.info(
        `Released ${abandoned} anonymous kernel object(s) abandoned by a previous incarnation`,
      );
    }

    // Restore persisted system subclusters and delete ones that no
    // longer have a config, to ensure that orphaned vats aren't started
    this.#subclusterManager.initSystemSubclusters(configs);

    // Re-create IO channels for persisted subclusters whose configs
    // declare them. This must happen before `initializeAllVats` so
    // that re-incarnated vats find their IOService references live
    // when they make their first method call.
    await this.#subclusterManager.restorePersistedIOChannels();

    // Start all vats that were previously running before starting the queue
    // This ensures that any messages in the queue have their target vats ready
    await this.#vatManager.initializeAllVats();

    // Start the kernel queue processing (non-blocking)
    // This runs for the entire lifetime of the kernel
    this.#kernelQueue
      .run(this.#kernelRouter.deliver.bind(this.#kernelRouter))
      .catch((error) => this.#handleRunLoopFailure(error));

    // Launch new system subclusters (requires queue to be running)
    await this.#subclusterManager.launchNewSystemSubclusters(configs);
  }

  /**
   * Tell the embedder the kernel is finished, since it owns the decision to
   * exit or restart. Deliberately not re-thrown: an unhandled rejection would
   * take the process down without giving it that chance.
   *
   * @param failure - The error that killed the run loop, normalized by
   * `KernelQueue.run`, which reports this same object in `getStatus`.
   */
  #handleRunLoopFailure(failure: Error): void {
    this.#logger.error(
      'Run loop died; the kernel can no longer process messages and must be restarted:',
      failure,
    );
    // Called off a local, not off `this`: `this.#onRunLoopFailure(...)` is a
    // member call, so a non-arrow handler would receive the whole kernel as its
    // receiver. The handler's business here is one `Error`.
    const notify = this.#onRunLoopFailure;
    try {
      // `OnRunLoopFailure` returns void, but TypeScript admits an async
      // function there, whose rejection would become the very unhandled
      // rejection this method exists to avoid. Contain it either way.
      const handled = notify?.(failure) as unknown;
      if (typeof (handled as PromiseLike<void>)?.then === 'function') {
        Promise.resolve(handled).catch((handlerError: unknown) => {
          this.#logger.error(
            'Run loop failure handler rejected:',
            handlerError,
          );
        });
      }
    } catch (handlerError) {
      this.#logger.error('Run loop failure handler threw:', handlerError);
    }
  }

  /**
   * Provide the kernel facet, creating and registering it as a kernel service
   * if it doesn't already exist.
   *
   * @returns The kernel facet.
   */
  provideFacet(): KernelFacet {
    const existing = this.#kernelServiceManager.getKernelService('kernelFacet');
    if (existing) {
      return existing.service as KernelFacet;
    }

    const kernelFacet = makeKernelFacet(this);
    this.#kernelServiceManager.registerKernelServiceObject(
      'kernelFacet',
      kernelFacet,
      { systemOnly: true },
    );
    return kernelFacet;
  }

  /**
   * Initialize the kernel's remote identity (peer ID, crypto keys, OCAP URL
   * operations) without starting network communications. This is sufficient
   * for issuing and redeeming local OCAP URLs in the daemon.
   *
   * @param options - Options for identity initialization.
   * @param options.mnemonic - BIP39 mnemonic for seed recovery.
   * @returns A promise that resolves when initialization is complete.
   */
  async initIdentity(options?: {
    mnemonic?: string | undefined;
  }): Promise<void> {
    await this.#remoteManager.initIdentity(options);
  }

  /**
   * Initialize the remote comms object.
   *
   * @param options - Options for remote communications initialization.
   * @returns A promise that resolves when initialization is complete.
   */
  async initRemoteComms(options?: RemoteCommsOptions): Promise<void> {
    await this.#remoteManager.initRemoteComms(options);
  }

  /**
   * Explicitly close a connection to a peer.
   * Marks the peer as intentionally closed to prevent automatic reconnection.
   *
   * @param peerId - The peer ID to close the connection for.
   */
  async closeConnection(peerId: string): Promise<void> {
    await this.#remoteManager.closeConnection(peerId);
  }

  /**
   * Manually reconnect to a peer after intentional close.
   * Clears the intentional close flag and initiates reconnection.
   *
   * @param peerId - The peer ID to reconnect to.
   * @param hints - Optional hints for reconnection.
   */
  async reconnectPeer(peerId: string, hints: string[] = []): Promise<void> {
    await this.#remoteManager.reconnectPeer(peerId, hints);
  }

  /**
   * Register location hints for a remote peer.
   * Hints are multiaddr strings that can be used to dial the peer directly.
   *
   * @param peerId - The peer ID to register hints for.
   * @param hints - The location hint multiaddr strings.
   */
  async registerLocationHints(peerId: string, hints: string[]): Promise<void> {
    await this.#remoteManager.registerLocationHints(peerId, hints);
  }

  /**
   * Send a message from the kernel to an object in a vat.
   *
   * @param target - The object to which the message is directed.
   * @param method - The method to be invoked.
   * @param args - Message arguments.
   * @returns A promise for the CapData encoded result of the message invocation.
   */
  async queueMessage(
    target: KRef,
    method: string,
    args: unknown[],
  ): Promise<CapData<KRef>> {
    try {
      return await this.#kernelQueue.enqueueMessage(target, method, args);
    } catch (rejection) {
      if (isCapData(rejection)) {
        throw kunser(rejection as CapData<KRef>);
      }
      throw rejection;
    }
  }

  /**
   * Issue an OCAP URL for a kernel reference.
   *
   * @param kref - The kref of the object to issue an OCAP URL for.
   * @returns A promise for the OCAP URL.
   */
  async issueOcapURL(kref: KRef): Promise<string> {
    return this.#ocapURLManager.issueOcapURL(kref);
  }

  /**
   * Redeem an OCAP URL to get the kernel reference it represents.
   *
   * @param url - The OCAP URL to redeem.
   * @returns A promise for the kref of the object referenced by the OCAP URL.
   */
  async redeemOcapURL(url: string): Promise<KRef> {
    return this.#ocapURLManager.redeemOcapURL(url);
  }

  /**
   * Register a kernel service object.
   *
   * @param name - The name of the service.
   * @param object - The service object to register.
   * @param options - Registration options.
   * @param options.systemOnly - Whether the service is only available to system
   * subclusters. Defaults to `false`.
   * @returns The registration details including the kref.
   */
  registerKernelServiceObject(
    name: string,
    object: object,
    options?: { systemOnly?: boolean },
  ): KernelService {
    return this.#kernelServiceManager.registerKernelServiceObject(
      name,
      object,
      options,
    );
  }

  /**
   * Launches a sub-cluster of vats.
   *
   * @param config - Configuration object for sub-cluster.
   * @returns A promise for the subcluster ID and the (CapData encoded) result
   * of the bootstrap message.
   */
  async launchSubcluster(
    config: ClusterConfig,
  ): Promise<SubclusterLaunchResult> {
    return this.#subclusterManager.launchSubcluster(config);
  }

  /**
   * Terminates a named sub-cluster of vats.
   *
   * @param subclusterId - The id of the subcluster to terminate.
   * @returns A promise that resolves when termination is complete.
   */
  async terminateSubcluster(subclusterId: SubclusterId): Promise<void> {
    return this.#subclusterManager.terminateSubcluster(subclusterId);
  }

  /**
   * Retrieves a subcluster by its ID.
   *
   * @param subclusterId - The id of the subcluster.
   * @returns The subcluster, or undefined if not found.
   */
  getSubcluster(subclusterId: SubclusterId): Subcluster | undefined {
    return this.#subclusterManager.getSubcluster(subclusterId);
  }

  /**
   * Gets all subclusters.
   *
   * @returns An array of all subcluster records.
   */
  getSubclusters(): Subcluster[] {
    return this.#subclusterManager.getSubclusters();
  }

  /**
   * Get the bootstrap root kref of a system subcluster by name.
   *
   * @param name - The name of the system subcluster.
   * @returns The bootstrap root kref.
   * @throws If the system subcluster is not found.
   */
  getSystemSubclusterRoot(name: string): KRef {
    return this.#subclusterManager.getSystemSubclusterRoot(name);
  }

  /**
   * Convert a kref string to a slot value (presence).
   *
   * Use this to restore a presence from a stored kref string after restart.
   *
   * @param kref - The kref string to convert.
   * @param iface - The interface name for the slot value.
   * @returns The slot value that will become a presence when marshalled.
   */
  getPresence(kref: KRef, iface: string = 'Kernel Object'): SlotValue {
    return kslot(kref, iface);
  }

  /**
   * Checks if a vat belongs to a specific subcluster.
   *
   * @param vatId - The ID of the vat to check.
   * @param subclusterId - The ID of the subcluster to check membership against.
   * @returns True if the vat belongs to the specified subcluster, false otherwise.
   */
  isVatInSubcluster(vatId: VatId, subclusterId: SubclusterId): boolean {
    return this.#subclusterManager.isVatInSubcluster(vatId, subclusterId);
  }

  /**
   * Gets all vat IDs that belong to a specific subcluster.
   *
   * @param subclusterId - The ID of the subcluster to retrieve vat IDs from.
   * @returns An array of vat IDs belonging to the specified subcluster.
   */
  getSubclusterVats(subclusterId: SubclusterId): VatId[] {
    return this.#subclusterManager.getSubclusterVats(subclusterId);
  }

  /**
   * Restarts a vat.
   *
   * @param vatId - The ID of the vat to restart.
   * @returns A promise for the restarted vat handle.
   */
  async restartVat(vatId: VatId): Promise<VatHandle> {
    return this.#vatManager.restartVat(vatId);
  }

  /**
   * Terminate a vat with extreme prejudice.
   *
   * @param vatId - The ID of the vat to terminate.
   * @param reason - The reason for the termination, if any.
   * @returns A promise that resolves when the vat has been terminated.
   */
  async terminateVat(vatId: VatId, reason?: CapData<KRef>): Promise<void> {
    return this.#vatManager.terminateVat(vatId, reason);
  }

  /**
   * Clear the database.
   */
  async clearStorage(): Promise<void> {
    await this.#kernelQueue.waitForCrank();
    this.#kernelStore.clear();
  }

  /**
   * Gets an endpoint by its ID.
   *
   * @param endpointId - The ID of the endpoint to retrieve.
   * @returns The endpoint handle for the given ID.
   * @throws If the endpoint ID is invalid (neither a vat ID nor a remote ID).
   */
  #getEndpoint(endpointId: EndpointId): EndpointHandle {
    if (isVatId(endpointId)) {
      return this.#vatManager.getVat(endpointId);
    }
    if (isRemoteId(endpointId)) {
      return this.#remoteManager.getRemote(endpointId);
    }
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    throw Error(`invalid endpoint ID ${endpointId}`);
  }

  /**
   * Gets a list of the IDs of all running vats.
   *
   * @returns An array of all running vat IDs.
   */
  getVatIds(): VatId[] {
    return this.#vatManager.getVatIds();
  }

  /**
   * Gets a list of information about all running vats.
   *
   * @returns An array of vat information records containing ID, config, and subcluster ID.
   */
  getVats(): {
    id: VatId;
    config: VatConfig;
    subclusterId: SubclusterId;
  }[] {
    return this.#vatManager.getVats();
  }

  /**
   * Revoke an exported object. Idempotent. Revoking promises is not supported.
   *
   * @param kref - The KRef of the object to revoke.
   * @throws If the object is a promise.
   */
  revoke(kref: KRef): void {
    this.#kernelStore.revoke(kref);
  }

  /**
   * Check if an object is revoked.
   *
   * @param kref - The KRef of the object to check.
   * @returns True if the object is revoked, false otherwise.
   */
  isRevoked(kref: KRef): boolean {
    return this.#kernelStore.isRevoked(kref);
  }

  /**
   * Get the current kernel status: run loop health, the current cluster
   * configuration, and a list of all running vats.
   *
   * @returns A promise for the current kernel status containing run loop health,
   * vats, subclusters, and remote comms information.
   */
  async getStatus(): Promise<KernelStatus> {
    // A dead kernel must still be able to report that it's dead. `endCrank`
    // runs in a `finally` and settles its waiters even when it throws, so this
    // is belt-and-braces against a future crank that can't be waited out.
    if (this.#kernelQueue.getRunLoopStatus().state !== 'failed') {
      await this.#kernelQueue.waitForCrank();
    }
    // Read after the wait: an in-flight crank is exactly when the loop is most
    // likely to die, and a status sampled before it would report `running`.
    const runLoop = this.#kernelQueue.getRunLoopStatus();

    const status: KernelStatus = {
      runLoop,
      vats: this.getVats(),
      subclusters: this.#subclusterManager.getSubclusters(),
    };

    if (this.#remoteManager.isRemoteCommsInitialized()) {
      status.remoteComms = {
        state: 'connected',
        peerId: this.#remoteManager.getPeerId(),
        listenAddresses: this.#platformServices.getListenAddresses(),
      };
    } else if (this.#remoteManager.isIdentityInitialized()) {
      status.remoteComms = {
        state: 'identity-only',
        peerId: this.#remoteManager.getPeerId(),
      };
    } else {
      status.remoteComms = { state: 'disconnected' };
    }

    return status;
  }

  /**
   * Reap vats that match the filter.
   *
   * @param filter - A function that returns true if the vat should be reaped.
   */
  reapVats(filter: (vatId: VatId) => boolean = () => true): void {
    this.#vatManager.reapVats(filter);
  }

  /**
   * Reap remotes that match the filter.
   * This is for debugging and testing purposes only.
   *
   * @param filter - A function that returns true if the remote should be reaped.
   */
  reapRemotes(filter: (remoteId: RemoteId) => boolean = () => true): void {
    this.#remoteManager.reapRemotes(filter);
  }

  /**
   * Pin a vat root.
   *
   * @param vatId - The ID of the vat whose root to pin.
   * @returns The KRef of the pinned vat root.
   */
  pinVatRoot(vatId: VatId): KRef {
    return this.#vatManager.pinVatRoot(vatId);
  }

  /**
   * Unpin a vat root.
   *
   * @param vatId - The ID of the vat whose root to unpin.
   */
  unpinVatRoot(vatId: VatId): void {
    this.#vatManager.unpinVatRoot(vatId);
  }

  /**
   * Ping a vat.
   *
   * @param vatId - The ID of the vat to ping.
   * @returns A promise that resolves to the ping result.
   */
  async pingVat(vatId: VatId): Promise<PingVatResult> {
    return this.#vatManager.pingVat(vatId);
  }

  /**
   * Reset the kernel state.
   *
   * Identity keys (`keySeed`, `peerId`, `ocapURLKey`) are preserved so the
   * kernel keeps the same network identity across the reset. The
   * `incarnationId` is deliberately *not* preserved: its whole purpose is
   * to signal to remote peers that local state has been wiped so they
   * clear any seq-dedup / c-list bookkeeping for this peer. Preserving it
   * across a state wipe defeats the peer-restart detection introduced in
   * #948.
   *
   * @param options - Options for the reset.
   * @param options.resetIdentity - If true, also clears identity keys
   *   (keySeed, peerId, ocapURLKey). Used when recovering from a
   *   mnemonic, which is regenerating identity from scratch.
   */
  #resetKernelState({
    resetIdentity = false,
  }: { resetIdentity?: boolean } = {}): void {
    if (resetIdentity) {
      // Full reset including identity - used when recovering from mnemonic
      this.#kernelStore.reset();
    } else {
      // Preserve identity keys so network address survives restart.
      // `incarnationId` is deliberately omitted: it must be regenerated
      // so remote peers can detect the state loss via the handshake.
      this.#kernelStore.reset({
        except: ['keySeed', 'peerId', 'ocapURLKey'],
      });
    }
  }

  /**
   * Stop all running vats and reset the kernel state.
   * This is for debugging purposes only.
   *
   * Does not revive a kernel whose run loop has died: this clears state, it does
   * not restart the loop, so `getStatus` still reports `failed` afterwards and
   * the queue still refuses new work.
   */
  async reset(): Promise<void> {
    await this.#kernelQueue.waitForCrank();
    try {
      if (this.#ioManager) {
        await this.#ioManager.destroyAllChannels();
      }
      await this.terminateAllVats();
      this.#subclusterManager.clearSystemSubclusters();
      this.#resetKernelState();
    } catch (error) {
      this.#logger.error('Error resetting kernel:', error);
      throw error;
    }
  }

  /**
   * Terminate all vats and collect garbage.
   * This is for debugging purposes only.
   */
  async terminateAllVats(): Promise<void> {
    await this.#vatManager.terminateAllVats();
  }

  /**
   * Gracefully stop the kernel without deleting vats.
   */
  async stop(): Promise<void> {
    await this.#kernelQueue.waitForCrank();
    try {
      this.#kernelStore.recordLastActiveTime();
    } catch (error) {
      // A store that can no longer persist anything refuses this write, and
      // everything below it releases something: remote comms, the vat workers,
      // the database handle. A timestamp is not worth leaking those over, and
      // is meaningless anyway once the state it dates is unreachable.
      this.#logger.error('could not record last active time', error);
    }
    await this.#platformServices.stopRemoteComms();
    this.#remoteManager.cleanup();
    await this.#platformServices.terminateAll();
    this.#kernelDatabase.close();
  }

  /**
   * Collect garbage.
   * This is for debugging purposes only.
   */
  collectGarbage(): void {
    this.#vatManager.collectGarbage();
  }
}
harden(Kernel);
