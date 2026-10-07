import type { CapData } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import {
  VatAlreadyExistsError,
  VatDeletedError,
  VatNotFoundError,
} from '@metamask/kernel-errors';
import { stringify } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger, splitLoggerStream } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';

import type { KernelQueue } from '../KernelQueue.ts';
import {
  makeFatalKernelError,
  makeKernelError,
} from '../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  CrankResult,
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

type StopVatOptions = { vatId: VatId } & (
  | { terminating: true; terminationError: Error }
  | { terminating: false; terminationError?: never }
);

/** Set once `VatHandle.make` returns. */
type RunningVat = { handle?: VatHandle };

/** How a caller awaiting queued work is answered. */
type Waiter<Value> = {
  resolve: (value: Value) => void;
  reject: (error: Error) => void;
  /**
   * Set once the waiter is promised an answer that does not depend on the run
   * loop, so the loop's death no longer needs to give one.
   */
  answerDue: boolean;
};

/** The callers a crank took, and the ways it can answer them. */
type TakenWaiters<Value> = {
  count: number;
  /** Answer now, from a crank's `afterCommit`. */
  answer: (outcome: Value | Error) => void;
  /**
   * Answer once the crank ends, whether or not it commits or the run loop
   * survives it, so callers wake to what it committed. They may wake inside
   * the next crank, which can still roll back what they write.
   */
  answerOnceCrankEnds: (outcome: Value | Error) => void;
};

/**
 * A relaunch's view of the worker it is starting: set abandoned when it gives
 * up, and given the worker's channel once there is one, to close.
 */
type Launch = {
  abandoned: boolean;
  stream?: DuplexStream<JsonRpcMessage, JsonRpcMessage>;
};

/** How long a restart waits for the new worker before giving up on it. */
export const DEFAULT_VAT_RELAUNCH_TIMEOUT_MS = 30_000;

