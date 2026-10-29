import type { CapData } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import type { PromiseKit } from '@endo/promise-kit';
import { stringify } from '@metamask/kernel-utils';

import { processGCActionSet } from './garbage-collection/garbage-collection.ts';
import { kser, makeKernelError } from './liveslots/kernel-marshal.ts';
import type { KernelStore } from './store/index.ts';
import type {
  ControlOperation,
  CrankResult,
  EndpointId,
  KRef,
  KernelMessage,
  KernelOneResolution,
  PeerArrival,
  RemoteId,
  RunLoopStatus,
  RunLoopItem,
  RunQueueItem,
  RunQueueItemPeerIncarnation,
  RunQueueItemRemoteInbound,
  RunQueueItemNotify,
  RunQueueItemRestartVat,
  RunQueueItemTerminateVat,
  RunQueueItemSend,
  VatId,
} from './types.ts';
import { insistKRef } from './types.ts';
import { Fail } from './utils/assert.ts';

/**
 * The most arrivals held for one remote at once, matching the window a peer
 * keeps unacknowledged (`MAX_PENDING_MESSAGES` in `RemoteHandle.ts`). A peer
 * goes past it only after giving up on a window this kernel still holds, or
 * with GC deliveries and `redeemURL` replies, which are exempt from that
 * window.
 */
const MAX_ARRIVALS_PER_REMOTE = 200;

type Subscription = {
  resolve: (value: CapData<KRef>) => void;
  reject: (reason: unknown) => void;
};

type HeldMessage = {
  type: 'queueMessage';
  target: KRef;
  methargs: CapData<KRef>;
  subscription: Subscription;
};

type HeldWrite = {
  type: 'write';
  write: () => void;
  reject: (error: Error) => void;
};

type HeldRequest =
  | RunQueueItemRestartVat
  | RunQueueItemTerminateVat
  | HeldMessage
  | HeldWrite;

