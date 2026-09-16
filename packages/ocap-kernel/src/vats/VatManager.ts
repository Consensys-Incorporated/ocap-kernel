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

/** How a caller awaiting queued work is answered. */
type Settler = { resolve: () => void; reject: (error: Error) => void };

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
   * Callers awaiting a queued restart, by vat.
   *
   * An array, because two requests for one vat are one restart: the second
   * caller wants a fresh worker and the first one's crank gives it one. Every
   * request queues an item all the same — a request that skipped the queue on
   * the strength of someone else's would wait forever if that item were rolled
   * away by an aborting crank — and the crank that arrives first settles the
   * whole list, leaving later items with nothing to do.
   */
  readonly #restartWaiters: Map<VatId, Settler[]>;

  /**
   * Callers awaiting a queued termination, by vat. Same shape as
   * {@link VatManager.#restartWaiters}.
   */
  readonly #terminationWaiters: Map<VatId, Settler[]>;

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
    this.#restartWaiters = new Map();
    this.#terminationWaiters = new Map();
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
      // `platformServices.launch` has already spawned the worker by the time
      // anything below it can fail, and `runVat` records no handle to reach it
      // by, so this is the only chance to stop it. `stopVat` is no use here:
      // there is neither a handle nor a `vatConfig` row for it to work from.
      await this.#platformServices
        .terminate(vatId)
        .catch((stopError: unknown) =>
          this.#logger.error(
            `Failed to stop the worker for vat ${vatId} after an incomplete launch:`,
            stopError,
          ),
        );
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
      // kernel has no record of.
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
      // `stopVat` marks the vat itself, but only if every write before the
      // mark succeeded. The mark is what makes the terminated-vat cleanup
      // reclaim the endpoint counters and the root's c-list pair, and a vat
      // this young has no decider promises for that cleanup to get wrong, so
      // here it is asserted rather than assumed.
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
    // A restart needs a live handle to read its config from and to come back
    // into; an ending vat does not, and must not. A failed relaunch leaves a
    // vat the store still lists and the kernel has no handle for, and retiring
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
    let recordFailure: Error | undefined;
    try {
      if (terminating) {
        this.#retireVat(vatId, terminationError as Error);
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
   * The mark goes last, and is not attempted if anything above it throws. It is
   * what makes the vat eligible for `nextTerminatedVatCleanup`, and that
   * cleanup deletes the decider promises' c-list entries on the stated
   * understanding that its caller has already rejected them. A vat marked after
   * those rejections failed is one whose subscribers hang for good, so a
   * failure part-way leaves a vat that has simply not been retired — its c-list
   * intact, and the whole step available to be tried again.
   *
   * Calling it twice records nothing the second time: a second
   * `releaseVatRootPin` would spend a pin this vat no longer holds.
   *
   * @param vatId - The vat being retired.
   * @param error - Why, for the rejections its subscribers are owed.
   */
  #retireVat(vatId: VatId, error: Error): void {
    // Ahead of the guard, and safe there because nothing below reads it: a vat
    // the store already calls dead must not keep a handle the router would go
    // on resolving.
    this.#vats.delete(vatId);
    if (this.#kernelStore.isVatTerminated(vatId)) {
      return;
    }
    const failure = makeKernelError('VAT_TERMINATED', error.message);
    for (const kpid of this.#kernelStore.getPromisesByDecider(vatId)) {
      this.#kernelQueue.resolvePromises(vatId, [[kpid, true, failure]]);
    }
    this.releaseVatRootPin(vatId);
    // Together, always. `cleanupTerminatedVat` sweeps `${vatId}.` keys, which
    // never match `vatConfig.${vatId}`, so a vat left with that row reads as
    // active again the moment the cleanup drops the mark.
    this.#kernelStore.deleteVat(vatId);
    this.#kernelStore.markVatAsTerminated(vatId);
  }

  /**
   * Terminate a vat with extreme prejudice.
   *
   * @param vatId - The ID of the vat.
   * @param reason - If the vat is being terminated, the reason for the termination.
   */
  async terminateVat(vatId: VatId, reason?: CapData<KRef>): Promise<void> {
    if (!this.#vats.has(vatId) && !this.#kernelStore.isVatActive(vatId)) {
      throw new VatNotFoundError(vatId);
    }
    // A restart outstanding when the termination is asked for is overtaken by
    // it, so its caller is told now rather than left waiting on a crank that
    // will find nothing to restart. A restart asked for after this cannot be
    // ordered against the termination at all, and is not covered.
    const supersedeRestart = VatManager.#takeWaiters(
      this.#restartWaiters,
      vatId,
    );
    supersedeRestart(new VatDeletedError(vatId));
    await this.#awaitQueuedWork(this.#terminationWaiters, vatId, () =>
      this.#kernelQueue.enqueueTerminateVat(vatId, reason),
    );
  }

  /**
   * End a vat. Called by the run loop, for a queued termination request.
   *
   * Carried out whether or not anyone is still waiting: unlike a restart, a
   * termination is an instruction rather than a request, and a request that
   * outlived the process that made it is one `initializeAllVats` has just
   * undone by relaunching the vat.
   *
   * @param vatId - The ID of the vat.
   * @param reason - The reason for the termination, if any.
   */
  async performVatTermination(
    vatId: VatId,
    reason?: CapData<KRef>,
  ): Promise<void> {
    const settle = VatManager.#takeWaiters(this.#terminationWaiters, vatId);
    if (!this.#vats.has(vatId) && !this.#kernelStore.isVatActive(vatId)) {
      // Already dead: the in-crank termination path or `terminateAllVats` got
      // here first, and this vat is exactly what the caller asked for.
      settle();
      return;
    }
    if (settle.count === 0) {
      this.#logger.debug(
        `Carrying out a termination of vat ${vatId} nobody is waiting for`,
      );
    }
    try {
      await this.stopVat(vatId, true, reason);
    } catch (error) {
      // Not thrown: the run loop's catch would roll the crank back, undoing
      // whatever of the death did get written and restoring the request, so
      // every later start would replay the same failing termination.
      this.#logger.error(`Termination of vat ${vatId} failed:`, error);
      settle(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    settle();
  }

  /**
   * Restarts a vat.
   *
   * Asks the run loop to do it rather than doing it here. A restart keeps the
   * vat's c-list while taking the vat itself out of the kernel's reach for as
   * long as launching a worker and negotiating with it takes, and doing that
   * alongside a running run loop means a crank can land in that window and read
   * a live vat as a dead one. In a crank of its own there is no window.
   *
   * @param vatId - The ID of the vat.
   * @returns A promise for the restarted vat.
   */
  async restartVat(vatId: VatId): Promise<VatHandle> {
    // The store as well as the handle: a vat between workers has no handle on
    // the books, and a request landing in that window is for a vat that is
    // coming back.
    if (!this.#vats.has(vatId) && !this.#kernelStore.isVatActive(vatId)) {
      throw new VatNotFoundError(vatId);
    }
    await this.#awaitQueuedWork(this.#restartWaiters, vatId, () =>
      this.#kernelQueue.enqueueRestartVat(vatId),
    );
    return this.getVat(vatId);
  }

  /**
   * Queue work for the run loop and wait for the crank that carries it out.
   *
   * @param waiters - The per-vat waiter lists for this kind of work.
   * @param vatId - The vat the work concerns.
   * @param enqueue - Puts the request on the run queue.
   */
  async #awaitQueuedWork(
    waiters: Map<VatId, Settler[]>,
    vatId: VatId,
    enqueue: () => void,
  ): Promise<void> {
    // Ahead of the waiter, so a refusal is this call's own rejection rather
    // than an unhandled one from a waiter nothing will ever await.
    enqueue();
    const { promise, resolve, reject } = makePromiseKit<void>();
    waiters.set(vatId, [...(waiters.get(vatId) ?? []), { resolve, reject }]);
    // The run loop is what carries the request out, and this work has no kernel
    // promise behind it the way a message result does, so nothing else would
    // ever settle this caller.
    const stopWatchingTheRunLoop = this.#kernelQueue.onRunLoopDeath(reject);
    try {
      await promise;
    } finally {
      stopWatchingTheRunLoop();
    }
  }

  /**
   * Take the callers waiting on a vat's queued work, so the crank about to do
   * it can answer them and later items find nothing left to do.
   *
   * @param waiters - The per-vat waiter lists for this kind of work.
   * @param vatId - The vat the work concerns.
   * @returns A function that settles them, rejecting if given a reason.
   */
  static #takeWaiters(
    waiters: Map<VatId, Settler[]>,
    vatId: VatId,
  ): ((error?: Error) => void) & { count: number } {
    const taken = waiters.get(vatId) ?? [];
    waiters.delete(vatId);
    const settle = (error?: Error): void => {
      for (const waiter of taken) {
        if (error) {
          waiter.reject(error);
        } else {
          waiter.resolve();
        }
      }
    };
    return Object.assign(settle, { count: taken.length });
  }

  /**
   * Replace a vat's worker. Called by the run loop, for a queued restart
   * request.
   *
   * @param vatId - The ID of the vat.
   */
  async performVatRestart(vatId: VatId): Promise<void> {
    const settle = VatManager.#takeWaiters(this.#restartWaiters, vatId);
    if (settle.count === 0) {
      // Nobody is waiting, so this item outlived the process that queued it:
      // `initializeAllVats` has already launched a fresh worker for this vat.
      this.#logger.debug(`Dropping a stale restart request for vat ${vatId}`);
      return;
    }
    if (!this.#vats.has(vatId) && !this.#kernelStore.isVatActive(vatId)) {
      // A termination queued after this request runs before it if the queue
      // was already busy, so the vat can be gone by the time this crank comes
      // round. Dropped rather than thrown: the alternative is a dead run loop
      // over work that is merely obsolete.
      const error = new VatNotFoundError(vatId);
      this.#logger.error(
        `Restart of vat ${vatId} dropped; the vat is gone:`,
        error,
      );
      settle(error);
      return;
    }
    try {
      // From the handle where there is one, so the incarnation that comes back
      // is configured like the one that left; from the store for a vat that is
      // between workers, which has no handle to read.
      const config =
        this.#vats.get(vatId)?.config ?? this.#kernelStore.getVatConfig(vatId);
      if (this.#vats.has(vatId)) {
        // A channel that will not close does not stop the new worker coming:
        // the handle is off the books and the old worker has been killed either
        // way, so failing here would retire a vat that is merely untidy.
        await this.stopVat(vatId, false).catch((stopError: unknown) =>
          this.#logger.error(
            `Old worker for vat ${vatId} would not shut down cleanly:`,
            stopError,
          ),
        );
      }
      await this.runVat(vatId, config);
    } catch (error) {
      // The vat has no worker and is not coming back, so it is terminated in
      // fact. `stopVat` also kills whatever worker the failed relaunch left
      // behind, which nothing else holds a handle to.
      //
      // Neither this nor the retirement may throw out of the crank, and not
      // only to keep the run loop alive: the run loop's catch rolls the crank
      // back, undoing the records written here and restoring this request to
      // the queue, so every later start would replay the same failing restart.
      await this.stopVat(vatId, true).catch((retireError: unknown) =>
        this.#logger.error(
          `Vat ${vatId} could not be retired after its restart failed; the store still calls it active:`,
          retireError,
        ),
      );
      this.#logger.error(
        `Restart of vat ${vatId} failed; terminating it:`,
        error,
      );
      settle(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    settle();
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
   *
   * `stopVat` rather than `terminateVat`: this is part of tearing the kernel
   * down, and `reset` has to work on a kernel whose run loop has died, which a
   * queued request could never be carried out on. The narrow "run loop is not
   * running, so direct writes are legal" mode that makes this safe is the last
   * of the control-plane moves, not this one.
   */
  async terminateAllVats(): Promise<void> {
    await this.#kernelQueue.waitForCrank();
    for (const id of this.getVatIds().reverse()) {
      await this.stopVat(id, true);
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