/** The longest delay `setTimeout` honours; it treats anything above as 1 ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

type VatManagerOptions = {
  platformServices: PlatformServices;
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
  logger?: Logger;
  allowedGlobalNames?: AllowedGlobalName[] | undefined;
  vatRelaunchTimeoutMs?: number | undefined;
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
   * The first crank for a vat settles the whole list, so later items find it
   * empty. Every request still queues its own item: one relying on another's
   * would wait forever if that item were rolled away.
   */
  readonly #restartWaiters: Map<VatId, Waiter<VatHandle>[]>;

  readonly #terminationWaiters: Map<VatId, Waiter<undefined>[]>;

  /**
   * Restart callers a queued termination has overtaken, or that asked while
   * one was pending, by vat, for its crank to answer. Not answered sooner: a
   * termination held during a crank that kills the run loop is never written,
   * and they must hear of the death.
   */
  readonly #supersededRestarts: Map<VatId, Waiter<VatHandle>[]>;

  readonly #pendingTerminations: Map<VatId, number>;

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

  readonly #vatRelaunchTimeoutMs: number;

  /**
   * Creates a new VatManager instance.
   *
   * @param options - Constructor options.
   * @param options.platformServices - Platform-specific services for launching vat workers.
   * @param options.kernelStore - The kernel's persistent state store.
   * @param options.kernelQueue - The kernel's message queue for scheduling deliveries.
   * @param options.logger - Logger instance for debugging and diagnostics.
   * @param options.allowedGlobalNames - Optional list of allowed global names for vat endowments.
   * @param options.vatRelaunchTimeoutMs - How long a restart waits for the new worker.
   */
  constructor({
    platformServices,
    kernelStore,
    kernelQueue,
    logger,
    allowedGlobalNames,
    vatRelaunchTimeoutMs = DEFAULT_VAT_RELAUNCH_TIMEOUT_MS,
  }: VatManagerOptions) {
    this.#vats = new Map();
    this.#restartWaiters = new Map();
    this.#terminationWaiters = new Map();
    this.#supersededRestarts = new Map();
    this.#pendingTerminations = new Map();
    this.#platformServices = platformServices;
    this.#kernelStore = kernelStore;
    this.#kernelQueue = kernelQueue;
    this.#logger = logger ?? new Logger('VatManager');
    this.#allowedGlobalNames = allowedGlobalNames;
    if (
      !(vatRelaunchTimeoutMs > 0 && vatRelaunchTimeoutMs <= MAX_TIMER_DELAY_MS)
    ) {
      throw new RangeError(
        `vatRelaunchTimeoutMs must be more than 0 and at most ${MAX_TIMER_DELAY_MS}; got ${String(vatRelaunchTimeoutMs)}`,
      );
    }
    this.#vatRelaunchTimeoutMs = vatRelaunchTimeoutMs;
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
      // No mark here: `stopVat` marks before `deleteVat`, so marking after it
      // failed could schedule a cleanup for a vat `deleteVat` never reached.
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
   * Stops the worker if the handshake fails, since no handle is left to stop
   * it by.
   *
   * @param vatId - The ID of the vat to start.
   * @param vatConfig - Its configuration.
   */
  async runVat(vatId: VatId, vatConfig: VatConfig): Promise<void> {
    await this.#startVat({ vatId, vatConfig });
  }

  /**
   * Start a vat running, unless the launch is abandoned before it finishes.
   *
   * @param options - Named options.
   * @param options.vatId - The ID of the vat to start.
   * @param options.vatConfig - Its configuration.
   * @param options.launch - Abandoned by a relaunch that gave up waiting.
   */
  async #startVat({
    vatId,
    vatConfig,
    launch,
  }: {
    vatId: VatId;
    vatConfig: VatConfig;
    launch?: Launch;
  }): Promise<void> {
    if (this.#vats.has(vatId)) {
      throw new VatAlreadyExistsError(vatId);
    }
    const stream = await this.#platformServices.launch(vatId, vatConfig);
    if (launch?.abandoned) {
      // Started after the timeout's stop found nothing to stop.
      await this.#platformServices
        .terminate(vatId)
        .catch((error: unknown) =>
          this.#logger.error(
            `Failed to stop the worker for vat ${vatId} after its relaunch timed out:`,
            error,
          ),
        );
      return;
    }
    if (launch) {
      launch.stream = stream;
    }
    const { kernelStream: vatStream, loggerStream } = splitLoggerStream(stream);
    const vatLogger = this.#logger.subLogger({ tags: [vatId] });
    vatLogger.injectStream(
      loggerStream as unknown as Parameters<typeof vatLogger.injectStream>[0],
      (error) => this.#logger.error(`Vat ${vatId} error: ${stringify(error)}`),
    );
    // Matches a report to the handle that made it, since a restart reuses the
    // vat id. Until `make` returns, the catch below covers a failed channel.
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
    if (launch?.abandoned) {
      // The crank that gave up on this worker retires the vat, so a handle
      // registered now would bring it back.
      vat
        .terminate(true)
        .catch((error: unknown) =>
          this.#logger.error(
            `Failed to close the channel of vat ${vatId} after its relaunch timed out:`,
            error,
          ),
        );
      return;
    }
    running.handle = vat;
    this.#vats.set(vatId, vat);
  }

  /**
   * Start a restarted vat, giving up if its worker is not ready in time. The
   * restart's crank waits on this, and so does the whole run loop.
   *
   * @param vatId - The ID of the vat to start.
   * @param vatConfig - Its configuration.
   */
  async #relaunchVat(vatId: VatId, vatConfig: VatConfig): Promise<void> {
    const launch: Launch = { abandoned: false };
    const starting = this.#startVat({ vatId, vatConfig, launch });
    const timeoutError = new Error(
      `Vat ${vatId} did not start within ${this.#vatRelaunchTimeoutMs} ms`,
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(timeoutError),
        this.#vatRelaunchTimeoutMs,
      );
    });
    try {
      await Promise.race([starting, timedOut]);
    } catch (error) {
      if (error === timeoutError) {
        launch.abandoned = true;
        starting.catch(() => undefined);
        // Closed so a handshake still under way fails rather than writing the
        // vat's state after the crank has retired it.
        launch.stream
          ?.end(timeoutError)
          .catch((closeError: unknown) =>
            this.#logger.error(
              `Failed to close the channel of vat ${vatId} after its relaunch timed out:`,
              closeError,
            ),
          );
        // Not awaited: a platform that is stuck launching may be stuck
        // stopping too.
        this.#platformServices
          .terminate(vatId)
          .catch((stopError: unknown) =>
            this.#logger.error(
              `Failed to stop the worker for vat ${vatId} after its relaunch timed out:`,
              stopError,
            ),
          );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Retire a vat whose handle reports a failed channel.
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
   * Waits for the current crank, since an aborting crank would roll back the
   * retirement but not the handle's removal from `#vats`. Skips a handle that
   * is no longer the vat's: the kernel may have stopped or restarted it.
   *
   * @param options - Named options.
   * @param options.vatId - The vat whose channel failed.
   * @param options.handle - The handle that reported it.
   * @param options.error - What the channel failed with.
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
   * Stop a vat, given an error rather than a serialized reason.
   *
   * @param options - The vat to stop, and how.
   * @param options.vatId - The ID of the vat.
   * @param options.terminating - If true, the vat is being killed, if false,
   *   it's being restarted.
   * @param options.terminationError - Why it is ending, if terminating.
   */
  async #stopVat({
    vatId,
    terminating,
    terminationError,
  }: StopVatOptions): Promise<void> {
    // A terminating vat may have no handle: a failed relaunch leaves one
    // persisted but not running.
    const vat = terminating ? this.#vats.get(vatId) : this.getVat(vatId);
    if (terminating && !this.#isVatKnown(vatId)) {
      throw new VatNotFoundError(vatId);
    }
    let recordFailure: Error | undefined;
    try {
      if (terminating) {
        this.#retireVat(vatId, terminationError);
      } else {
        // A restart keeps the pin and the records.
        this.#vats.delete(vatId);
      }
    } catch (error) {
      // Rethrown below, once the worker is stopped.
      recordFailure = error as Error;
    }
    // Logged rather than thrown, so a restart still relaunches: the platform
    // forgets a worker even when stopping it fails.
    await this.#platformServices
      .terminate(vatId, terminationError)
      .catch((error: unknown) =>
        this.#logger.error(`Worker for vat ${vatId} would not stop:`, error),
      );
    // Not awaited: an end that never settles would hold the crank, and with it
    // the run loop, open. Logged rather than thrown, since the worker is gone
    // and the records are what decide whether the vat is.
    vat
      ?.terminate(terminating, terminationError)
      .catch((error: unknown) =>
        this.#logger.error(`Channel to vat ${vatId} would not close:`, error),
      );
    if (recordFailure !== undefined) {
      throw recordFailure;
    }
  }

  /**
   * Record a vat's death in one synchronous step, so no crank sees it half
   * done.
   *
   * The mark follows the rejections, which the cleanup it schedules assumes
   * happened, and precedes `deleteVat`, which drops the `vatConfig` row a retry
   * needs to find the vat. The guard keeps a retry from unpinning twice and
   * spending an embedder's pin.
   *
   * @param vatId - The vat being retired.
   * @param error - Why it is being retired.
   */
  #retireVat(vatId: VatId, error: Error): void {
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
   * @param reason - Why the vat is being terminated, if given.
   */
  async terminateVat(vatId: VatId, reason?: CapData<KRef>): Promise<void> {
    if (!this.#isVatKnown(vatId)) {
      throw new VatNotFoundError(vatId);
    }
    // Only once the termination is queued: a refused one leaves the vat
    // running and the restart still due.
    await this.#awaitQueuedWork(this.#terminationWaiters, vatId, () => {
      this.#kernelQueue.enqueueTerminateVat(vatId, reason);
      this.#pendingTerminations.set(
        vatId,
        (this.#pendingTerminations.get(vatId) ?? 0) + 1,
      );
      const overtaken = this.#restartWaiters.get(vatId);
      if (overtaken) {
        this.#restartWaiters.delete(vatId);
        this.#parkRestarts(vatId, overtaken);
      }
    });
  }

  /**
   * Hand restart callers to the vat's pending termination, for its crank to
   * answer.
   *
   * @param vatId - The vat.
   * @param waiters - The restart callers.
   */
  #parkRestarts(vatId: VatId, waiters: Waiter<VatHandle>[]): void {
    this.#supersededRestarts.set(vatId, [
      ...(this.#supersededRestarts.get(vatId) ?? []),
      ...waiters,
    ]);
  }

  /**
   * End a vat. Called by the run loop, for a queued termination request.
   *
   * Carried out whether or not anyone is still waiting: a termination is an
   * instruction, and one that outlived its process names a vat the boot has
   * just relaunched.
   *
   * @param vatId - The ID of the vat.
   * @param reason - The reason for the termination, if any.
   * @returns Irrevocable once `stopVat` has run, whether or not it threw;
   *   `undefined` for a vat already gone.
   */
  async performVatTermination(
    vatId: VatId,
    reason?: CapData<KRef>,
  ): Promise<CrankResult | undefined> {
    const taken = this.#takeWaiters(this.#terminationWaiters, vatId);
    // Not before the teardown ends: a restart asked for during it must still
    // wait for this crank, whose failure can leave the vat known.
    const answerOnceCrankEnds = (failure?: Error): void => {
      const pending = (this.#pendingTerminations.get(vatId) ?? 0) - 1;
      if (pending > 0) {
        this.#pendingTerminations.set(vatId, pending);
      } else {
        this.#pendingTerminations.delete(vatId);
      }
      const superseded = this.#takeWaiters(this.#supersededRestarts, vatId);
      taken.answerOnceCrankEnds(failure);
      superseded.answerOnceCrankEnds(
        failure
          ? new Error(
              `Restart of vat ${vatId} was overtaken by a termination that failed`,
              { cause: failure },
            )
          : new VatDeletedError(vatId),
      );
    };
    if (!this.#isVatKnown(vatId)) {
      // Already dead: the in-crank termination path or `terminateAllVats` got
      // here first, and this vat is exactly what the caller asked for.
      answerOnceCrankEnds();
      return undefined;
    }
    if (taken.count === 0) {
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
      const failure = new Error(`Termination of vat ${vatId} failed`, {
        cause: error,
      });
      this.#logger.error(failure.message, error);
      answerOnceCrankEnds(failure);
      return harden({ irrevocable: true });
    }
    answerOnceCrankEnds();
    return harden({ irrevocable: true });
  }

  /**
   * Restarts a vat.
   *
   * Queued for the run loop, so no crank can observe the vat between workers.
   *
   * @param vatId - The ID of the vat.
   * @returns A promise for the restarted vat.
   */
  async restartVat(vatId: VatId): Promise<VatHandle> {
    if (!this.#isVatKnown(vatId)) {
      throw new VatNotFoundError(vatId);
    }
    if (this.#pendingTerminations.has(vatId)) {
      // Answered by the termination's crank, with no item of its own: a
      // restart item still queued ahead of the termination would take this
      // caller and relaunch a vat about to die.
      return await this.#awaitQueuedWork(this.#supersededRestarts, vatId, () =>
        this.#kernelQueue.assertRunLoopAlive('restart a vat'),
      );
    }
    // The handle this restart made, rather than whatever `#vats` holds once
    // the caller wakes: a later restart's crank may have started by then.
    return await this.#awaitQueuedWork(this.#restartWaiters, vatId, () =>
      this.#kernelQueue.enqueueRestartVat(vatId),
    );
  }

  /**
   * Queue work for the run loop and wait for the crank that carries it out.
   *
   * @param waiters - The per-vat waiter lists for this kind of work.
   * @param vatId - The vat the work concerns.
   * @param enqueue - Puts the request on the run queue.
   * @returns What the crank answered with.
   */
  async #awaitQueuedWork<Value>(
    waiters: Map<VatId, Waiter<Value>[]>,
    vatId: VatId,
    enqueue: () => void,
  ): Promise<Value> {
    // Ahead of the waiter, so a refusal is this call's own rejection rather
    // than an unhandled one from a waiter nothing will ever await.
    enqueue();
    const { promise, resolve, reject } = makePromiseKit<Value>();
    const waiter: Waiter<Value> = { resolve, reject, answerDue: false };
    waiters.set(vatId, [...(waiters.get(vatId) ?? []), waiter]);
    // Not once a crank has promised an answer: it may have committed the work
    // before the loop died.
    const stopWatchingTheRunLoop = this.#kernelQueue.onRunLoopDeath((error) => {
      if (!waiter.answerDue) {
        reject(error);
      }
    });
    try {
      return await promise;
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
   * @returns The callers taken, and the ways to answer them.
   */
  #takeWaiters<Value>(
    waiters: Map<VatId, Waiter<Value>[]>,
    vatId: VatId,
  ): TakenWaiters<Value> {
    const taken = waiters.get(vatId) ?? [];
    waiters.delete(vatId);
    const answer = (outcome: Value | Error): void => {
      for (const waiter of taken) {
        waiter.answerDue = true;
        if (outcome instanceof Error) {
          waiter.reject(outcome);
        } else {
          waiter.resolve(outcome);
        }
      }
    };
    const answerOnceCrankEnds = (outcome: Value | Error): void => {
      for (const waiter of taken) {
        waiter.answerDue = true;
      }
      this.#kernelQueue
        .waitForCrank()
        .then(() => answer(outcome))
        .catch(this.#logger.error);
    };
    return { count: taken.length, answer, answerOnceCrankEnds };
  }

  /**
   * Reject every caller waiting on queued work, for a kernel discarding its
   * run queue. Vat ids are reused once the store is cleared, so a waiter left
   * behind would be answered with an unrelated vat.
   *
   * @param error - What to reject them with.
   */
  abandonQueuedWork(error: Error): void {
    this.#kernelQueue.discardHeldRequests();
    for (const waiters of [
      this.#restartWaiters,
      this.#terminationWaiters,
      this.#supersededRestarts,
    ]) {
      const abandoned = [...waiters.values()].flat();
      waiters.clear();
      for (const waiter of abandoned) {
        waiter.reject(error);
      }
    }
    this.#pendingTerminations.clear();
  }

  /**
   * Replace a vat's worker. Called by the run loop, for a queued restart
   * request.
   *
   * @param vatId - The ID of the vat.
   * @returns The crank outcome: an abort and a termination if the relaunch
   *   failed, otherwise the callers' answer, for once the crank commits.
   */
  async performVatRestart(vatId: VatId): Promise<CrankResult | undefined> {
    const taken = this.#takeWaiters(this.#restartWaiters, vatId);
    if (taken.count === 0) {
      // Nobody is waiting: a termination overtook the restart, an earlier crank
      // answered every caller, this item outlived the process that queued it,
      // or an aborted restart put it back.
      this.#logger.debug(`Dropping a stale restart request for vat ${vatId}`);
      return undefined;
    }
    if (!this.#isVatKnown(vatId)) {
      // A termination queued ahead of this request, or one a crank carried
      // out itself, can retire the vat before this crank comes round. Dropped
      // rather than thrown: the alternative is a dead run loop over work that
      // is merely obsolete.
      this.#logger.warn(`Restart of vat ${vatId} dropped; the vat is gone`);
      const error = new VatDeletedError(vatId);
      return harden({ afterCommit: async () => taken.answer(error) });
    }
    try {
      // From the handle where there is one, so the incarnation that comes back
      // is configured like the one that left; from the store for a vat that is
      // between workers, which has no handle to read.
      const oldHandle = this.#vats.get(vatId);
      const config = oldHandle?.config ?? this.#kernelStore.getVatConfig(vatId);
      if (oldHandle) {
        await this.stopVat(vatId, false);
      }
      await this.#relaunchVat(vatId, config);
    } catch (error) {
      const failure = new Error(
        `Vat ${vatId} was terminated after its restart failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      this.#logger.error(failure.message, error);
      // Not `answer` from `afterCommit`, which an aborted crank skips.
      taken.answerOnceCrankEnds(failure);
      // Through the crank result, so the run loop rolls back before retiring
      // the vat: what the failed `initVat` buffered would otherwise be flushed
      // on behalf of a vat that no longer exists. The rollback restores this
      // request, which then finds no waiters and is dropped.
      return harden({
        abort: true,
        terminate: {
          vatId,
          reject: true,
          info: makeFatalKernelError('INTERNAL_ERROR', failure.message),
        },
      });
    }
    // Only once the crank commits: one that then fails, in its collection or
    // its audit, rolls the restart back and kills the run loop, which rejects
    // these callers instead.
    const handle = this.getVat(vatId);
    return harden({ afterCommit: async () => taken.answer(handle) });
  }

  /**
   * Whether a vat is running, or persisted and between workers.
   *
   * @param vatId - The ID of the vat.
   * @returns True if the vat is running or persisted.
   */
  #isVatKnown(vatId: VatId): boolean {
    return this.#vats.has(vatId) || this.#kernelStore.isVatActive(vatId);
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
   * queued request could never be carried out on.
   */
  async terminateAllVats(): Promise<void> {
    await this.#kernelQueue.waitForCrank();
    for (const id of this.getVatIds().reverse()) {
      // A queued termination can retire a vat while an earlier one stops.
      // Checked with no await before `stopVat`'s own check, so nothing can
      // retire it in between.
      if (!this.#isVatKnown(id)) {
        continue;
      }
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
