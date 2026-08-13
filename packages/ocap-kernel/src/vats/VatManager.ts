import type { CapData } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
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
   * Vats being torn down, by ID, each mapped to a promise for the teardown.
   * {@link provideVat} waits on these, which is what keeps the kernel's answer
   * about a dying vat in step with the store's: by the time a waiter is told the
   * vat is gone, it is marked terminated, and callers that must tell "terminated"
   * from "missing" — {@link KernelRouter}'s endpoint lookup above all — get the
   * former rather than a disagreement to raise.
   *
   * Recorded rather than guarded against: the run loop is free to run cranks
   * throughout, and a delivery that arrives mid-flux waits for the vat instead
   * of the flux waiting for the run loop. Inverted the other way — a lock the
   * operation holds while the loop stands still — the holder must never await
   * anything the run loop has to deliver, which is a much sharper edge.
   *
   * Only termination goes through here. A restart is queued for the run loop
   * (see {@link restartVat}), which leaves no window at all; termination cannot
   * be, because it has to work on a kernel whose run loop has died.
   */
  readonly #vatsInFlux: Map<VatId, Promise<void>>;

  /**
   * Callers waiting for the run loop to carry out a queued restart, by vat ID.
   * In RAM only: a request that outlives the kernel that queued it is still in
   * the run queue, and is carried out with nobody left to tell.
   */
  readonly #restartWaiters: Map<
    VatId,
    { resolve: () => void; reject: (error: unknown) => void }
  >;

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
    this.#restartWaiters = new Map();
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
      // `stopVat` records the vat as dead before it touches the worker, so
      // whatever store records the partial launch did write — the endpoint
      // counters, the root's c-list pair, its owner entry — are reclaimed by the
      // terminated-vat cleanup even if the worker refuses to go.
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
      // `stopVat` normally records the death itself, via `#retireVat`, before it
      // touches the worker. But it can refuse before it gets that far — a vat
      // the kernel has no handle for and the store does not call active is one
      // it declines outright — and a partial launch is exactly the shape that
      // reaches. The mark is what makes the terminated-vat cleanup reclaim the
      // endpoint counters, the root's c-list pair and its owner entry, so it is
      // asserted here rather than assumed. Marking an already-marked vat is a
      // no-op.
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
      onCriticalFailure: (error) => {
        // The vat's channel has broken, so nothing can be delivered to it again
        // and no worker teardown is going to change that. Retire it rather than
        // leaving a handle the router will keep resolving successfully, which is
        // a crank that never completes: the write goes nowhere and the RPC
        // client has no timeout.
        this.#logger.error(`Retiring vat ${vatId} after a fatal error:`, error);
        this.#retireVat(vatId, error);
      },
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
    // A restart needs a live handle to read its config from and to come back
    // into; an ending vat does not, and must not, since the vat may be one the
    // store still lists while the kernel has already lost its handle. Retiring
    // it is exactly what puts that right.
    const vat = terminating ? this.#vats.get(vatId) : this.getVat(vatId);
    if (terminating && !vat && !this.#kernelStore.isVatActive(vatId)) {
      throw new VatNotFoundError(vatId);
    }
    let terminationError: Error | undefined;
    if (reason) {
      terminationError = new Error(`Vat termination: ${reason.body}`);
    } else if (terminating) {
      terminationError = new VatDeletedError(vatId);
    }
    if (terminating) {
      // Everything the kernel has to record about this vat's death, before the
      // first await below. See {@link #retireVat}.
      this.#retireVat(vatId, terminationError as Error);
    } else {
      // A restart keeps the pin and the records: the same vat, and the same
      // root, are coming back. Only the handle goes.
      this.#vats.delete(vatId);
    }
    // Best-effort from here on, and deliberately after the records: the worker
    // is being killed either way, and a teardown that fails must not leave the
    // kernel's account of the vat half-written.
    await this.#platformServices
      .terminate(vatId, terminationError)
      .catch(this.#logger.error);
    await vat?.terminate(terminating, terminationError);
  }

  /**
   * Record a vat's death: everything the kernel has to remember about it, in one
   * synchronous step.
   *
   * Synchronous is the whole point. A vat's death is four writes — the promises
   * it was deciding rejected, its root unpinned, its config and store dropped,
   * the terminated mark set — and none of them means much without the others.
   * Interleaved with awaits, as they used to be, a failure part-way leaves states
   * nothing recovers from. The sharpest: marked terminated while `vatConfig`
   * survives (only `deleteVat` removes it; `cleanupTerminatedVat` sweeps
   * `${vatId}.` keys, which never match `vatConfig.${vatId}`) reads as *active*
   * again the moment cleanup drops the mark, and `KernelRouter`'s endpoint lookup
   * kills the run loop over the disagreement. With no await between them, that
   * state cannot arise.
   *
   * Killing the worker is deliberately not part of this. It can fail, and
   * nothing here needs it to have succeeded — a vat being retired has a worker
   * that is gone or going, and a store that says so is worth more than a store
   * still waiting to find out.
   *
   * @param vatId - The vat being retired.
   * @param error - Why, for the rejections its subscribers are owed.
   */
  #retireVat(vatId: VatId, error: Error): void {
    const failure = makeKernelError('VAT_TERMINATED', error.message);
    // First, while the c-list this reads through is still there: subscribers are
    // told rather than left waiting on a decider that no longer exists.
    for (const kpid of this.#kernelStore.getPromisesByDecider(vatId)) {
      this.#kernelQueue.resolvePromises(vatId, [[kpid, true, failure]]);
    }
    this.#vats.delete(vatId);
    // Before `deleteVat`, which is fine either way, but the root is found
    // through the c-list and this keeps the reads ahead of the deletes.
    this.releaseVatRootPin(vatId);
    this.#kernelStore.deleteVat(vatId);
    // Last: the mark is what makes the vat eligible for
    // `nextTerminatedVatCleanup`, which reclaims the c-list everything above
    // needed, and which must not run against a vat still being written.
    this.#kernelStore.markVatAsTerminated(vatId);
  }

  /**
   * Terminate a vat with extreme prejudice.
   *
   * @param vatId - The ID of the vat.
   * @param reason - If the vat is being terminated, the reason for the termination.
   */
  async terminateVat(vatId: VatId, reason?: CapData<KRef>): Promise<void> {
    // A restart still queued for this vat is overtaken by the termination, and
    // will be dropped when the run loop reaches it. Tell whoever asked for it
    // now, rather than leaving them waiting on a request that can no longer be
    // carried out.
    const superseded = this.#restartWaiters.get(vatId);
    this.#restartWaiters.delete(vatId);
    superseded?.reject(new VatDeletedError(vatId));
    // Not queued for the run loop the way `restartVat` is: teardown has to work
    // on a kernel whose run loop has died, which `reset` depends on. So this one
    // closes its window with a flux record instead.
    await this.#trackFlux(vatId, async () => this.stopVat(vatId, true, reason));
  }

  /**
   * Restarts a vat.
   *
   * Asks the run loop to do it, rather than doing it here. A restart keeps the
   * vat's c-list while taking the vat itself out of the kernel's reach for as
   * long as launching a worker and negotiating with it takes, and doing that
   * alongside a running run loop means a crank can land in the window and read a
   * live vat as a dead one. In a crank of its own there is no window: the run
   * loop is the only thing that delivers, and it is here instead.
   *
   * @param vatId - The ID of the vat.
   * @returns A promise for the restarted vat.
   */
  async restartVat(vatId: VatId): Promise<VatHandle> {
    // Rejects an unknown vat here rather than from inside a crank, where the
    // caller could only be told by way of a dead run loop.
    this.getVat(vatId);
    const restarted = this.#awaitRestart(vatId);
    try {
      this.#kernelQueue.enqueueRestartVat(vatId);
    } catch (error) {
      // Nothing was queued, so nothing will ever settle the waiter just
      // registered. Take it back out: left behind, the next request for this vat
      // would reject it as superseded, and since this caller never got as far as
      // awaiting it that rejection would go unhandled.
      this.#restartWaiters.delete(vatId);
      throw error;
    }
    await restarted;
    return this.getVat(vatId);
  }

  /**
   * Replace a vat's worker. Called by the run loop, for a queued restart request.
   *
   * @param vatId - The ID of the vat.
   */
  async performVatRestart(vatId: VatId): Promise<void> {
    const settle = this.#restartWaiters.get(vatId);
    this.#restartWaiters.delete(vatId);
    if (!this.#vats.has(vatId)) {
      // The vat went away between the request and this crank. `terminateVat`
      // does not go through the run queue, so it can land in that window, and a
      // request for a vat that no longer exists has nothing to carry out and
      // nothing to put right. Dropped rather than thrown: the alternative is a
      // dead run loop over work that is merely obsolete.
      const error = new VatNotFoundError(vatId);
      this.#logger.error(
        `Restart of vat ${vatId} dropped; the vat is gone:`,
        error,
      );
      settle?.reject(error);
      return;
    }
    try {
      // Read before the handle goes away, and from the handle rather than the
      // store, so the incarnation that comes back is configured like the one
      // that left.
      const { config } = this.getVat(vatId);
      await this.stopVat(vatId, false);
      await this.runVat(vatId, config);
    } catch (error) {
      // The vat has no worker and is not coming back, so it is terminated in
      // fact; record that so the rest of the kernel agrees. This must not throw
      // out of the crank, and not only to keep the run loop alive: the run
      // loop's catch rolls the crank back, which would undo the very records
      // written here *and* restore this request to the run queue, so the next
      // process start would replay the same failing restart forever.
      this.#retireVat(
        vatId,
        error instanceof Error ? error : new Error(String(error)),
      );
      this.#logger.error(
        `Restart of vat ${vatId} failed; terminating it:`,
        error,
      );
      settle?.reject(error);
      return;
    }
    settle?.resolve();
  }

  /**
   * Wait for the run loop to carry out this vat's queued restart.
   *
   * Registered before the request is enqueued, so a crank cannot complete the
   * restart before there is anything to tell. A request that outlives the kernel
   * that queued it has no waiter when the new one gets to it, which is why
   * settling is optional.
   *
   * @param vatId - The vat being restarted.
   * @returns A promise that settles when the restart does.
   */
  async #awaitRestart(vatId: VatId): Promise<void> {
    const { promise, resolve, reject } = makePromiseKit<void>();
    // One waiter per vat: a second request for a vat already awaiting one would
    // otherwise strand the first caller forever.
    this.#restartWaiters
      .get(vatId)
      ?.reject(new Error(`Restart of vat ${vatId} superseded by a later one`));
    this.#restartWaiters.set(vatId, { resolve, reject });
    return await promise;
  }

  /**
   * Run an operation that takes a vat out of the kernel's reach, recording the
   * vat as mid-flux for its duration so a delivery arriving meanwhile waits for
   * the outcome instead of reading the vat as gone.
   *
   * Both steps live here, in this order, because the order is the whole
   * mechanism and reversing it deadlocks. See the comments inline; a caller
   * cannot get it wrong because a caller does not sequence it.
   *
   * @param vatId - The vat being taken out of reach.
   * @param start - Begins the operation. Called once, after the wait.
   * @returns The operation's own result, failure included.
   */
  async #trackFlux(vatId: VatId, start: () => Promise<void>): Promise<void> {
    // First: wait out the crank in flight, so the operation does not pull a
    // worker out from under a delivery. This has to happen *before* the record
    // exists. A crank that is already running has not necessarily reached its
    // endpoint lookup yet, so if the record were there it would find it and wait
    // for this operation — which is waiting for that crank to end.
    await this.#kernelQueue.waitForCrank();
    const flux = start();
    // Second: record, with neither `start()` nor this function having awaited
    // since, so no crank can run between the operation's first step and the
    // record. An await introduced between these two lines reopens the window the
    // record exists to close.
    //
    // Waiters see a plain completion rather than a failure, because the vat ends
    // up marked terminated either way — `#endVat` marks it in a `finally` — and
    // "gone" is what they should act on. The caller still gets the failure, from
    // `flux` itself.
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
   * The handle for a vat, waiting first for any teardown in flight. The
   * counterpart to {@link getVat} for callers that can afford to wait — a crank,
   * above all, which would otherwise be told a vat is missing before the store
   * records why.
   *
   * @param vatId - The ID of the vat.
   * @returns A promise for the vat's handle.
   * @throws If the vat does not exist, or stopped existing while being awaited.
   */
  async provideVat(vatId: VatId): Promise<VatHandle> {
    const flux = this.#vatsInFlux.get(vatId);
    if (flux) {
      // Only a teardown is ever recorded, so waiting it out settles the vat's
      // fate: it is gone, and the store now says so.
      await flux;
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
