import type { CapData } from '@endo/marshal';
import {
  VatAlreadyExistsError,
  VatDeletedError,
  VatNotFoundError,
} from '@metamask/kernel-errors';
import { stringify } from '@metamask/kernel-utils';
import { Logger, splitLoggerStream } from '@metamask/logger';

import type { KernelQueue } from '../KernelQueue.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  VatId,
  VatConfig,
  KRef,
  SubclusterId,
  PlatformServices,
} from '../types.ts';
import { ROOT_OBJECT_VREF } from '../types.ts';
import type { AllowedGlobalName } from './endowments.ts';
import { VatHandle } from './VatHandle.ts';
import type { PingVatResult } from '../rpc/index.ts';

type VatManagerOptions = {
  platformServices: PlatformServices;
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
  logger?: Logger;
  allowedGlobalNames?: AllowedGlobalName[] | undefined;
};

/**
 * Manages vat lifecycle operations including creation, termination, and restart.
 */
export class VatManager {
  /** Currently running vats, by ID */
  readonly #vats: Map<VatId, VatHandle>;

  /**
   * Vats whose worker is being replaced or torn down, by ID, each mapped to a
   * promise for whatever follows it: the new handle for a restart, nothing for a
   * termination. {@link provideVat} waits on these, which is what keeps a vat
   * mid-flux from being read as a vat that is gone — the kernel's c-list for a
   * restarting vat is whole, and every kref in it is one the returning
   * incarnation still holds.
   *
   * Recorded rather than guarded against: the run loop is free to run cranks
   * throughout, and a delivery that arrives mid-flux waits for the vat instead
   * of the flux waiting for the run loop. Inverted the other way — a lock the
   * restart holds while the loop stands still — the holder must never await
   * anything the run loop has to deliver, which is a much sharper edge.
   */
  readonly #vatsInFlux: Map<VatId, Promise<VatHandle | undefined>>;

  /** Service to spawn workers (in iframes) for vats to run in */
  readonly #platformServices: PlatformServices;

  /** Storage holding the kernel's persistent state */
  readonly #kernelStore: KernelStore;

  /** The kernel's run queue */
  readonly #kernelQueue: KernelQueue;

  /** Logger for outputting messages (such as errors) to the console */
  readonly #logger: Logger;

  /** Optional list of allowed global names for vat endowments */
  readonly #allowedGlobalNames: AllowedGlobalName[] | undefined;

  /**
   * Creates a new VatManager instance.
   *
   * @param options - Constructor options.
   * @param options.platformServices - Platform-specific services for launching vat workers.
   * @param options.kernelStore - The kernel's persistent state store.
   * @param options.kernelQueue - The kernel's message queue for scheduling deliveries.
   * @param options.logger - Logger instance for debugging and diagnostics.
   * @param options.allowedGlobalNames - Optional list of allowed global names for vat endowments.
   */
  constructor({
    platformServices,
    kernelStore,
    kernelQueue,
    logger,
    allowedGlobalNames,
  }: VatManagerOptions) {
    this.#vats = new Map();
    this.#vatsInFlux = new Map();
    this.#platformServices = platformServices;
    this.#kernelStore = kernelStore;
    this.#kernelQueue = kernelQueue;
    this.#logger = logger ?? new Logger('VatManager');
    this.#allowedGlobalNames = allowedGlobalNames;
    harden(this);
  }

  /**
   * Initialize all vats that were previously running.
   * This should be called during kernel startup.
   *
   * @returns A promise that resolves when all vats are initialized.
   */
  async initializeAllVats(): Promise<void> {
    const starts: Promise<void>[] = [];
    for (const { vatID, vatConfig } of this.#kernelStore.getAllVatRecords()) {
      starts.push(this.runVat(vatID, vatConfig));
    }
    await Promise.all(starts);
  }

