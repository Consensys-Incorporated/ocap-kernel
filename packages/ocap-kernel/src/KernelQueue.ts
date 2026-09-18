import type { CapData } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import { stringify } from '@metamask/kernel-utils';

import { processGCActionSet } from './garbage-collection/garbage-collection.ts';
import { kser } from './liveslots/kernel-marshal.ts';
import type { KernelStore } from './store/index.ts';
import type {
  CrankResult,
  EndpointId,
  KRef,
  KernelMessage,
  KernelOneResolution,
  RemoteId,
  RunLoopStatus,
  RunQueueItem,
  RunQueueItemPeerIncarnation,
  RunQueueItemRemoteInbound,
  RunQueueItemNotify,
  RunQueueItemSend,
  VatId,
} from './types.ts';
import { Fail } from './utils/assert.ts';

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
  readonly subscriptions: Map<
    KRef,
    {
      resolve: (value: CapData<KRef>) => void;
      reject: (reason: unknown) => void;
    }
  > = new Map();

  /** Promises resolved during this crank that have kernel subscriptions */
  #resolvedWithKernelSubscription: KRef[] = [];

  /** Thunk to signal run queue transition from empty to non-empty */
  #wakeUpTheRunQueue: (() => void) | null;

  /**
   * Whether the run loop's catch may still roll this crank's delivery back.
   *
   * False once the savepoint has been handed to `rollbackCrank` — attempted,
   * not necessarily succeeded, since it is forgotten either way and asking
   * twice could only report "no such savepoint" over the real error — and
   * false once a vat's death has been recorded, which must outlive whatever
   * throws after it.
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

  /** What peers have sent, waiting for a crank to take delivery of it. */
  readonly #arrivedFromRemotes: (
    | RunQueueItemRemoteInbound
    | RunQueueItemPeerIncarnation
  )[] = [];

  /**
   * Set while callers are waiting for the loop to come out of its current
   * crank, and settled however the loop leaves — including by dying, which
   * would otherwise leave `stopRunLoop` waiting on a loop that is never going
   * to read the request. Shared by every caller, so a second one asking does
   * not strand the first.
   *
   * The loop reads it between cranks only, which is what makes the window it
   * opens safe to write in: no crank is open, and none will start until the
   * loop is run again.
   */
  #stopRequest: ReturnType<typeof makePromiseKit<void>> | undefined;

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
   * The kernel's run loop: take an item off the run queue, deliver it,
   * repeat. Note that this loops forever: the returned promise never resolves.
   * If it rejects with anything but `run loop already started`, the kernel is
   * dead — see {@link getRunLoopStatus}.
   *
   * @param deliver - A function that delivers an item to the kernel.
   * @returns A promise that rejects with the `Error` that killed the run loop.
   */
  async run(
    deliver: (item: RunQueueItem) => Promise<CrankResult | undefined>,
  ): Promise<void> {
    this.#runLoopState.state === 'running' && Fail`run loop already started`;
    this.#runLoopState.state === 'failed' &&
      Fail`run loop died and cannot be run again`;
    this.#runLoopState = { state: 'running' };
    try {
      return await this.#runLoop(deliver);
    } catch (error) {
      // The recorded failure rather than the raw throw, so that the embedder's
      // handler and `getRunLoopStatus` describe one object rather than two.
      throw this.#failRunLoop(error);
    } finally {
      // However the loop left — stopped as asked, or dead. A caller waiting on
      // a loop that died would otherwise wait for good, and `Kernel.stop`
      // awaits this before closing the database.
      const stopped = this.#stopRequest;
      this.#stopRequest = undefined;
      stopped?.resolve();
    }
  }

  /**
   * Take an item off the run queue, deliver it, repeat.
   *
   * @param deliver - A function that delivers an item to the kernel.
   */
  async #runLoop(
    deliver: (item: RunQueueItem) => Promise<CrankResult | undefined>,
  ): Promise<void> {
    for (;;) {
      // Between cranks, never inside one: whoever asked gets the store with no
      // transaction open and none about to be, which is the whole of what
      // makes their writes safe.
      if (this.#stopRequest) {
        this.#runLoopState = { state: 'stopped' };
        return;
      }
      let wakeUpPromise: Promise<void> | undefined;
      let afterCommit: (() => Promise<void>) | undefined;
      // Boxed, so a crank that threw `undefined` stays distinguishable from one
      // that did not throw.
      let crankFailure: { error: unknown } | undefined;

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
              // cause an operator needs; the rollback failure is named here.
              throw new Error(
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
        if (wakeUpPromise) {
          await wakeUpPromise;
        }
      }
      // Outside the `finally`, so a crank that threw never reaches it: the
      // writes this reports on are not there to report. Guarded rather than
      // `await afterCommit?.()`, which would yield a microtask on every crank.
      if (afterCommit) {
        await afterCommit();
      }
    }
  }

  /**
   * Bring the run loop to rest between cranks, so a caller may write the store
   * directly. Resolves once the loop has stopped; a loop that is idle, already
   * stopped or dead is already at rest.
   *
   * A crank in flight is waited out rather than interrupted. Nothing refuses
   * work queued in the meantime — it simply waits for the loop to be run
   * again, which is the caller's job.
   *
   * @returns Whether the loop had to be stopped, so the caller knows whether
   * to start it again.
   */
  async stopRunLoop(): Promise<boolean> {
    if (this.#runLoopState.state !== 'running') {
      return false;
    }
    this.#stopRequest ??= makePromiseKit<void>();
    // A parked loop is not going to reach the check on its own.
    this.#wakeTheRunLoop();
    await this.#stopRequest.promise;
    // Read after the wait, not before it: the loop may have died rather than
    // stopped, and a caller that restarted a dead loop would be told it had
    // died a second time.
    return this.getRunLoopStatus().state === 'stopped';
  }

  /**
   * Tell everyone waiting on queued work that it will not be carried out,
   * because the queue holding it has been destroyed. Kernel promises in the
   * store go with it, so nothing else would ever settle these.
   *
   * @param why - What became of the work, completing "this message result ...".
   */
  discardQueuedWork(why: string): void {
    // Inbound remote work too: it has not reached the run queue yet, and a
    // peer incarnation change applied after a reset would write pre-reset peer
    // bookkeeping back into a wiped store.
    this.#arrivedFromRemotes.length = 0;
    this.#abandonSubscriptions(new Error(`Kernel state was discarded; ${why}`));
  }

  /**
   * Fail every message-result subscription the kernel is holding.
   *
   * @param error - What to tell them.
   */
  #abandonSubscriptions(error: Error): void {
    const orphaned = [...this.subscriptions.values()];
    this.subscriptions.clear();
    this.#resolvedWithKernelSubscription = [];
    for (const { reject } of orphaned) {
      reject(error);
    }
  }

  /**
   * Record the death of the run loop and fail the kernel's own message-result
   * subscriptions, which would otherwise hang forever. Kernel promises in the
   * store stay unresolved, so vats awaiting a notify the dead loop owed them
   * are not rescued by this.
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
    this.#abandonSubscriptions(
      this.#makeDeadRunLoopError(
        'Kernel run loop died; this message result will never be delivered',
      ),
    );
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
   * Refuse work that would otherwise sit in a queue nobody drains.
   *
   * For callers at an ingress boundary only. Teardown must not be refused even
   * though it also enqueues: `VatHandle.terminate` and `RemoteManager` reject the
   * promises a dying endpoint was deciding, via `resolvePromises`, which enqueues
   * notifies for their subscribers. Those notifies are never delivered, but that
   * is acceptable — the endpoint is going away — whereas refusing them would
   * break `terminateAllVats` and `reset`. Note that those are cleanup, not
   * recovery: nothing clears a `failed` state and `run` refuses to be called
   * twice, so a kernel that has failed stays failed for the life of the
   * instance. Recovery means a new kernel, which in practice means a new
   * process.
   *
   * @param what - What is being refused, completing "cannot ...".
   * @throws If the run loop has died.
   */
  assertRunLoopAlive(what: string): void {
    if (this.#runLoopState.state === 'failed') {
      throw this.#makeDeadRunLoopError(`Kernel run loop died; cannot ${what}`);
    }
    if (this.#runLoopState.state === 'stopped') {
      // Held still for a direct write, or stopped for good by `Kernel.stop`.
      // Either way nothing is draining the queue, so work taken now would sit
      // there — and after `stop` the database it names is closed.
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
   * Get the next item from the kernel run queue.
   * **ATTN:** Mutates the kernel store if the queue is not empty.
   *
   * @returns The next item in the run queue, or undefined if the queue is empty.
   */
  #getNextRunQueueItem(): RunQueueItem | undefined {
    const gcAction = processGCActionSet(this.#kernelStore);
    if (gcAction) {
      return gcAction;
    }

    const reapAction = this.#kernelStore.nextReapAction();
    if (reapAction) {
      return reapAction;
    }

    const arrival = this.#arrivedFromRemotes.shift();
    if (arrival) {
      return arrival;
    }

    if (this.#kernelStore.runQueueLength() > 0) {
      const item = this.#kernelStore.dequeueRun();
      if (item) {
        return item;
      }
    }
    return undefined;
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
      throw new Error(
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
    queueItem: RunQueueItem,
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
    } else {
      // Upon on successful crank completion, enqueue buffered vat outputs for delivery.
      this.#flushCrankBuffer();
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
    this.#kernelStore.collectGarbage();
    this.#kernelStore.assertRefCountsIfAuditing();
  }

  /**
   * Add an item to the tail of the kernel's run queue.
   *
   * @param item - The item to add.
   */
  #enqueueRun(item: RunQueueItem): void {
    this.#kernelStore.enqueueRun(item);
    if (this.#kernelStore.runQueueLength() > 0) {
      this.#wakeTheRunLoop();
    }
  }

  /**
   * Wake a sleeping run loop, if one is sleeping.
   *
   * Woken on any work at all rather than only on the empty-to-one transition.
   * A sleeping run loop with work waiting is a permanent wedge, so err towards
   * a spurious wake: the resolver is cleared as it fires, and the loop
   * re-checks for work on waking.
   */
  #wakeTheRunLoop(): void {
    if (this.#wakeUpTheRunQueue) {
      const wakeUpTheRunQueue = this.#wakeUpTheRunQueue;
      this.#wakeUpTheRunQueue = null;
      wakeUpTheRunQueue();
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
    for (const kpid of this.#resolvedWithKernelSubscription) {
      this.#invokeKernelSubscription(kpid);
    }
    this.#resolvedWithKernelSubscription = [];
  }

  /**
   * Invoke the kernel subscription callback for a resolved promise, if any.
   *
   * @param kpid - The promise ID to check for subscriptions.
   */
  #invokeKernelSubscription(kpid: KRef): void {
    const subscription = this.subscriptions.get(kpid);
    if (subscription) {
      this.subscriptions.delete(kpid);
      const promise = this.#kernelStore.getKernelPromise(kpid);
      if (promise.state === 'rejected') {
        subscription.reject(promise.value);
      } else {
        subscription.resolve(promise.value as CapData<KRef>);
      }
    }
  }

  /**
   * Queue a message to be delivered from the kernel to an object in an endpoint.
   *
   * @param target - The object to which the message is directed.
   * @param method - The method to be invoked.
   * @param args - Message arguments.
   *
   * @returns a promise for the (CapData encoded) result of the message invocation.
   */
  async enqueueMessage(
    target: KRef,
    method: string,
    args: unknown[],
  ): Promise<CapData<KRef>> {
    // Nothing is draining the run queue, so a returned promise could never settle.
    this.assertRunLoopAlive('queue a message');
    // TODO(#562): Use logger instead.
    // eslint-disable-next-line no-console
    console.debug('enqueueMessage', target, method, args);
    const result = this.#kernelStore.initKernelPromise()[0];
    const { promise, resolve, reject } = makePromiseKit<CapData<KRef>>();
    this.subscriptions.set(result, { resolve, reject });
    this.enqueueSend(target, {
      methargs: kser([method, args]),
      result,
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
   * Held in memory rather than written to the run queue: a message arrives
   * whenever the transport says so, which is usually while a crank is open,
   * and writing it there would put it inside that crank's transaction — an
   * abort would swallow it, which is the defect this whole shape exists to
   * remove. Nothing is lost by not persisting it, because the peer is not
   * acknowledged until the crank that takes it commits, so an arrival this
   * kernel forgets is one the peer sends again.
   *
   * @param remoteId - The remote the message came from.
   * @param message - The message, as it arrived.
   */
  acceptRemoteInbound(remoteId: RemoteId, message: string): void {
    this.assertRunLoopAlive('accept a remote message');
    this.#arrivedFromRemotes.push({
      type: 'remoteInbound',
      remoteId,
      message,
    });
    this.#wakeTheRunLoop();
  }

  /**
   * Accept a peer's incarnation change, for the run loop to carry out in a
   * crank of its own.
   *
   * Held with the arrivals, and behind any this peer has already sent: the
   * messages ahead of it belong to the incarnation that is ending and are its
   * to account for, and the ones behind it to the incarnation that is
   * starting.
   *
   * @param peerId - The peer that restarted.
   * @param incarnation - The incarnation it now reports.
   */
  acceptPeerIncarnation(peerId: string, incarnation: string): void {
    this.assertRunLoopAlive('accept a peer incarnation change');
    this.#arrivedFromRemotes.push({
      type: 'peerIncarnation',
      peerId,
      incarnation,
    });
    this.#wakeTheRunLoop();
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
   * Wait for the current crank to complete.
   * This method can be called by external operations to ensure they don't interfere
   * with ongoing kernel operations.
   *
   * @returns A promise that resolves when the current crank is complete.
   */
  async waitForCrank(): Promise<void> {
    return this.#kernelStore.waitForCrank();
  }

  /**
   * Process a set of promise resolutions coming from an endpoint.
   * When immediate is false (for vat syscalls), notifications and kernel
   * subscription callbacks are deferred until the crank buffer is flushed on
   * successful crank completion. When immediate is true (for remote message
   * handling), effects are immediate.
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
        this.#resolvedWithKernelSubscription.push(kpid);
      }
    }
  }
}