type ControlRequest = {
  operation: ControlOperation;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

type Deliver = (item: RunLoopItem) => Promise<CrankResult | undefined>;

type NotThenable<Value> = Value extends { then: unknown } ? never : Value;

/** What a caller awaiting queued work is told when the run loop dies. */
const DEAD_RUN_LOOP_WORK =
  'Kernel run loop died; this work will never be carried out';

const DEAD_RUN_LOOP_RESULT =
  'Kernel run loop died; this message result will never be delivered';

type RunLoopState =
  | Exclude<RunLoopStatus, { state: 'failed' }>
  | { state: 'failed'; error: Error };

/**
 * The kernel's run queue.
 *
 * This class manages the kernel's run queue, which is a queue of items that
 * need to be processed.
 */
export class KernelQueue {
  /** Storage holding the kernel's own persistent state */
  readonly #kernelStore: KernelStore;

  /** A function that terminates a vat. */
  readonly #terminateVat: (
    vatId: VatId,
    reason?: CapData<KRef>,
  ) => Promise<void>;

  /** Message results that the kernel itself has subscribed to */
  readonly subscriptions: Map<KRef, Subscription> = new Map();

  /**
   * Resolutions made during this crank of promises that have kernel
   * subscriptions. Each carries its value because `collectGarbage` runs before
   * the flush and a subscription takes no reference count, so the promise may
   * be gone from the store by the time its subscriber is answered.
   */
  #resolvedWithKernelSubscription: KernelOneResolution[] = [];

  /** Callers awaiting work the run loop has been asked for but not yet done. */
  readonly #pendingWorkWaiters: Set<(error: Error) => void> = new Set();

  /**
   * Requests made while a crank was open, for the run loop to write once it
   * ends, unless it ends by killing the loop. Written into the crank, they
   * would be rolled back with it if it aborts, and their callers would wait on
   * work nothing is going to do, or be left holding IDs the store gives out
   * again.
   */
  #heldRequests: HeldRequest[] = [];

  readonly #controlRequests: ControlRequest[] = [];

  /** The control operation whose crank is open, answered once it commits. */
  #controlInFlight: ControlRequest | undefined;

  /** Set by `endRunLoop`, and resolved once the loop has ended. */
  #ending: PromiseKit<void> | undefined;

  /** Thunk to signal run queue transition from empty to non-empty */
  #wakeUpTheRunQueue: (() => void) | null;

  #isOffline: (endpointId: EndpointId) => boolean = () => false;

  /**
   * Whether the run loop's catch may still roll this crank's delivery back.
   *
   * False once the savepoint has been handed to `rollbackCrank` — attempted,
   * not necessarily succeeded, since it is forgotten either way and asking
   * twice could only report "no such savepoint" over the real error — and
   * false once a vat's death has been recorded, or a crank result reports
   * itself `irrevocable`, which must outlive whatever throws after it.
   *
   * A field rather than a return value from `#processCrankResult`, because that
   * method can throw after rolling back (`#terminateVat`, `collectGarbage`).
   */
  #deliveryRollbackAllowed: boolean = true;

  /**
   * The run loop's state, as one value so that a failure recorded for a loop
   * that never started can't be represented. Once failed, nothing drains the
   * queue again; for which ingress points refuse work and why teardown does not,
   * see {@link assertRunLoopAlive}.
   *
   * Derived from the wire type so that a field added to its `failed` arm fails to
   * compile until `getRunLoopStatus` produces it.
   */
  #runLoopState: RunLoopState = { state: 'idle' };

  readonly #arrivedFromRemotes: PeerArrival[] = [];

  /** How many arrivals each waiting restart has had taken ahead of it. */
  readonly #takenAhead = new WeakMap<RunQueueItemPeerIncarnation, number>();

  /** Whether the last pick between arrivals and the run queue was an arrival. */
  #tookArrivalLast = false;

  /**
   * Construct a new KernelQueue instance.
   *
   * @param kernelStore - The kernel's persistent state store.
   * @param terminateVat - Function to terminate a vat with an optional reason.
   */
  constructor(
    kernelStore: KernelStore,
    terminateVat: (vatId: VatId, reason?: CapData<KRef>) => Promise<void>,
  ) {
    this.#kernelStore = kernelStore;
    this.#terminateVat = terminateVat;
    this.#wakeUpTheRunQueue = null;
  }

  /**
   * The kernel's run loop: take a control operation, or else an item off the
   * run queue or from the peers' arrivals, deliver it, repeat, until
   * {@link endRunLoop} ends it. If it rejects with anything but `run loop
   * already started`, the kernel is dead — see {@link getRunLoopStatus}.
   *
   * @param deliver - A function that delivers an item to the kernel.
   * @param options - Options bag.
   * @param options.isOffline - Whether an endpoint cannot take a GC delivery
   * now.
   * @returns A promise that resolves when `endRunLoop` ends the loop, or
   * rejects with the `Error` that killed it.
   */
  async run(
    deliver: Deliver,
    {
      isOffline = () => false,
    }: { isOffline?: (endpointId: EndpointId) => boolean } = {},
  ): Promise<void> {
    this.#runLoopState.state === 'idle' || Fail`run loop already started`;
    this.#runLoopState = { state: 'running' };
    this.#isOffline = isOffline;
    try {
      return await this.#runLoop(deliver);
    } catch (error) {
      // The recorded failure rather than the raw throw, so that the embedder's
      // handler and `getRunLoopStatus` describe one object rather than two.
      throw this.#failRunLoop(error);
    }
  }

  /**
   * The loop {@link run} starts.
   *
   * @param deliver - A function that delivers an item to the kernel.
   */
  async #runLoop(deliver: Deliver): Promise<void> {
    for (;;) {
      // `endRunLoop` was called, and every control operation queued before it
      // has run; `enqueueControl` refuses any after.
      if (this.#ending && this.#controlRequests.length === 0) {
        this.#runLoopState = { state: 'stopped' };
        this.#ending.resolve();
        return;
      }
      let wakeUpPromise: Promise<void> | undefined;
      let afterCommit: (() => Promise<void>) | undefined;
      // Boxed, so a crank that threw `undefined` stays distinguishable from one
      // that did not throw.
      let crankFailure: { error: unknown } | undefined;
      let heldFailure: { error: unknown } | undefined;

      this.#kernelStore.startCrank();
      this.#deliveryRollbackAllowed = true;
      try {
        // Two savepoints, because rolling back the outermost one discards the
        // enclosing transaction (see `rollbackSavepoint`) and an aborted crank
        // still has writes to make — a vat's death, the collection that follows
        // it. Only `delivery` is ever rolled back; releasing `crank` in
        // `endCrank` is this crank's one commit point.
        this.#kernelStore.createCrankSavepoint('crank');
        this.#kernelStore.createCrankSavepoint('delivery');

        // The savepoint exists from here on, so a throw can be undone. Without
        // this, `endCrank`'s savepoint release commits the half-finished crank:
        // the item this crank dequeued is gone for good, refcount increments
        // stick, and promises resolved during it stay resolved while their
        // notifies die unflushed. A restart would resume from that.
        try {
          const queueItem = this.#getNextRunQueueItem();
          if (queueItem) {
            this.#kernelStore.nextTerminatedVatCleanup();
            const crankResult = await deliver(queueItem);
            await this.#processCrankResult(crankResult, queueItem);
            if (!crankResult?.abort) {
              afterCommit = crankResult?.afterCommit;
            }
          } else {
            if (this.#wakeUpTheRunQueue !== null) {
              Fail`run queue already waiting to be woken; cannot sleep again before the previous wake handler is consumed`;
            }

            const { promise, resolve } = makePromiseKit<void>();
            this.#wakeUpTheRunQueue = resolve;
            wakeUpPromise = promise;
          }
        } catch (error) {
          if (this.#deliveryRollbackAllowed) {
            try {
              this.#kernelStore.rollbackCrank('delivery');
            } catch (rollbackError) {
              // The original failure stays the `cause`, since that is the root
              // cause an operator needs. `errors` keeps the rollback failure's
              // own chain, such as the write SQLite rolled the crank back on.
              throw new AggregateError(
                [error, rollbackError],
                `Run loop died and its crank could not be rolled back: ${String(rollbackError)}`,
                { cause: error },
              );
            }
          }
          throw error;
        }
      } catch (error) {
        crankFailure = { error };
        throw error;
      } finally {
        this.#endCrank(crankFailure);
        if (!crankFailure) {
          try {
            this.#writeHeldRequests();
          } catch (error) {
            // Rethrown once `afterCommit` has run: the crank has committed.
            heldFailure = { error };
          }
        }
        if (wakeUpPromise && !heldFailure) {
          await wakeUpPromise;
        }
      }
      // Outside the `finally`, so a crank that threw never reaches it: the
      // writes this reports on are not there to report. Guarded rather than
      // `await afterCommit?.()`, which would yield a microtask on every crank.
      if (afterCommit) {
        try {
          await afterCommit();
        } catch (error) {
          if (!heldFailure) {
            throw error;
          }
          throw new AggregateError(
            [heldFailure.error, error],
            `Run loop died writing a held request, and its crank's afterCommit failed: ${String(error)}`,
            { cause: heldFailure.error },
          );
        }
      }
      const control = this.#controlInFlight;
      this.#controlInFlight = undefined;
      // Answered before a held request's failure is rethrown: its crank has
      // committed.
      control?.resolve();
      if (heldFailure) {
        throw heldFailure.error;
      }
    }
  }

  /**
   * Queue a control operation for the run loop to carry out ahead of all other
   * work, in a crank of its own.
   *
   * @param operation - The operation.
   * @returns A promise that resolves once the operation's crank commits. It
   * rejects with what killed the run loop if that crank fails, with the
   * dead-loop error if the loop dies before taking it, and at once if the loop
   * has not started, has died or stopped, or is ending.
   */
  async enqueueControl(operation: ControlOperation): Promise<void> {
    this.#runLoopState.state === 'idle' && Fail`run loop has not started`;
    this.assertRunLoopAlive(operation);
    if (this.#ending) {
      throw Error(`Kernel run loop is stopping; cannot ${operation}`);
    }
    const { promise, resolve, reject } = makePromiseKit<void>();
    this.#controlRequests.push({ operation, resolve, reject });
    this.#wakeRunLoop();
    return promise;
  }

  /**
   * End the run loop between cranks, once the control operations queued before
   * this have been carried out. What is left on the run queue waits for the
   * next start.
   *
   * @returns A promise that resolves once the loop has ended, by this request
   * or by dying first.
   */
  async endRunLoop(): Promise<void> {
    const { state } = this.#runLoopState;
    state === 'idle' && Fail`run loop has not started`;
    if (state !== 'running') {
      return undefined;
    }
    this.#ending ??= makePromiseKit<void>();
    this.#wakeRunLoop();
    return this.#ending.promise;
  }

  /**
   * Drop the peers' arrivals, for a kernel wiping its store or stopping. Taken
   * after a wipe, an arrival would write the old peer state back. Not for a
   * kernel that keeps its peer state and runs on: a later commit would
   * acknowledge the dropped arrivals, and the peer would never resend them. A
   * remote held for a peer restart stays held until
   * `RemoteManager.releaseRestartHolds`.
   */
  discardArrivals(): void {
    this.#arrivedFromRemotes.length = 0;
  }

  /**
   * Fail every message-result subscription the kernel is holding.
   *
   * @param error - What to tell them.
   */
  abandonSubscriptions(error: Error): void {
    const orphaned = [...this.subscriptions.values()];
    this.subscriptions.clear();
    this.#resolvedWithKernelSubscription = [];
    for (const { reject } of orphaned) {
      reject(error);
    }
  }

  /**
   * Tell a caller waiting on queued work if the run loop dies before carrying
   * it out. `subscriptions` and the held requests cover a message's result and
   * a held write; a request with no kernel promise behind it — a vat restart
   * or termination — has nothing else that would settle it.
   *
   * @param reject - How to tell the caller.
   * @returns A function that unregisters it, for the caller's own `finally`.
   */
  onRunLoopDeath(reject: (error: Error) => void): () => void {
    if (this.#runLoopState.state === 'failed') {
      reject(this.#makeDeadRunLoopError(DEAD_RUN_LOOP_WORK));
      return () => undefined;
    }
    this.#pendingWorkWaiters.add(reject);
    return () => {
      this.#pendingWorkWaiters.delete(reject);
    };
  }

  /**
   * Record the death of the run loop and fail everyone who would otherwise wait
   * forever: the kernel's own message-result subscriptions, held requests,
   * callers waiting on queued work, and queued control operations. Kernel
   * promises in the store stay unresolved, so vats awaiting a notify the dead
   * loop owed them are not rescued by this.
   *
   * @param error - The error that killed the run loop.
   * @returns The failure, as an `Error` whatever was thrown.
   */
  #failRunLoop(error: unknown): Error {
    const failure =
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error });
    this.#runLoopState = { state: 'failed', error: failure };
    this.abandonSubscriptions(this.#makeDeadRunLoopError(DEAD_RUN_LOOP_RESULT));

    const held = this.#heldRequests;
    this.#heldRequests = [];
    for (const item of held) {
      if (item.type === 'queueMessage') {
        item.subscription.reject(
          this.#makeDeadRunLoopError(DEAD_RUN_LOOP_RESULT),
        );
      } else if (item.type === 'write') {
        item.reject(this.#makeDeadRunLoopError(DEAD_RUN_LOOP_WORK));
      }
    }

    const abandoned = [...this.#pendingWorkWaiters];
    this.#pendingWorkWaiters.clear();
    for (const reject of abandoned) {
      reject(this.#makeDeadRunLoopError(DEAD_RUN_LOOP_WORK));
    }

    this.#controlInFlight?.reject(failure);
    this.#controlInFlight = undefined;
    for (const { reject } of this.#controlRequests.splice(0)) {
      reject(this.#makeDeadRunLoopError(DEAD_RUN_LOOP_WORK));
    }
    this.#ending?.resolve();
    return failure;
  }

  /**
   * @param message - The message for the caller.
   * @returns An error whose cause is the failure that killed the run loop.
   */
  #makeDeadRunLoopError(message: string): Error {
    return new Error(message, {
      cause:
        this.#runLoopState.state === 'failed'
          ? this.#runLoopState.error
          : undefined,
    });
  }

  /**
   * Refuse work that would otherwise sit in a queue nobody drains: the run loop
   * died, or `endRunLoop` ended it.
   *
   * For callers at an ingress boundary only. Teardown must not be refused even
   * though it also enqueues: `VatManager` and `RemoteManager` reject the
   * promises a dying endpoint was deciding, via `resolvePromises`, which enqueues
   * notifies for their subscribers. Once the loop has ended this instance never
   * delivers those notifies, which is acceptable since the endpoint is going
   * away, whereas refusing them would throw from the teardown. Nothing clears a
   * `failed` state and `run` refuses to be called twice, so a kernel that has
   * failed stays failed for the life of the instance. Recovery means a new
   * kernel, which in practice means a new process.
   *
   * @param what - What is being refused, completing "cannot ...".
   * @throws If the run loop has died or stopped.
   */
  assertRunLoopAlive(what: string): void {
    if (this.#runLoopState.state === 'failed') {
      throw this.#makeDeadRunLoopError(`Kernel run loop died; cannot ${what}`);
    }
    if (this.#runLoopState.state === 'stopped') {
      throw Error(`Kernel run loop is stopped; cannot ${what}`);
    }
  }

  /**
   * Report whether the kernel is able to process its run queue at all.
   *
   * @returns The current run loop status.
   */
  getRunLoopStatus(): RunLoopStatus {
    return harden(
      this.#runLoopState.state === 'failed'
        ? {
            state: 'failed',
            error: this.#runLoopState.error.message,
            // The message drops the cause chain, and in a double failure it names
            // the failed rollback rather than what killed the kernel.
            detail: stringify(this.#runLoopState.error, 0),
          }
        : { state: this.#runLoopState.state },
    );
  }

  /**
   * Take the next item for the run loop.
   * **ATTN:** Removes it from the kernel store, the arrivals or the control
   * requests.
   *
   * @returns The next item, or undefined if nothing is waiting.
   */
  #getNextRunQueueItem(): RunLoopItem | undefined {
    const control = this.#controlRequests.shift();
    if (control) {
      this.#controlInFlight = control;
      return { type: 'control', operation: control.operation };
    }

    const gcAction = processGCActionSet(this.#kernelStore, {
      isOffline: this.#isOffline,
    });
    if (gcAction) {
      return gcAction;
    }

    const reapAction = this.#kernelStore.nextReapAction();
    if (reapAction) {
      return reapAction;
    }

    // Arrivals and the run queue take turns, so a peer that sends faster than
    // cranks finish cannot hold up the kernel's own work.
    const arrivalFirst = !this.#tookArrivalLast;
    this.#tookArrivalLast = false;
    if (arrivalFirst) {
      const arrival = this.#takeArrival();
      if (arrival) {
        return arrival;
      }
    }

    if (this.#kernelStore.runQueueLength() > 0) {
      const item = this.#kernelStore.dequeueRun();
      if (item) {
        return item;
      }
    }
    return this.#takeArrival();
  }

  /**
   * Take the oldest arrival, if there is one.
   *
   * @returns The arrival, or undefined if none is waiting.
   */
  #takeArrival(): PeerArrival | undefined {
    const arrival = this.#arrivedFromRemotes.shift();
    this.#tookArrivalLast = arrival !== undefined;
    return arrival;
  }

  /**
   * End the crank without losing the error that is already unwinding. Now that
   * the delivery rollback spares `crank`, `endCrank` is a real release and
   * commit on the dying path where it used to be a no-op.
   *
   * @param crankFailure - The error already in flight, if the crank threw.
   * @param crankFailure.error - That error.
   */
  #endCrank(crankFailure?: { error: unknown }): void {
    try {
      this.#kernelStore.endCrank();
    } catch (endCrankError) {
      if (!crankFailure) {
        throw endCrankError;
      }
      throw new AggregateError(
        [crankFailure.error, endCrankError],
        `Run loop died and its crank could not be ended: ${String(endCrankError)}`,
        { cause: crankFailure.error },
      );
    }
  }

  /**
   * Process the results of a crank.
   *
   * @param crankResult - The crank result.
   * @param queueItem - The run queue item that caused the crank result.
   */
  async #processCrankResult(
    crankResult: CrankResult | undefined,
    queueItem: RunLoopItem,
  ): Promise<void> {
    if (crankResult?.abort) {
      // Rollback the kernel state to before the failed delivery attempt.
      // For active vats, this allows the message to be retried in a future crank.
      // For terminated vats, the message will just go splat.
      try {
        this.#kernelStore.rollbackCrank('delivery');
      } finally {
        // Cleared even when the rollback threw: the savepoint is gone either
        // way.
        this.#deliveryRollbackAllowed = false;
      }
      // Discard kernel subscriptions that were queued for invocation
      this.#resolvedWithKernelSubscription = [];

      // If the vat is being terminated, reject the JS subscription for this
      // message's result promise immediately. The rollback undid the delivery,
      // and the vat won't be around to handle a retry.
      if (
        crankResult.terminate &&
        queueItem.type === 'send' &&
        queueItem.message.result
      ) {
        const subscription = this.subscriptions.get(queueItem.message.result);
        if (subscription) {
          this.subscriptions.delete(queueItem.message.result);
          subscription.reject(crankResult.terminate.info);
        }
      }
      // TODO: Currently all errors terminate the vat, but instead we could
      // restart it and terminate the vat only after a certain number of failed
      // retries. This is probably where we should implement the vat restart logic.
    }
    // Vat termination during delivery is triggered by an illegal syscall
    // or by syscall.exit().
    if (crankResult?.terminate) {
      const { vatId, info } = crankResult.terminate;
      try {
        await this.#terminateVat(vatId, info);
      } finally {
        // Withheld even when terminating threw partway: it kills the worker on
        // its first line, so a store still believing the vat was alive would
        // relaunch one whose callers have already been answered. The abort path
        // above has rolled back and has nothing left worth keeping, and
        // `vatPowers.exitVat` terminates without aborting, so on neither path
        // does a later throw have a delivery to undo. All of it stays inside
        // the crank's transaction regardless.
        this.#deliveryRollbackAllowed = false;
      }
    }
    if (crankResult?.irrevocable) {
      this.#deliveryRollbackAllowed = false;
    }
    this.#kernelStore.collectGarbage();
    // While a violation can still undo this crank, the audit goes first, so the
    // flush does not settle the promise `enqueueMessage` gave an external
    // caller out of state that is about to be rolled back. It can see the
    // buffered items at all because `computeExpectedRefCounts` credits the
    // crank buffer. Once a vat's death has committed the crank there is nothing
    // left to undo, and flushing first is instead what keeps each queue row
    // with the reference count charge it was given.
    const auditBeforeFlush = this.#deliveryRollbackAllowed;
    if (auditBeforeFlush) {
      this.#kernelStore.assertRefCountsIfAuditing();
    }
    if (!crankResult?.abort) {
      this.#flushCrankBuffer();
    }
    if (!auditBeforeFlush) {
      this.#kernelStore.assertRefCountsIfAuditing();
    }
  }

  /**
   * Wake a run loop parked on an empty queue, for GC actions it skipped while
   * their endpoint was offline.
   */
  recheckGCActions(): void {
    this.#wakeRunLoop();
  }

  /**
   * Wake the run loop if it is parked on an empty queue.
   */
  #wakeRunLoop(): void {
    const wakeUpTheRunQueue = this.#wakeUpTheRunQueue;
    if (wakeUpTheRunQueue) {
      this.#wakeUpTheRunQueue = null;
      wakeUpTheRunQueue();
    }
  }

  /**
   * Add an item to the tail of the kernel's run queue.
   *
   * @param item - The item to add.
   */
  #enqueueRun(item: RunQueueItem): void {
    this.#kernelStore.enqueueRun(item);
    // Wake on any non-empty queue rather than only on the empty->1
    // transition. A sleeping run loop plus a non-empty queue is a
    // permanent wedge, so err towards a spurious wake: the resolver is
    // cleared as it fires, and the loop re-checks the queue on waking.
    if (this.#kernelStore.runQueueLength() > 0) {
      this.#wakeRunLoop();
    }
  }

  /**
   * Flush the crank buffer, moving buffered vat output items to the run queue
   * and invoking kernel subscription callbacks for resolved promises.
   */
  #flushCrankBuffer(): void {
    const items = this.#kernelStore.flushCrankBuffer();
    for (const item of items) {
      this.#enqueueRun(item);
      if (item.type === 'notify') {
        // Invoke kernel subscription callback if any, reading resolution
        // data from the (now committed) promise state
        this.#invokeKernelSubscription(item.kpid);
      }
    }

    // Invoke kernel subscriptions for promises resolved during this crank
    // that don't have kernel-level subscribers (e.g., promises from enqueueMessage)
    for (const resolution of this.#resolvedWithKernelSubscription) {
      this.#settleKernelSubscription(resolution);
    }
    this.#resolvedWithKernelSubscription = [];
  }

  /**
   * Invoke the kernel subscription callback for a resolved promise, if any.
   *
   * @param kpid - The promise ID to check for subscriptions.
   */
  #invokeKernelSubscription(kpid: KRef): void {
    if (this.subscriptions.has(kpid)) {
      const promise = this.#kernelStore.getKernelPromise(kpid);
      this.#settleKernelSubscription([
        kpid,
        promise.state === 'rejected',
        promise.value as CapData<KRef>,
      ]);
    }
  }

  /**
   * Settle the kernel subscription for a promise, if any, with a resolution
   * the caller already has.
   *
   * @param resolution - The promise and how it was resolved.
   */
  #settleKernelSubscription(resolution: KernelOneResolution): void {
    const [kpid, rejected, data] = resolution;
    const subscription = this.subscriptions.get(kpid);
    if (subscription) {
      this.subscriptions.delete(kpid);
      if (rejected) {
        subscription.reject(data);
      } else {
        subscription.resolve(data);
      }
    }
  }

  /**
   * Queue a message to be delivered from the kernel to an object in an endpoint.
   * Held until the open crank, if any, has ended.
   *
   * @param target - The object to which the message is directed.
   * @param method - The method to be invoked.
   * @param args - Message arguments.
   *
   * @returns a promise for the (CapData encoded) result of the message
   * invocation. It rejects with `OBJECT_DELETED` if the kernel does not have
   * the target or a kref in the arguments by the time the message is written.
   */
  async enqueueMessage(
    target: KRef,
    method: string,
    args: unknown[],
  ): Promise<CapData<KRef>> {
    // Nothing is draining the run queue, so a returned promise could never settle.
    this.assertRunLoopAlive('queue a message');
    insistKRef(target);
    // TODO(#562): Use logger instead.
    // oxlint-disable-next-line no-console
    console.debug('enqueueMessage', target, method, args);
    const { promise, resolve, reject } = makePromiseKit<CapData<KRef>>();
    this.#enqueueRequest({
      type: 'queueMessage',
      target,
      methargs: kser([method, args]),
      subscription: { resolve, reject },
    });
    return promise;
  }

  /**
   * Write a `queueMessage` call. A store fault is thrown; for a held message
   * it kills the run loop, which tells the caller.
   *
   * @param message - The call.
   */
  #writeMessage(message: HeldMessage): void {
    const { target, methargs, subscription } = message;
    // Checked first: outside a crank nothing rolls back, and `enqueueSend`
    // refusing a missing kref partway would keep what it charged before it.
    const missing = [target, ...methargs.slots].find(
      (kref) => !this.#kernelStore.kernelRefExists(kref),
    );
    if (missing !== undefined) {
      subscription.reject(
        makeKernelError(
          'OBJECT_DELETED',
          `${missing} does not exist; it may have been deleted`,
        ),
      );
      return;
    }
    const [result] = this.#kernelStore.initKernelPromise();
    this.enqueueSend(target, { methargs, result });
    // Last: a write that threw must leave no subscription behind.
    this.subscriptions.set(result, subscription);
  }

  /**
   * Make a write now if no crank is open, or else once the open crank ends.
   *
   * @param write - The write. It must make every write before it returns:
   * the run loop does not wait for a promise, so what it writes after an
   * `await` lands in whichever crank is open by then. The type refuses a
   * promise returned bare, not one inside an object.
   * @returns A promise for what `write` returns or throws. It rejects if the
   * run loop has stopped or dies first, or if a reset or `clearStorage`
   * discards the write.
   */
  async writeOutsideCrank<Result>(
    write: () => NotThenable<Result>,
  ): Promise<Result> {
    this.assertRunLoopAlive('write outside a crank');
    const { promise, resolve, reject } = makePromiseKit<Result>();
    this.#enqueueRequest({
      type: 'write',
      write: () => {
        try {
          resolve(write());
        } catch (error) {
          reject(error);
        }
      },
      reject,
    });
    return promise;
  }

  /**
   * Enqueue a message send to be delivered to an endpoint.
   *
   * @param target - The object to which the message is directed.
   * @param message - The message to be delivered.
   * @param immediate - If true (the default), enqueue immediately; if false, buffer for crank completion.
   */
  enqueueSend(target: KRef, message: KernelMessage, immediate = true): void {
    this.#kernelStore.incrementRefCount(target, 'queue|target');
    if (message.result) {
      this.#kernelStore.incrementRefCount(message.result, 'queue|result');
    }
    for (const slot of message.methargs.slots || []) {
      this.#kernelStore.incrementRefCount(slot, 'queue|slot');
    }
    const item: RunQueueItemSend = { type: 'send', target, message };
    if (immediate) {
      this.#enqueueRun(item);
    } else {
      this.#kernelStore.bufferCrankOutput(item);
    }
  }

  /**
   * Accept a message from a remote peer, for the run loop to take delivery of
   * in a crank of its own.
   *
   * Held in memory, not on the run queue: a message can arrive while a crank
   * is open, and written there it would join that crank's transaction and
   * vanish with its abort. The peer is acknowledged only once the crank that
   * takes the message commits, so one lost in a crash is resent.
   *
   * A peer retransmits everything unacknowledged on a timeout, and its copies
   * would fill the remote's share and turn away messages it has yet to send.
   * So a copy of a message waiting, or of one a committed crank has taken, is
   * not held, and a copy held before its original committed stops taking a
   * slot once it has. A refused message is lost if a later one is taken first,
   * since that one's acknowledgement covers it.
   *
   * One that arrives while a restart of the peer waits to be recorded is taken
   * ahead of it, against the incarnation that sent it: the transport reads
   * nothing from the new incarnation until then, so what arrives was read late
   * off the old one's channel. An incarnation that has ended left about a
   * window's worth unacknowledged, and past `MAX_ARRIVALS_PER_REMOTE` one is
   * refused, or a peer still sending on that channel would hold the restart,
   * and every arrival behind it, back for as long as it sends.
   *
   * @param options - Options bag.
   * @param options.remoteId - The remote the message came from.
   * @param options.peerId - The peer that sent it.
   * @param options.seq - The message's sequence number.
   * @param options.message - The message, as it arrived.
   * @param options.highestReceivedSeq - The highest sequence number from this
   * remote that a committed crank has taken.
   * @returns False if the remote already has `MAX_ARRIVALS_PER_REMOTE`
   * uncommitted arrivals waiting, or its waiting restart has had that many
   * taken ahead of it, and this one was refused.
   */
  acceptRemoteInbound({
    remoteId,
    peerId,
    seq,
    message,
    highestReceivedSeq,
  }: {
    remoteId: RemoteId;
    peerId: string;
    seq: number;
    message: string;
    highestReceivedSeq: number;
  }): boolean {
    this.assertRunLoopAlive('accept a remote message');
    if (seq <= highestReceivedSeq) {
      return true;
    }
    const held = this.#arrivedFromRemotes.filter(
      (item): item is RunQueueItemRemoteInbound =>
        item.type === 'remoteInbound' &&
        item.remoteId === remoteId &&
        item.peerId === peerId &&
        item.seq > highestReceivedSeq,
    );
    if (held.some((item) => item.seq === seq)) {
      return true;
    }
    if (held.length >= MAX_ARRIVALS_PER_REMOTE) {
      return false;
    }
    const arrival: RunQueueItemRemoteInbound = {
      type: 'remoteInbound',
      remoteId,
      peerId,
      seq,
      message,
    };
    const restart = this.#waitingRestart(peerId);
    if (restart === undefined) {
      this.#arrivedFromRemotes.push(arrival);
    } else {
      const ahead = (this.#takenAhead.get(restart) ?? 0) + 1;
      if (ahead > MAX_ARRIVALS_PER_REMOTE) {
        return false;
      }
      this.#takenAhead.set(restart, ahead);
      this.#arrivedFromRemotes.splice(
        this.#arrivedFromRemotes.indexOf(restart),
        0,
        arrival,
      );
    }
    this.#wakeRunLoop();
    return true;
  }

  /**
   * Accept a peer's incarnation change, for the run loop to carry out in a
   * crank of its own, behind everything the peer sent before it.
   *
   * A restart reported while another of the peer's waits takes that one's
   * place rather than queueing a crank of its own, or a peer reporting a new
   * incarnation on every handshake would queue one for each. Nothing waits
   * behind the one replaced, since every handshake from it reported a restart
   * and the transport kept its channel closed.
   *
   * @param options - Options bag.
   * @param options.peerId - The peer.
   * @param options.incarnation - The incarnation it reports.
   * @param options.restart - Whether it replaces an incarnation the kernel knew
   * the peer by.
   */
  acceptPeerIncarnation({
    peerId,
    incarnation,
    restart,
  }: {
    peerId: string;
    incarnation: string;
    restart: boolean;
  }): void {
    this.assertRunLoopAlive('accept a peer incarnation change');
    const waiting = restart ? this.#waitingRestart(peerId) : undefined;
    if (waiting === undefined) {
      this.#arrivedFromRemotes.push({
        type: 'peerIncarnation',
        peerId,
        incarnation,
        restart,
      });
    } else {
      waiting.incarnation = incarnation;
    }
    this.#wakeRunLoop();
  }

  /**
   * Find the restart of a peer that waits for its crank.
   *
   * @param peerId - The peer.
   * @returns The waiting change, or undefined if none is a restart.
   */
  #waitingRestart(peerId: string): RunQueueItemPeerIncarnation | undefined {
    return this.#arrivedFromRemotes.find(
      (item): item is RunQueueItemPeerIncarnation =>
        item.type === 'peerIncarnation' &&
        item.peerId === peerId &&
        item.restart,
    );
  }

  /**
   * List the incarnations a peer reported in changes still waiting for their
   * cranks.
   *
   * @param peerId - The peer.
   * @returns The incarnations, oldest first.
   */
  waitingIncarnations(peerId: string): string[] {
    return this.#arrivedFromRemotes.flatMap((item) =>
      item.type === 'peerIncarnation' && item.peerId === peerId
        ? [item.incarnation]
        : [],
    );
  }

  /**
   * Enqueue a request to replace a vat's worker.
   *
   * @param vatId - The vat whose worker is to be replaced.
   */
  enqueueRestartVat(vatId: VatId): void {
    this.assertRunLoopAlive('restart a vat');
    this.#enqueueRequest({ type: 'restartVat', vatId });
  }

  /**
   * Enqueue a request from outside the run loop, holding it until the open
   * crank, if any, has ended.
   *
   * @param item - The item to add.
   */
  #enqueueRequest(item: HeldRequest): void {
    if (this.#kernelStore.isInCrank()) {
      this.#heldRequests.push(item);
    } else {
      this.#writeRequest(item);
    }
  }

  /**
   * Write a request now.
   *
   * @param item - The request.
   */
  #writeRequest(item: HeldRequest): void {
    switch (item.type) {
      case 'queueMessage':
        this.#writeMessage(item);
        break;
      case 'write':
        item.write();
        break;
      default:
        this.#enqueueRun(item);
    }
  }

  /**
   * Forget the held requests, and reject the caller of each held message or
   * write, for a kernel wiping its store: not in the store yet, they would
   * outlive the wipe. A restart or termination's caller is told by
   * `VatManager`.
   *
   * @param error - What to tell the caller of a forgotten message or write.
   */
  discardHeldRequests(error: Error): void {
    const held = this.#heldRequests;
    this.#heldRequests = [];
    for (const item of held) {
      if (item.type === 'queueMessage') {
        item.subscription.reject(error);
      } else if (item.type === 'write') {
        item.reject(error);
      }
    }
  }

  /**
   * Write the requests held while the crank that just ended was open.
   */
  #writeHeldRequests(): void {
    // Each taken off only once written: one that throws kills the run loop,
    // and `#failRunLoop` must still find it and the rest to tell their
    // callers.
    for (;;) {
      const [item] = this.#heldRequests;
      if (item === undefined) {
        return;
      }
      this.#writeRequest(item);
      this.#heldRequests.shift();
    }
  }

  /**
   * Enqueue a request to terminate a vat.
   *
   * @param vatId - The vat to terminate.
   * @param reason - The reason, if any. It must carry no slots.
   */
  enqueueTerminateVat(vatId: VatId, reason?: CapData<KRef>): void {
    this.assertRunLoopAlive('terminate a vat');
    // A queued row takes no reference count on what it names.
    !reason?.slots.length || Fail`a termination reason cannot carry slots`;
    this.#enqueueRequest({
      type: 'terminateVat',
      vatId,
      ...(reason && { reason }),
    });
  }

  /**
   * Enqueue a notification of promise resolution to an endpoint.
   *
   * @param endpointId - The endpoint that will be notified.
   * @param kpid - The promise of interest.
   * @param immediate - If true (the default), enqueue immediately; if false, buffer for crank completion.
   */
  enqueueNotify(endpointId: EndpointId, kpid: KRef, immediate = true): void {
    this.#kernelStore.incrementRefCount(kpid, 'notify');
    const item: RunQueueItemNotify = { type: 'notify', endpointId, kpid };
    if (immediate) {
      this.#enqueueRun(item);
    } else {
      this.#kernelStore.bufferCrankOutput(item);
    }
  }

  /**
   * Wait for the open crank, if any, to end. The run loop may open the next
   * one before the caller resumes, so a write made after this can still land
   * inside a crank.
   *
   * @returns A promise that resolves when the open crank has ended.
   */
  async waitForCrank(): Promise<void> {
    return this.#kernelStore.waitForCrank();
  }

  /**
   * Process a set of promise resolutions coming from an endpoint.
   * Pass `immediate` false from inside a crank: notifications, messages queued
   * on each promise, and kernel subscription callbacks then wait for the crank
   * buffer's flush, which an aborted crank skips.
   *
   * @param endpointId - The endpoint doing the resolving, if there is one.
   * @param resolutions - One or more resolutions, to be processed as a group.
   * @param immediate - If true (the default), enqueue immediately; if false, buffer for crank completion.
   */
  resolvePromises(
    endpointId: EndpointId | 'kernel' | undefined,
    resolutions: KernelOneResolution[],
    immediate = true,
  ): void {
    for (const resolution of resolutions) {
      const [kpid, rejected, data] = resolution;

      const promise = this.#kernelStore.getKernelPromise(kpid);
      const { state, decider, subscribers } = promise;
      if (state !== 'unresolved') {
        Fail`${kpid} was already resolved`;
      }
      if (decider !== endpointId) {
        const why = decider ? `its decider is ${decider}` : `it has no decider`;
        Fail`${endpointId} not permitted to resolve ${kpid} because ${why}`;
      }
      if (!subscribers) {
        throw Fail`${kpid} subscribers not set`;
      }

      // Charged only once the resolve is known to be legal: a vat's illegal
      // `syscall.resolve` throws out of the checks above, and a unit taken
      // before them would be left behind with nobody holding it.
      for (const slot of data.slots || []) {
        this.#kernelStore.incrementRefCount(slot, 'resolve|slot');
      }
      // A kernel subscriber hands these krefs to a caller outside the kernel,
      // which holds them as bare strings. Pinned here, at resolution, because
      // a buffered subscription settles only after the crank has collected
      // garbage.
      if (this.subscriptions.has(kpid)) {
        for (const slot of data.slots || []) {
          this.#kernelStore.pinObject(slot);
        }
      }

      // Enqueue notifications for each subscriber (immediate or buffered based on flag).
      for (const subscriber of subscribers) {
        this.enqueueNotify(subscriber, kpid, immediate);
      }

      // Update promise state and get any queued messages to it.
      const queuedMessages = this.#kernelStore.resolveKernelPromise(
        kpid,
        rejected,
        data,
      );

      // Enqueue the queued messages (immediate or buffered based on flag).
      for (const [target, message] of queuedMessages) {
        this.enqueueSend(target, message, immediate);
      }

      // Handle kernel subscriptions based on immediate flag.
      if (immediate) {
        // Invoke kernel subscription immediately
        this.#invokeKernelSubscription(kpid);
      } else if (this.subscriptions.has(kpid)) {
        // Track resolved promises that have kernel subscriptions for invocation at flush time
        this.#resolvedWithKernelSubscription.push(resolution);
      }
    }
  }
}