  /**
   * Launch a new vat.
   *
   * @param vatConfig - Configuration for the new vat.
   * @param vatName - The name of the vat within the subcluster.
   * @param subclusterId - The ID of the subcluster to launch the vat in. Optional.
   * @returns a promise for the KRef of the new vat's root object.
   */
  async launchVat(
    vatConfig: VatConfig,
    vatName: string,
    subclusterId?: SubclusterId,
  ): Promise<KRef> {
    const vatId = this.#kernelStore.getNextVatId();
    // Register the vat with its subcluster BEFORE awaiting `runVat`.
    // `runVat` yields to the kernel event loop (loading the bundle,
    // negotiating with the vat worker); any crank that runs during that
    // window ends with `collectGarbage()` → `clearEmptySubclusters()`,
    // which would otherwise delete the just-created, still-empty
    // subcluster out from under us. Associating the vat first makes the
    // subcluster non-empty for GC.
    if (subclusterId) {
      this.#kernelStore.addSubclusterVat(subclusterId, vatName, vatId);
    }
    try {
      await this.runVat(vatId, vatConfig);
    } catch (error) {
      // Attribute the failure to the specific vat by kernel id and name.
      throw new Error(`Failed to launch vat ${vatId} (${vatName})`, {
        cause: error,
      });
    }
    try {
      this.#kernelStore.initEndpoint(vatId);
      const rootRef = this.#kernelStore.exportFromEndpoint(
        vatId,
        ROOT_OBJECT_VREF,
      );
      // A root is addressable for as long as its vat lives, whether or not
      // anyone currently imports it: the kernel's own API hands out root krefs
      // and `getRootObject` resolves them through this c-list entry. Without a
      // pin, GC would retire the entry the moment the last importer let go.
      this.#kernelStore.pinObject(rootRef);
      this.#kernelStore.setVatConfig(vatId, vatConfig);
      return rootRef;
    } catch (error) {
      // The worker is already running, so leaving it would strand a vat the
      // kernel has no record of. Tear it down before reporting the failure.
      let stopFailure: unknown;
      try {
        await this.stopVat(vatId, true);
      } catch (caught) {
        stopFailure = caught;
        this.#logger.error(
          `Failed to stop vat ${vatId} after incomplete launch; its worker may still be running:`,
          caught,
        );
      }
      // `stopVat` only tears down the worker. Whatever store records the
      // partial launch did write — the endpoint counters, the root's c-list
      // pair, its owner entry — are reclaimed by the terminated-vat cleanup,
      // which never runs unless the vat is marked.
      this.#kernelStore.markVatAsTerminated(vatId);
      throw new Error(
        `Failed to launch vat ${vatId} (${vatName})${stopFailure ? ' (cleanup also failed)' : ''}`,
        { cause: error },
      );
    }
  }

  /**
   * Start a new or resurrected vat running.
   *
   * @param vatId - The ID of the vat to start.
   * @param vatConfig - Its configuration.
   */
  async runVat(vatId: VatId, vatConfig: VatConfig): Promise<void> {
    if (this.#vats.has(vatId)) {
      throw new VatAlreadyExistsError(vatId);
    }
    const stream = await this.#platformServices.launch(vatId, vatConfig);
    const { kernelStream: vatStream, loggerStream } = splitLoggerStream(stream);
    const vatLogger = this.#logger.subLogger({ tags: [vatId] });
    vatLogger.injectStream(
      loggerStream as unknown as Parameters<typeof vatLogger.injectStream>[0],
      (error) => this.#logger.error(`Vat ${vatId} error: ${stringify(error)}`),
    );
    const vat = await VatHandle.make({
      vatId,
      vatConfig,
      vatStream,
      kernelStore: this.#kernelStore,
      kernelQueue: this.#kernelQueue,
      logger: vatLogger,
      allowedGlobalNames: this.#allowedGlobalNames,
    });
    this.#vats.set(vatId, vat);
  }

  /**
   * Stop a vat from running.
   *
   * Note that after this operation, the vat will be in a weird twilight zone
   * between existence and nonexistence, so this operation should only be used
   * as a component of vat restart (which will push it back into existence) or
   * vat termination (which will push it all the way into nonexistence).
   *
   * @param vatId - The ID of the vat.
   * @param terminating - If true, the vat is being killed, if false, it's being
   *   restarted.
   * @param reason - If the vat is being terminated, the reason for the termination.
   */
  async stopVat(
    vatId: VatId,
    terminating: boolean,
    reason?: CapData<KRef>,
  ): Promise<void> {
    const vat = this.getVat(vatId);
    let terminationError: Error | undefined;
    if (reason) {
      terminationError = new Error(`Vat termination: ${reason.body}`);
    } else if (terminating) {
      terminationError = new VatDeletedError(vatId);
    }
    if (terminating) {
      // A restart keeps the pin: the same root comes back.
      this.releaseVatRootPin(vatId);
    }
    await this.#platformServices
      .terminate(vatId, terminationError)
      .catch(this.#logger.error);
    await vat.terminate(terminating, terminationError);
    this.#vats.delete(vatId);
  }

  /**
   * Terminate a vat with extreme prejudice.
   *
   * @param vatId - The ID of the vat.
   * @param reason - If the vat is being terminated, the reason for the termination.
   */
  async terminateVat(vatId: VatId, reason?: CapData<KRef>): Promise<void> {
    await this.#kernelQueue.waitForCrank();
    await this.#trackFlux(vatId, this.#endVat(vatId, reason));
  }

  /**
   * Take a vat's worker down and mark the vat for cleanup.
   *
   * @param vatId - The ID of the vat.
   * @param reason - The reason for the termination, if there is one.
   * @returns Nothing: this vat has no successor.
   */
  async #endVat(
    vatId: VatId,
    reason?: CapData<KRef>,
  ): Promise<VatHandle | undefined> {
    await this.stopVat(vatId, true, reason);
    // Mark for deletion (which will happen later, in vat-cleanup events). Not
    // marked before `stopVat`, even though that would close the same window
    // this method's flux record closes: the mark makes the vat eligible for
    // `nextTerminatedVatCleanup`, which would wipe the c-list from under a
    // worker that is still being shut down.
    this.#kernelStore.markVatAsTerminated(vatId);
    return undefined;
  }

  /**
   * Restarts a vat.
   *
   * The wait for the crank in flight stays ahead of the flux record on purpose.
   * Recording first and waiting after looks tighter, and deadlocks: a crank that
   * is already running reaches its endpoint lookup, finds the record, and waits
   * for the restart, which is waiting for that crank to end.
   *
   * What that ordering leaves open is a crank the run loop starts in the turn
   * between the wait resolving and the record appearing; it takes the outgoing
   * handle and can still be mid-delivery when the worker goes down. Closing that
   * needs the restart to happen inside a crank — the vat is idle by construction
   * there, and no state changes outside the run loop at all.
   *
   * @param vatId - The ID of the vat.
   * @returns A promise for the restarted vat.
   */
  async restartVat(vatId: VatId): Promise<VatHandle> {
    await this.#kernelQueue.waitForCrank();
    const { config } = this.getVat(vatId);
    return (await this.#trackFlux(
      vatId,
      this.#replaceVat(vatId, config),
    )) as VatHandle;
  }

  /**
   * Replace a vat's worker, keeping the vat and everything the kernel holds for
   * it.
   *
   * @param vatId - The ID of the vat.
   * @param config - Its configuration, read before the old handle went away.
   * @returns A promise for the new handle.
   */
  async #replaceVat(vatId: VatId, config: VatConfig): Promise<VatHandle> {
    await this.stopVat(vatId, false);
    try {
      await this.runVat(vatId, config);
    } catch (error) {
      // The vat now has no worker while the store still counts it among the
      // living, and nothing else reclaims that: `cleanupTerminatedVat` only
      // visits vats that are marked. Mark it so the c-list its absent worker
      // still owns can be torn down.
      this.#kernelStore.markVatAsTerminated(vatId);
      throw error;
    }
    return this.getVat(vatId);
  }

  /**
   * Record that a vat is mid-flux for as long as the given operation runs, so a
   * delivery arriving meanwhile waits for its outcome.
   *
   * @param vatId - The vat being replaced or torn down.
   * @param flux - The operation, resolving to the vat's successor if it has one.
   * @returns The operation's own result, failure included.
   */
  async #trackFlux(
    vatId: VatId,
    flux: Promise<VatHandle | undefined>,
  ): Promise<VatHandle | undefined> {
    // Recorded before this function's first await, and `flux` has not been
    // awaited either, so no crank can run between the operation's first step and
    // this record. Anything that introduces an await above this line reopens the
    // window the record exists to close.
    //
    // Waiters see `undefined` rather than a failure, because by then the vat is
    // marked terminated and "gone" is what they should act on. The caller still
    // gets the failure, from `flux` itself.
    this.#vatsInFlux.set(
      vatId,
      flux.catch(() => undefined),
    );
    try {
      return await flux;
    } finally {
      this.#vatsInFlux.delete(vatId);
    }
  }

  /**
   * The handle for a vat, waiting first for any replacement or teardown in
   * flight. The counterpart to {@link getVat} for callers that can afford to
   * wait — a crank, above all, which would otherwise resolve a vat that is
   * merely between workers as one that no longer exists.
   *
   * @param vatId - The ID of the vat.
   * @returns A promise for the vat's handle.
   * @throws If the vat does not exist, or stopped existing while being awaited.
   */
  async provideVat(vatId: VatId): Promise<VatHandle> {
    const flux = this.#vatsInFlux.get(vatId);
    if (flux) {
      const successor = await flux;
      if (successor) {
        return successor;
      }
      // Torn down, or a restart that failed and marked the vat terminated
      // either way. Absent for good, which is what `getVat` reports.
      throw new VatNotFoundError(vatId);
    }
    return this.getVat(vatId);
  }

  /**
   * Ping a vat.
   *
   * @param vatId - The ID of the vat.
   * @returns A promise that resolves to the result of the ping.
   */
  async pingVat(vatId: VatId): Promise<PingVatResult> {
    const vat = this.getVat(vatId);
    return vat.ping();
  }

  /**
   * Get a vat.
   *
   * @param vatId - The ID of the vat.
   * @returns the vat's VatHandle.
   */
  getVat(vatId: VatId): VatHandle {
    const vat = this.#vats.get(vatId);
    if (vat === undefined) {
      throw new VatNotFoundError(vatId);
    }
    return vat;
  }

  /**
   * Check if a vat exists.
   *
   * @param vatId - The ID of the vat.
   * @returns true if the vat exists, false otherwise.
   */
  hasVat(vatId: VatId): boolean {
    return this.#vats.has(vatId);
  }

  /**
   * Gets a list of the IDs of all running vats.
   *
   * @returns An array of vat IDs.
   */
  getVatIds(): VatId[] {
    return Array.from(this.#vats.keys());
  }

  /**
   * Gets a list of information about all running vats.
   *
   * @returns An array of vat information records.
   */
  getVats(): {
    id: VatId;
    config: VatConfig;
    subclusterId: SubclusterId;
  }[] {
    return Array.from(this.#vats.values()).map((vat) => {
      const subclusterId = this.#kernelStore.getVatSubcluster(vat.vatId);
      return {
        id: vat.vatId,
        config: vat.config,
        subclusterId,
      };
    });
  }

  /**
   * Release the pin `launchVat` took on a vat's root, so the root can be
   * collected once its importers let go.
   *
   * For paths that end a vat's life. Tolerant of a root that is already gone,
   * since a vat can be torn down after the kernel has lost track of it.
   *
   * @param vatId - The ID of the vat whose life is ending.
   */
  releaseVatRootPin(vatId: VatId): void {
    const rootRef = this.#kernelStore.getRootObject(vatId);
    if (rootRef) {
      this.#kernelStore.unpinObject(rootRef);
    }
  }

  /**
   * Pin a vat root, on behalf of an embedder that wants to keep it addressable.
   *
   * Pins are counted, and `launchVat` already holds one for the vat's lifetime,
   * so this adds to that rather than replacing it.
   *
   * @param vatId - The ID of the vat.
   * @returns The KRef of the vat root.
   */
  pinVatRoot(vatId: VatId): KRef {
    const kref = this.#kernelStore.getRootObject(vatId);
    if (!kref) {
      throw new VatNotFoundError(vatId);
    }
    this.#kernelStore.pinObject(kref);
    return kref;
  }

  /**
   * Release one embedder pin on a vat root.
   *
   * Removes a single pin, and pins are fungible: this is only safe to call
   * against a pin `pinVatRoot` took. Called without one, it spends the pin
   * `launchVat` holds for the vat's lifetime, and the root becomes collectable
   * while the vat is still running — silently, since `unpinObject` tolerates a
   * count that has already reached zero.
   *
   * @param vatId - The ID of the vat.
   */
  unpinVatRoot(vatId: VatId): void {
    const kref = this.#kernelStore.getRootObject(vatId);
    if (!kref) {
      throw new VatNotFoundError(vatId);
    }
    this.#kernelStore.unpinObject(kref);
  }

  /**
   * Reap vats that match the filter.
   *
   * @param filter - A function that returns true if the vat should be reaped.
   */
  reapVats(filter: (vatId: VatId) => boolean = () => true): void {
    for (const vatID of this.getVatIds()) {
      if (filter(vatID)) {
        this.#kernelStore.scheduleReap(vatID);
      }
    }
  }

  /**
   * Terminate all vats and collect garbage.
   * This is for debugging purposes only.
   */
  async terminateAllVats(): Promise<void> {
    await this.#kernelQueue.waitForCrank();
    for (const id of this.getVatIds().reverse()) {
      await this.terminateVat(id);
      this.collectGarbage();
    }
  }

  /**
   * Collect garbage.
   * This is for debugging purposes only.
   */
  collectGarbage(): void {
    while (this.#kernelStore.nextTerminatedVatCleanup()) {
      // wait for all vats to be cleaned up
    }
    this.#kernelStore.collectGarbage();
  }
}
harden(VatManager);
