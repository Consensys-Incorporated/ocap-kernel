import type { CapData } from '@endo/marshal';
import {
  VatAlreadyExistsError,
  VatDeletedError,
  VatNotFoundError,
} from '@metamask/kernel-errors';
import { stringify } from '@metamask/kernel-utils';
import { Logger, splitLoggerStream } from '@metamask/logger';

import type { KernelQueue } from '../KernelQueue.ts';
import { makeKernelError } from '../liveslots/kernel-marshal.ts';
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

/**
 * A vat being stopped, and the error its death is to be reported as. An ending
 * vat always has one, since `#retireVat` rejects the promises it was deciding
 * with it; a restarting vat must not, since `terminate` reads its absence as
 * the difference.
 */
type StopVatOptions = { vatId: VatId } & (
  | { terminating: true; terminationError: Error }
  | { terminating: false; terminationError?: never }
);

/** The handle `runVat` made, once `VatHandle.make` has returned one. */
type RunningVat = { handle?: VatHandle };

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
      // Attribute the failure to the specific vat by kernel id and name. Any
      // worker `runVat` started has already been stopped.
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
      // kernel has no record of. `stopVat` sets the terminated mark too, and
      // early enough that asserting it here could only add it where `stopVat`
      // stopped short of `deleteVat` — scheduling a cleanup for a vat whose
      // own store and subcluster row it will not reach.
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
      throw new Error(
        `Failed to launch vat ${vatId} (${vatName})${stopFailure ? ' (cleanup also failed)' : ''}`,
        { cause: error },
      );
    }
  }

  /**
   * Start a new or resurrected vat running.
   *
   * `launch` spawns the worker before the handshake that can fail, and a
   * handshake that fails records no handle to reach it by, so a worker left
   * over from one is stopped here — the one place that knows whether `launch`
   * got far enough to leave one.
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
    // Holds the handle so that a report can be matched against the one that
    // made it: a restart puts a new handle under the same vat id. Empty while
    // `make` runs, in which window the catch below answers for the channel.
    const running: RunningVat = {};
    let vat: VatHandle;
    try {
      vat = await VatHandle.make({
        vatId,
        vatConfig,
        vatStream,
        kernelStore: this.#kernelStore,
        kernelQueue: this.#kernelQueue,
        logger: vatLogger,
        allowedGlobalNames: this.#allowedGlobalNames,
        onStreamFailure: (error) =>
          this.#reportLostVat({ vatId, running, error }),
      });
    } catch (error) {
      await this.#platformServices
        .terminate(vatId)
        .catch((stopError: unknown) =>
          this.#logger.error(
            `Failed to stop the worker for vat ${vatId} after a failed handshake:`,
            stopError,
          ),
        );
      throw error;
    }
    running.handle = vat;
    this.#vats.set(vatId, vat);
  }

  /**
   * Take a handle's word that its channel has failed.
   *
   * @param options - Named options.
   * @param options.vatId - The vat whose channel failed.
   * @param options.running - The handle that reported, once there is one.
   * @param options.error - What the channel failed with.
   */
  #reportLostVat({
    vatId,
    running,
    error,
  }: {
    vatId: VatId;
    running: RunningVat;
    error: Error;
  }): void {
    const { handle } = running;
    if (!handle) {
      return;
    }
    this.#retireLostVat({ vatId, handle, error }).catch((failure) =>
      this.#logger.error(
        `Vat ${vatId} lost its worker and could not be retired, so the kernel still holds it as running; terminate it to try again:`,
        failure,
      ),
    );
  }

  /**
   * Retire a vat whose channel to its worker has failed.
   *
   * Nobody asked for this death, so nobody is waiting to be told of it: the
   * store learns of it here or not at all. Untold, the vat keeps its handle,
   * its `vatConfig` row and the promises it was deciding, so the kernel goes on
   * routing to a worker it cannot reach and the next boot brings it back.
   *
   * Between cranks, like `terminateVat`, and for a sharper reason. `#retireVat`
   * writes synchronously, so run inside an open delivery savepoint the whole
   * death is undone by any crank that goes on to abort — the ordinary vat-error
   * path, not a failure — while the handle this dropped from the running map
   * stays dropped, since nothing rolls memory back. That leaves a vat the store
   * calls alive and the kernel cannot reach, and no error anywhere. Waiting is
   * safe because the handle has already answered the callers this worker never
   * will, so a crank blocked on one of them is free to finish.
   *
   * A vat the kernel is itself stopping reports the same way, since closing a
   * channel with an error breaks the read its handle is draining. The identity
   * check covers that along with everything the wait may have let happen: by
   * then the vat may have been terminated, or restarted under a new handle.
   *
   * There is no one to retry this: a store failure here ends in a log line,
   * leaving the vat unmarked, undeleted and handle-less until someone
   * terminates it by hand. Said plainly in that log, for want of a better
   * answer than the caller this path does not have.
   *
   * @param options - Named options.
   * @param options.vatId - The vat whose channel failed.
   * @param options.handle - The handle that reported it.
   * @param options.error - What the channel failed with, for the rejections its
   *   subscribers are owed.
   */
  async #retireLostVat({
    vatId,
    handle,
    error,
  }: {
    vatId: VatId;
    handle: VatHandle;
    error: Error;
  }): Promise<void> {
    await this.#kernelQueue.waitForCrank();
    if (this.#vats.get(vatId) !== handle) {
      return;
    }
    await this.#stopVat({ vatId, terminating: true, terminationError: error });
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
    await this.#stopVat(
      terminating
        ? {
            vatId,
            terminating: true,
            terminationError: reason
              ? new Error(`Vat termination: ${reason.body}`)
              : new VatDeletedError(vatId),
          }
        : { vatId, terminating: false },
    );
  }

  /**
   * Stop a vat, given the error its death is to be reported as.
   *
   * Split from `stopVat` for the caller that has an error rather than a
   * serialized reason to give: a channel that died on its own.
   *
   * @param options - The vat to stop, and how.
   * @param options.vatId - The ID of the vat.
   * @param options.terminating - If true, the vat is being killed, if false,
   *   it's being restarted.
   * @param options.terminationError - Why it is ending, if it is.
   */
  async #stopVat({
    vatId,
    terminating,
    terminationError,
  }: StopVatOptions): Promise<void> {
    // A restart needs a live handle to read its config from and to come back
    // into; an ending vat does not, and must not. A failed relaunch leaves a
    // vat the store still lists and the kernel has no handle for, and retiring
    // it is exactly what puts that right.
    const vat = terminating ? this.#vats.get(vatId) : this.getVat(vatId);
    if (terminating && !vat && !this.#kernelStore.isVatActive(vatId)) {
      throw new VatNotFoundError(vatId);
    }
    let recordFailure: Error | undefined;
    try {
      if (terminating) {
        this.#retireVat(vatId, terminationError);
      } else {
        // A restart keeps the pin and the records: the same vat, and the same
        // root, are coming back. Only the handle goes.
        this.#vats.delete(vatId);
      }
    } catch (error) {
      // Held rather than thrown: the worker is being killed either way, and a
      // record that failed must not leave one running.
      recordFailure = error as Error;
    }
    await this.#platformServices
      .terminate(vatId, terminationError)
      .catch(this.#logger.error);
    try {
      await vat?.terminate(terminating, terminationError);
    } catch (error) {
      // A channel that will not close is survivable and a store left
      // half-written is not, so the latter is what the caller hears about.
      if (recordFailure === undefined) {
        throw error;
      }
      this.#logger.error(`Channel to vat ${vatId} would not close:`, error);
    }
    if (recordFailure !== undefined) {
      throw recordFailure;
    }
  }

  /**
   * Record a vat's death: everything the kernel has to remember about it, in
   * one synchronous step.
   *
   * Synchronous is the point. A death is four writes — the promises it was
   * deciding rejected, its root unpinned, its config and store dropped, the
   * terminated mark set — and none means much without the others. Interleaved
   * with awaits, as they used to be, a crank lands between them and reads a vat
   * that is half dead.
   *
   * Killing the worker is deliberately not part of it: that can fail, and a
   * store that says the vat is dead is worth more than one still waiting to
   * find out.
   *
   * The order is what a partial failure leaves behind. The mark comes after the
   * rejections because it is what makes the vat eligible for
   * `nextTerminatedVatCleanup`, and that cleanup deletes the decider promises'
   * c-list entries on the stated understanding that its caller has already
   * rejected them: a vat marked after those rejections failed is one whose
   * subscribers hang for good. It comes before `deleteVat` because `deleteVat`
   * drops the `vatConfig` row `stopVat` reads to decide there is still a vat
   * here to retire — a mark not reached by then could never be set, and the
   * c-list it gates never swept. So every way this can fail leaves either the
   * mark set, or the row that lets the whole step be tried again.
   *
   * What that ordering costs: a `deleteVat` that throws leaves a marked vat
   * whose `vatConfig` row survives, and `cleanupTerminatedVat` sweeps
   * `${vatId}.` keys, which never match `vatConfig.${vatId}` — so once the
   * cleanup drops the mark such a vat reads as active again. Retrying is what
   * closes that, and the failure propagates so that someone can.
   *
   * Which is why only the writes that may happen once are guarded: a second
   * `releaseVatRootPin` would spend an embedder's `pinVatRoot` pin instead of
   * the launch pin this vat no longer holds. `deleteVat` is idempotent, and
   * runs again to carry an interrupted retirement to the end.
   *
   * @param vatId - The vat being retired.
   * @param error - Why, for the rejections its subscribers are owed.
   */
  #retireVat(vatId: VatId, error: Error): void {
    // Ahead of the guard, and safe there because nothing below reads it: a vat
    // the store already calls dead must not keep a handle the router would go
    // on resolving.
    this.#vats.delete(vatId);
    if (!this.#kernelStore.isVatTerminated(vatId)) {
      const failure = makeKernelError('VAT_TERMINATED', error.message);
      for (const kpid of this.#kernelStore.getPromisesByDecider(vatId)) {
        this.#kernelQueue.resolvePromises(vatId, [[kpid, true, failure]]);
      }
      this.releaseVatRootPin(vatId);
      this.#kernelStore.markVatAsTerminated(vatId);
    }
    this.#kernelStore.deleteVat(vatId);
  }

  /**
   * Terminate a vat with extreme prejudice.
   *
   * @param vatId - The ID of the vat.
   * @param reason - If the vat is being terminated, the reason for the termination.
   */
  async terminateVat(vatId: VatId, reason?: CapData<KRef>): Promise<void> {
    await this.#kernelQueue.waitForCrank();
    await this.stopVat(vatId, true, reason);
  }

  /**
   * Restarts a vat.
   *
   * @param vatId - The ID of the vat.
   * @returns A promise for the restarted vat.
   */
  async restartVat(vatId: VatId): Promise<VatHandle> {
    await this.#kernelQueue.waitForCrank();
    const vat = this.getVat(vatId);
    const { config } = vat;
    await this.stopVat(vatId, false);
    await this.runVat(vatId, config);
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
