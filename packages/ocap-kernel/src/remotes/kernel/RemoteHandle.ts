import type { VatOneResolution } from '@agoric/swingset-liveslots';
import type { CapData } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import { isTerminalSendError } from '@metamask/kernel-errors';
import { Logger } from '@metamask/logger';

import {
  performDropImports,
  performRetireImports,
  performExportCleanup,
} from '../../garbage-collection/gc-handlers.ts';
import type { KernelQueue } from '../../KernelQueue.ts';
import type { KernelStore } from '../../store/index.ts';
import type {
  RemoteId,
  ERef,
  KRef,
  EndpointHandle,
  EndpointMessage,
  KernelOneResolution,
  CrankResult,
} from '../../types.ts';
import { insistERef } from '../../types.ts';
import type { RemoteComms } from '../types.ts';

/** How long to wait for ACK before retransmitting (ms). */
const ACK_TIMEOUT_MS = 10_000;

/** How long to wait before sending a standalone ACK if no outgoing traffic (ms). */
const DELAYED_ACK_MS = 50;

/** Maximum retransmission attempts before giving up. */
const MAX_RETRIES = 3;

/** Maximum number of pending messages awaiting ACK. */
const MAX_PENDING_MESSAGES = 200;

type RemoteHandleConstructorProps = {
  remoteId: RemoteId;
  peerId: string;
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
  remoteComms: RemoteComms;
  locationHints?: string[] | undefined;
  logger?: Logger | undefined;
  onGiveUp?: ((peerId: string) => void) | undefined;
  ackTimeoutMs?: number | undefined;
};

type MessageDelivery = ['message', ERef, EndpointMessage];
type NotifyDelivery = ['notify', VatOneResolution[]];
type DropExportsDelivery = ['dropExports', ERef[]];
type RetireExportsDelivery = ['retireExports', ERef[]];
type RetireImportsDelivery = ['retireImports', ERef[]];
type BringOutYourDeadDelivery = ['bringOutYourDead'];

type DeliveryParams =
  | MessageDelivery
  | NotifyDelivery
  | DropExportsDelivery
  | RetireExportsDelivery
  | RetireImportsDelivery
  | BringOutYourDeadDelivery;

type Delivery = {
  method: 'deliver';
  params: DeliveryParams;
};

type RedeemURLRequest = {
  method: 'redeemURL';
  params: [string, string];
};

type RedeemURLReply = {
  method: 'redeemURLReply';
  params: [boolean, string, string];
};

export type RemoteMessageBase = Delivery | RedeemURLRequest | RedeemURLReply;

type DeferredRedeemURLRequest =
  | { type: 'redeemURL'; replyKey: string; ref: ERef }
  | { type: 'redeemURL'; replyKey: string; error: string };

type DeferredRedeemURLReply =
  | { type: 'redeemURLReply'; replyKey: string; ref: KRef }
  | { type: 'redeemURLReply'; replyKey: string; error: string };

type DeferredCompletion = DeferredRedeemURLRequest | DeferredRedeemURLReply;

/** An outgoing message written to the store but not yet sent. */
type PersistedCommand = {
  seq: number;
  messageString: string;
  wasEmpty: boolean;
};

/** The span of outgoing sequence numbers awaiting acknowledgement. */
type SeqWindow = {
  startSeq: number;
  nextSendSeq: number;
};

/**
 * Whether a sequence window holds anything.
 *
 * @param window - The window to measure.
 * @returns True if it holds at least one unacknowledged message.
 */
function hasPending(window: SeqWindow): boolean {
  return window.nextSendSeq > 0 && window.startSeq <= window.nextSendSeq;
}

/**
 * How many messages a sequence window holds.
 *
 * @param window - The window to measure.
 * @returns The count of unacknowledged messages.
 */
function countPending(window: SeqWindow): number {
  return hasPending(window) ? window.nextSendSeq - window.startSeq + 1 : 0;
}

type RemoteCommand = {
  seq: number;
  ack?: number;
} & RemoteMessageBase;

/**
 * Handles communication with a remote kernel endpoint over the network.
 */
export class RemoteHandle implements EndpointHandle {
  /** The ID of the remote connection this is the RemoteHandle for. */
  readonly remoteId: RemoteId;

  /** The peer ID of the remote kernel this is connected to. */
  readonly #peerId: string;

  /** Storage holding the kernel's persistent state. */
  readonly #kernelStore: KernelStore;

  /** The kernel's queue */
  readonly #kernelQueue: KernelQueue;

  /** Connectivity to the network. */
  readonly #remoteComms: RemoteComms;

  /** Possible contact points for reaching the remote peer. */
  readonly #locationHints: string[];

  /** Flag that location hints need to be sent to remote comms object. */
  #needsHinting: boolean = true;

  /**
   * Flag indicating the current BOYD was triggered by an incoming remote
   * request. When set, deliverBringOutYourDead will skip sending BOYD back
   * to the remote, preventing infinite ping-pong.
   */
  #remoteGcRequested: boolean = false;

  /** Pending URL redemption requests that have not yet been responded to. */
  readonly #pendingRedemptions: Map<
    string,
    [(ref: KRef) => void, (problem: string | Error) => void]
  > = new Map();

  /** Generation counter for keys to match URL redemption replies to requests. */
  #redemptionCounter: number = 1;

  /** Crank result object to reuse (since it's always the same). */
  readonly #myCrankResult: CrankResult;

  /** Logger for diagnostic output. */
  readonly #logger: Logger;

  // --- Sequence/ACK tracking state ---

  /**
   * Next sequence number to assign to outgoing messages. A copy of the store's
   * counter that lags it until {@link #putOnTheWire} catches it up.
   */
  #nextSendSeq: number = 0;

  /** Highest sequence number received from remote (for piggyback ACK). */
  #highestReceivedSeq: number = 0;

  /** Sequence number of first message in pending queue. */
  #startSeq: number = 0;

  /**
   * Messages written down but not yet handed to the transport. A delivery waits
   * here for its crank to commit, and anything numbered above it waits with it.
   */
  readonly #awaitingTransmit: Map<number, PersistedCommand> = new Map();

  /**
   * Highest sequence number this incarnation has handed to the transport. A
   * restart leaves it at the start of the pending queue, not its end: nothing
   * inherited has been handed over here.
   */
  #lastTransmittedSeq: number = 0;

  /**
   * The sends already on their way, which the next one waits behind.
   *
   * `sendRemoteMessage` reaches the wire by more than one route: the call that
   * finds no channel dials and shakes hands, while one arriving a moment later
   * finds that channel registered and writes straight away, overtaking it. Two
   * sends left to run concurrently therefore arrive in either order, and the
   * peer buffers no gaps — which would undo the ordering
   * {@link #flushTransmitQueue} exists to impose, most readily just after a
   * restart, when the queue is long and the channel is cold.
   */
  #outboundChain: Promise<void> = Promise.resolve();

  /** Retry count for pending messages (reset on ACK). */
  #retryCount: number = 0;

  /** Timer handle for ACK timeout (retransmission). */
  #ackTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  /** Timer handle for delayed ACK (standalone ACK when no outgoing traffic). */
  #delayedAckHandle: ReturnType<typeof setTimeout> | undefined;

  /** Callback invoked when we give up on this remote (for promise rejection). */
  readonly #onGiveUp: ((peerId: string) => void) | undefined;

  /** How long to wait for ACK before retransmitting (ms). Defaults to ACK_TIMEOUT_MS. */
  readonly #ackTimeoutMs: number;

  /**
   * Construct a new RemoteHandle instance.
   *
   * @param params - Named constructor parameters.
   * @param params.remoteId - Our remote ID.
   * @param params.peerId - The libp2p peer ID for the remote end.
   * @param params.kernelStore - The kernel's persistent state store.
   * @param params.kernelQueue - The kernel's queue.
   * @param params.remoteComms - Remote comms object to access the network.
   * @param params.locationHints - Possible contact points to reach the other end.
   * @param params.logger - Optional logger for diagnostic output.
   * @param params.onGiveUp - Optional callback when we give up on this remote.
   * @param params.ackTimeoutMs - Optional ACK timeout in ms. Defaults to ACK_TIMEOUT_MS.
   */
  // eslint-disable-next-line no-restricted-syntax
  private constructor({
    remoteId,
    peerId,
    kernelStore,
    kernelQueue,
    remoteComms,
    locationHints,
    logger,
    onGiveUp,
    ackTimeoutMs,
  }: RemoteHandleConstructorProps) {
    this.remoteId = remoteId;
    this.#peerId = peerId;
    this.#kernelStore = kernelStore;
    this.#kernelQueue = kernelQueue;
    this.#remoteComms = remoteComms;
    this.#locationHints = locationHints ?? [];
    this.#myCrankResult = { didDelivery: remoteId };
    this.#logger = logger ?? new Logger(`RemoteHandle:${peerId.slice(0, 8)}`);
    this.#onGiveUp = onGiveUp;
    this.#ackTimeoutMs = ackTimeoutMs ?? ACK_TIMEOUT_MS;
  }

  /**
   * Construct a new RemoteHandle instance.
   *
   * @param params - Named constructor parameters.
   * @param params.remoteId - Our remote ID.
   * @param params.peerId - The libp2p peer ID for the remote end.
   * @param params.kernelStore - The kernel's persistent state store.
   * @param params.kernelQueue - The kernel's queue.
   * @param params.remoteComms - Remote comms object to access the network.
   * @param params.logger - Optional logger for error and diagnostic output.
   * @param params.onGiveUp - Optional callback invoked when we give up on this remote.
   *
   * @returns the new RemoteHandle instance.
   */
  static make(params: RemoteHandleConstructorProps): RemoteHandle {
    const remote = new RemoteHandle(params);
    remote.#restorePersistedState();
    return remote;
  }

  /**
   * Restore persisted state from storage on startup.
   */
  #restorePersistedState(): void {
    const seqState = this.#kernelStore.getRemoteSeqState(this.remoteId);

    if (!seqState) {
      // No persisted seq state. Check for crash during first message enqueue:
      // Message may have been written but no seq state persisted yet.
      // First message always has seq 1 (since #nextSendSeq starts at 0, +1 = 1)
      if (this.#kernelStore.getPendingMessage(this.remoteId, 1)) {
        // Found orphan message - recover by setting up state
        this.#startSeq = 1;
        this.#nextSendSeq = 1;
        this.#kernelStore.setRemoteStartSeq(this.remoteId, 1);
        this.#kernelStore.setRemoteNextSendSeq(this.remoteId, 1);
        this.#logger.log(
          `${this.#peerId.slice(0, 8)}:: recovered orphan message at seq 1 from crash during first enqueue`,
        );
        this.#startAckTimeout();
      }
      return;
    }

    // Restore sequence state
    this.#highestReceivedSeq = seqState.highestReceivedSeq;
    this.#startSeq = seqState.startSeq;
    this.#nextSendSeq = seqState.nextSendSeq;

    // Check for crash during enqueue: message written but nextSendSeq not updated
    if (
      this.#kernelStore.getPendingMessage(this.remoteId, this.#nextSendSeq + 1)
    ) {
      this.#nextSendSeq += 1;
      this.#kernelStore.setRemoteNextSendSeq(this.remoteId, this.#nextSendSeq);
    }

    // The queue begins unsent: a crank can commit a message and the kernel die
    // before `afterCommit` hands it over, so the peer may never have seen any
    // of it. {@link #flushTransmitQueue} sends it ahead of whatever is
    // numbered next. Clamped because a store can hold a seq state whose
    // counters are both zero, and a watermark of -1 puts a sequence number
    // nothing can ever have at the head of the queue.
    this.#lastTransmittedSeq = Math.max(this.#startSeq - 1, 0);

    // Clean up orphan messages (seq < startSeq) left behind by crashes during ACK
    const orphansDeleted = this.#kernelStore.cleanupOrphanMessages(
      this.remoteId,
      this.#startSeq,
    );
    if (orphansDeleted > 0) {
      this.#logger.log(
        `${this.#peerId.slice(0, 8)}:: cleaned up ${orphansDeleted} orphan message(s) during recovery`,
      );
    }

    // If we have pending messages after recovery, start ACK timeout for retransmission
    if (this.#hasPendingMessages()) {
      this.#logger.log(
        `${this.#peerId.slice(0, 8)}:: restored ${this.#getPendingCount()} pending messages from persistence`,
      );
      this.#startAckTimeout();
    }
  }

  // --- Sequence/ACK management methods ---

  /**
   * Check if there are pending messages awaiting ACK.
   *
   * @returns True if there are pending messages.
   */
  #hasPendingMessages(): boolean {
    return hasPending(this.#seqWindow);
  }

  /**
   * Get the number of pending messages awaiting ACK.
   *
   * @returns The count of pending messages.
   */
  #getPendingCount(): number {
    return countPending(this.#seqWindow);
  }

  /**
   * The sequence window as this handle holds it in memory.
   *
   * @returns The in-memory window.
   */
  get #seqWindow(): SeqWindow {
    return { startSeq: this.#startSeq, nextSendSeq: this.#nextSendSeq };
  }

  /**
   * The sequence window as the store holds it, which is the one a crank
   * rollback restores.
   *
   * @returns The persisted window.
   */
  get #storedSeqWindow(): SeqWindow {
    const stored = this.#kernelStore.getRemoteSeqState(this.remoteId);
    return {
      startSeq: stored?.startSeq ?? 0,
      nextSendSeq: stored?.nextSendSeq ?? 0,
    };
  }

  /**
   * The window the next outgoing message is numbered from: the store's, which
   * a crank rollback restores, unless memory has gone further. Memory is ahead
   * only where a rollback took back a message the peer already had, and the
   * peer's view is the one that cannot be revised, so that number is never
   * handed out a second time.
   *
   * @returns The window to number from.
   */
  get #sendWindow(): SeqWindow {
    const stored = this.#storedSeqWindow;
    return this.#nextSendSeq > stored.nextSendSeq ? this.#seqWindow : stored;
  }

  /**
   * Get the current ACK value (highest received sequence number).
   *
   * @returns The ACK value, or undefined if no messages received yet.
   */
  #getAckValue(): number | undefined {
    return this.#highestReceivedSeq > 0 ? this.#highestReceivedSeq : undefined;
  }

  /**
   * Process an incoming ACK (cumulative - acknowledges all messages up to ackSeq).
   * Uses crash-safe ordering: update startSeq first, then delete acked messages.
   *
   * Measures the queue from memory, unlike {@link #rejectAllPending}, and must
   * keep doing so: memory stops at what has actually been sent, so a peer
   * cannot retire a message still awaiting its crank's commit, which
   * {@link #flushTransmitQueue} would then step over rather than send.
   *
   * @param ackSeq - The highest sequence number being acknowledged.
   */
  #handleAck(ackSeq: number): void {
    const seqsToDelete: number[] = [];
    const originalStartSeq = this.#startSeq;

    while (this.#startSeq <= ackSeq && this.#hasPendingMessages()) {
      seqsToDelete.push(this.#startSeq);
      this.#logger.log(
        `${this.#peerId.slice(0, 8)}:: message ${this.#startSeq} acknowledged`,
      );
      this.#startSeq += 1;
    }

    // Crash-safe dequeue: persist updated startSeq first, then delete messages
    // On crash recovery, orphan entries (seq < startSeq) will be cleaned lazily
    if (this.#startSeq !== originalStartSeq) {
      this.#kernelStore.setRemoteStartSeq(this.remoteId, this.#startSeq);
      for (const seq of seqsToDelete) {
        this.#kernelStore.deletePendingMessage(this.remoteId, seq);
      }
      // Reset retry count when messages are acknowledged
      this.#retryCount = 0;
    }

    // Restart or clear ACK timeout based on remaining pending messages
    this.#startAckTimeout();
  }

  /**
   * Start or restart the ACK timeout. If there are pending messages,
   * starts a timer. If the queue is empty, clears any existing timer.
   */
  #startAckTimeout(): void {
    this.#clearAckTimeout();
    if (this.#hasPendingMessages()) {
      this.#ackTimeoutHandle = setTimeout(() => {
        this.#handleAckTimeout();
      }, this.#ackTimeoutMs);
    }
  }

  /**
   * Clear the ACK timeout timer.
   */
  #clearAckTimeout(): void {
    // Tested against `undefined` rather than for truthiness, to agree with
    // {@link #putOnTheWire}, where the same field decides whether to arm one.
    if (this.#ackTimeoutHandle !== undefined) {
      clearTimeout(this.#ackTimeoutHandle);
      this.#ackTimeoutHandle = undefined;
    }
  }

  /**
   * Handle ACK timeout - either retransmit or give up.
   */
  #handleAckTimeout(): void {
    this.#ackTimeoutHandle = undefined;
    if (!this.#hasPendingMessages()) {
      return;
    }

    if (this.#retryCount >= MAX_RETRIES) {
      // Clean up locally first (unconditional), then notify RemoteManager
      // to reject kernel promises. giveUp() must run even when #onGiveUp
      // is unset, otherwise pending messages and redemptions leak.
      this.#logger.log(
        `${this.#peerId.slice(0, 8)}:: gave up after ${MAX_RETRIES} retries, rejecting ${this.#getPendingCount()} pending messages`,
      );
      this.giveUp(`not acknowledged after ${MAX_RETRIES} retries`);
      this.#onGiveUp?.(this.#peerId);
      return;
    }

    // Retransmit
    this.#retryCount += 1;
    this.#logger.log(
      `${this.#peerId.slice(0, 8)}:: retransmitting ${this.#getPendingCount()} pending messages (attempt ${this.#retryCount + 1})`,
    );
    this.#retransmitPending().catch((error) => {
      // Terminal errors propagate up to here; the loop already aborted, so
      // we don't re-arm the timer (no point retrying against a permanently
      // unreachable peer). Pending messages have been rejected and the
      // give-up callback fired by the inner handler.
      this.#logger.error(
        `${this.#peerId.slice(0, 8)}:: retransmission aborted:`,
        error,
      );
    });
  }

  /**
   * Retransmit all pending messages.
   *
   * Awaits each send, so a peer-restart detection during the first can
   * short-circuit the rest: clearRemoteSeqState (called by persistPeerRestart)
   * deletes both the seq counters and the `remotePending.*` payloads, so
   * `getPendingMessage` returns undefined for subsequent iterations and the
   * loop bound (`seq <= this.#nextSendSeq`, now 0) terminates immediately.
   * Were they to run concurrently, one that found the channel the first had
   * just registered would bypass the outbound handshake's stale-delivery
   * guard and write a pre-restart payload on it. {@link #outboundChain} keeps
   * them apart from a flush running at the same time, for the same reason.
   *
   * Terminal errors (intentional close, network stopped, peer-restart-detected
   * throw) abort the loop instead of being logged-and-skipped: continuing
   * would just rebuild the queue against a known-unreachable peer and
   * produce identical failures on every retry until MAX_RETRIES is hit.
   */
  async #retransmitPending(): Promise<void> {
    for (let seq = this.#startSeq; seq <= this.#nextSendSeq; seq += 1) {
      const messageString = this.#kernelStore.getPendingMessage(
        this.remoteId,
        seq,
      );
      if (!messageString) {
        continue;
      }
      try {
        await this.#sendInOrder(messageString);
      } catch (error) {
        if (isTerminalSendError(error)) {
          this.#logger.log(
            `${this.#peerId.slice(0, 8)}:: aborting retransmit (${(error as Error).message})`,
          );
          this.#clearAckTimeout();
          this.#rejectAllPending((error as Error).message);
          this.rejectPendingRedemptions((error as Error).message);
          this.#onGiveUp?.(this.#peerId);
          throw error;
        }
        this.#logger.error(
          `${this.#peerId.slice(0, 8)}:: error retransmitting seq=${seq}:`,
          error,
        );
      }
    }
    this.#startAckTimeout();
  }

  /**
   * Hand a message to the transport once everything already on its way has
   * gone, so that the order this handle sends in is the order the peer sees.
   *
   * Bounded: every send times out, so a peer that stops reading holds the
   * queue up only for as long as its own write takes to fail, and the failure
   * then empties the queue rather than lengthening it.
   *
   * @param messageString - The message, as it goes on the wire.
   * @returns A promise for this send alone; the caller handles its failure.
   */
  async #sendInOrder(messageString: string): Promise<void> {
    const sent = this.#outboundChain.then(async () =>
      this.#remoteComms.sendRemoteMessage(this.#peerId, messageString),
    );
    // The chain keeps going whatever this send does, or one failure would
    // strand every message behind it. Each caller answers for its own.
    this.#outboundChain = sent.then(
      () => undefined,
      () => undefined,
    );
    return sent;
  }

  /**
   * Discard all pending messages due to delivery failure. Safe no-op when the
   * queue is already empty, rather than writing a `startSeq` over kv state a
   * prior cleanup has reset.
   *
   * Measures the queue from {@link #sendWindow} rather than from memory,
   * because the transport detaches its failure handling from the send and the
   * run loop awaits between a delivery's persist and its `afterCommit`: this
   * can land in that gap, where the message just written down is in a part of
   * the queue only the store can see. Give up on less than the whole of it and
   * that message still goes to a peer whose promise for it has just been
   * rejected.
   *
   * @param reason - The reason for failure.
   */
  #rejectAllPending(reason: string): void {
    const window = this.#sendWindow;
    const pendingCount = countPending(window);
    if (pendingCount === 0) {
      return;
    }
    for (let i = 0; i < pendingCount; i += 1) {
      this.#logger.warn(
        `Message ${window.startSeq + i} delivery failed: ${reason}`,
      );
    }
    // Both ends of the window move, in memory and in the store, so no later
    // message is numbered below the one this abandons: a queue whose start has
    // outrun its end reads as empty to whatever numbers the next message, and
    // that message is then taken for one already retired.
    this.#startSeq = window.nextSendSeq + 1;
    this.#nextSendSeq = window.nextSendSeq;
    this.#kernelStore.setRemoteNextSendSeq(this.remoteId, window.nextSendSeq);
    this.#kernelStore.setRemoteStartSeq(this.remoteId, this.#startSeq);
    this.#retryCount = 0;
  }

  /**
   * Start the delayed ACK timer. When it fires, a standalone ACK will be sent
   * if no outgoing message has piggybacked the ACK.
   */
  #startDelayedAck(): void {
    this.#clearDelayedAck();
    const ackValue = this.#getAckValue();
    if (ackValue === undefined) {
      return;
    }
    this.#delayedAckHandle = setTimeout(() => {
      this.#delayedAckHandle = undefined;
      this.#sendStandaloneAck();
    }, DELAYED_ACK_MS);
  }

  /**
   * Clear the delayed ACK timer.
   */
  #clearDelayedAck(): void {
    if (this.#delayedAckHandle) {
      clearTimeout(this.#delayedAckHandle);
      this.#delayedAckHandle = undefined;
    }
  }

  /**
   * Send a standalone ACK message (no payload, just acknowledges received messages).
   */
  #sendStandaloneAck(): void {
    const ackValue = this.#getAckValue();
    if (ackValue === undefined) {
      return;
    }
    const ackMessage = JSON.stringify({ ack: ackValue });
    this.#logger.log(
      `${this.#peerId.slice(0, 8)}:: sending standalone ACK ${ackValue}`,
    );
    this.#remoteComms
      .sendRemoteMessage(this.#peerId, ackMessage)
      .catch((error) => {
        this.#logger.error('Error sending standalone ACK:', error);
      });
  }

  // --- Message sending ---

  /**
   * Hand a delivery to the peer, as the outcome of the crank making it. The
   * message is written down now, inside that crank's transaction, and sent once
   * it commits: a crank that goes on to fail must not leave the peer holding a
   * message the kernel has rolled back and will never account for again.
   *
   * The in-memory counters read one message behind the store between those two
   * steps, and the run loop awaits in between, so anything measuring the
   * pending queue there sees a queue short of this message —
   * {@link #rejectAllPending} measures it from the store for that reason. What
   * may also run in between is another message taking a later number, which
   * {@link #flushTransmitQueue} holds back until this one has gone.
   *
   * @param messageBase - The delivery to make.
   * @returns This handle's crank result, carrying the send.
   */
  #deliverToPeer(messageBase: Delivery): CrankResult {
    const persisted = this.#persistRemoteCommand(messageBase);
    return {
      ...this.#myCrankResult,
      afterCommit: async () => this.#transmitRemoteCommand(persisted),
    };
  }

  /**
   * Write an outgoing message down and send it in one step.
   *
   * Still the path for a request that awaits the peer's reply, which cannot
   * wait for a commit to go out. Those remain exposed to the rollback a
   * delivery no longer is; see {@link #deliverToPeer}. Its message may still go
   * out after a delivery whose crank has yet to commit, which costs nothing:
   * the caller awaits the peer's reply, not the send.
   *
   * @param messageBase - The message, before its sequence number and ack.
   * @param exemptFromCapacityLimit - Whether the pending queue's capacity limit
   * does not apply, for a reply that must not fail.
   */
  async #sendRemoteCommand(
    messageBase: Delivery | RedeemURLRequest | RedeemURLReply,
    exemptFromCapacityLimit = false,
  ): Promise<void> {
    this.#transmitRemoteCommand(
      this.#persistRemoteCommand(messageBase, { exemptFromCapacityLimit }),
    );
  }

  /**
   * Write an outgoing message to the store, so that a crash between here and
   * the peer's acknowledgement does not lose it. Separate from transmitting it
   * because a message prepared inside a crank must be persisted in that
   * crank's transaction, while sending it has to wait for the commit.
   *
   * Numbers the message from {@link #sendWindow} and leaves the in-memory
   * counters alone: a rollback takes these writes back but not RAM, and an
   * aborted crank that had moved them would leave the handle counting a
   * message the store no longer has — the next delivery would find the queue
   * non-empty and arm no ACK timeout, so a message that really did go out
   * would never be retransmitted. {@link #putOnTheWire} moves them, once the
   * number is one the peer has.
   *
   * @param messageBase - The message, before its sequence number and ack.
   * @param options - Options bag.
   * @param options.exemptFromCapacityLimit - Whether the pending queue's
   * capacity limit does not apply, for a reply that must not fail.
   * @param options.ack - The receipt to piggyback, when this crank is recording
   * one the handle has not caught up to yet.
   * @returns What transmitting it needs.
   */
  #persistRemoteCommand(
    messageBase: Delivery | RedeemURLRequest | RedeemURLReply,
    {
      exemptFromCapacityLimit = false,
      ack = this.#getAckValue(),
    }: { exemptFromCapacityLimit?: boolean; ack?: number | undefined } = {},
  ): PersistedCommand {
    const window = this.#sendWindow;

    // Check queue capacity before consuming any resources (seq number, ACK timer).
    if (
      !exemptFromCapacityLimit &&
      countPending(window) >= MAX_PENDING_MESSAGES
    ) {
      throw Error(
        `Message rejected: pending queue at capacity (${MAX_PENDING_MESSAGES})`,
      );
    }

    const wasEmpty = !hasPending(window);

    // Build full message with seq and optional piggyback ack
    const seq = window.nextSendSeq + 1;
    const remoteCommand: RemoteCommand =
      ack === undefined
        ? { seq, ...messageBase }
        : { seq, ack, ...messageBase };
    const messageString = JSON.stringify(remoteCommand);

    // Crash-safe enqueue order:
    // 1. Persist message first
    // 2. If first message, persist startSeq (so recovery knows where queue begins)
    // 3. Persist nextSendSeq last (recovery can repair this by scanning)
    this.#kernelStore.setPendingMessage(this.remoteId, seq, messageString);

    // Keyed on the store's own window, not the one the number came from: a
    // rollback can leave memory holding a sequence the store no longer has,
    // making this the first message of the store's queue though not of
    // memory's. Miss it and the store keeps a `startSeq` of 0, which a restart
    // reads as a queue beginning before its own first message.
    if (!hasPending(this.#storedSeqWindow)) {
      this.#kernelStore.setRemoteStartSeq(this.remoteId, seq);
    }

    this.#kernelStore.setRemoteNextSendSeq(this.remoteId, seq);

    return { seq, messageString, wasEmpty };
  }

  /**
   * Offer a message {@link #persistRemoteCommand} has already written down to
   * the transport. Writes no kernel state itself, so it is safe after the crank
   * has committed. The transport's own failure handling, which does write, runs
   * detached from this call and lands wherever it lands — see
   * {@link #rejectAllPending}.
   *
   * The message goes on the wire only once every lower sequence number has,
   * which {@link #flushTransmitQueue} decides.
   *
   * @param persisted - What that call returned.
   */
  #transmitRemoteCommand(persisted: PersistedCommand): void {
    // A peer restart between the persist and here empties the pending queue,
    // payloads and all, so a message still in it is one still owed to the peer
    // this handle is talking to. One that is gone belongs to an incarnation
    // that is gone, and sending it would spend a sequence number the new
    // incarnation has not seen — which it would then drop as a duplicate when
    // this handle numbers a real message with it.
    if (
      this.#kernelStore.getPendingMessage(this.remoteId, persisted.seq) ===
      undefined
    ) {
      return;
    }

    this.#awaitingTransmit.set(persisted.seq, persisted);
    this.#flushTransmitQueue();
  }

  /**
   * Hand over every message whose predecessors have gone, in sequence order.
   *
   * The peer drops anything at or below the highest sequence number it has
   * seen and buffers no gaps, so a message that overtakes an earlier one
   * destroys it: the earlier one is discarded as a duplicate on arrival and a
   * cumulative ACK then retires both. A delivery is handed over a commit later
   * than it is numbered, and a request that cannot wait for that commit is
   * numbered from the store meanwhile, so the two do overtake. So does a
   * restart, whose inherited queue would otherwise wait for the ACK timeout,
   * behind whatever the kernel sends first.
   */
  #flushTransmitQueue(): void {
    for (;;) {
      const next = this.#lastTransmittedSeq + 1;

      // Retired — acknowledged, or abandoned by a give-up — so the peer is owed
      // nothing at this number and nothing will take it. Stop here and the
      // queue behind it never moves again.
      if (next < this.#startSeq) {
        if (this.#awaitingTransmit.delete(next)) {
          this.#logger.log(
            `${this.#peerId.slice(0, 8)}:: message ${next} abandoned before it was sent`,
          );
        }
        this.#lastTransmittedSeq = next;
        continue;
      }

      // An unheld number belongs either to a crank still to commit, which
      // `afterCommit` will bring here, or to one a restart inherited, which is
      // owed to the peer now. `#nextSendSeq` tells them apart: a crank's number
      // is above it, being what the message was numbered from. A give-up can
      // raise it over one, but raises the queue's start with it, so the
      // step-over above has taken that number already.
      const held = this.#awaitingTransmit.get(next);
      if (!held && next > this.#nextSendSeq) {
        return;
      }
      this.#awaitingTransmit.delete(next);

      const messageString = this.#kernelStore.getPendingMessage(
        this.remoteId,
        next,
      );
      if (messageString === undefined) {
        // A held message rolled back between its persist and its turn, so the
        // peer is not owed it. The number goes back to the store to be handed
        // out again, and the message that takes it will arrive here and be sent
        // in its place — so the watermark must not move past it.
        if (held) {
          return;
        }
        // A number the store has already issued, so nothing will ever take it:
        // a rolled-back mid-crank send leaves one behind, the next message
        // being numbered from memory, which the rollback did not reach.
        // Waiting on it would wedge the queue for the life of the incarnation.
        this.#logger.log(
          `${this.#peerId.slice(0, 8)}:: nothing to send at seq ${next}, moving on`,
        );
        this.#lastTransmittedSeq = next;
        continue;
      }

      this.#lastTransmittedSeq = next;
      // An inherited message was already in a queue and is already counted by
      // `#nextSendSeq`, so neither of the counters `#putOnTheWire` keeps
      // should move for it.
      this.#putOnTheWire({
        seq: next,
        messageString,
        wasEmpty: held?.wasEmpty ?? false,
      });
    }
  }

  /**
   * Hand one message to the transport, its turn in sequence order having come.
   *
   * @param persisted - The message to send.
   */
  #putOnTheWire(persisted: PersistedCommand): void {
    const { seq, messageString, wasEmpty } = persisted;

    if (wasEmpty) {
      this.#startSeq = seq;
    }
    if (seq > this.#nextSendSeq) {
      this.#nextSendSeq = seq;
    }

    if (this.#needsHinting) {
      // Hints are registered lazily because (a) transmitting to the platform
      // services process has to be done asynchronously, which is very painful
      // to do at construction time, and (b) after a kernel restart (when we
      // might have a lot of known peers with hint information) connection
      // re-establishment will also be lazy, with a reasonable chance of never
      // even happening if we never talk to a particular peer again. Instead, we
      // wait until we know a given peer needs to be communicated with before
      // bothering to send its hint info.
      //
      // Fire-and-forget: Don't await this call to avoid RPC deadlock when
      // this method is called inside an RPC handler (e.g., during remoteDeliver).
      this.#remoteComms
        .registerLocationHints(this.#peerId, this.#locationHints)
        .catch((error) => {
          this.#logger.error('Error registering location hints:', error);
        });
      this.#needsHinting = false;
    }

    // Clear delayed ACK timer - we're piggybacking the ACK on this message
    this.#clearDelayedAck();

    // Keyed on the timer rather than on this being the queue's first message,
    // so a queue left untimed — by a rejection that landed between this
    // message's persist and its send — gets one rather than waiting on a timer
    // no later send will arm.
    if (this.#ackTimeoutHandle === undefined) {
      this.#startAckTimeout();
    }

    // Send the message (non-blocking - don't wait for ACK).
    //
    // Terminal verdicts from the transport (peer restarted, intentional
    // close, network stopped) mean the message we just persisted will
    // never be delivered as-is: reject all pending now and signal give-up
    // rather than letting the message linger until ACK timeout × MAX_RETRIES.
    //
    // For PeerRestartedError specifically, the kernel-side
    // `onIncarnationChange` callback ran `persistPeerRestart` and
    // `finalizePeerRestart` synchronously *before* the transport threw, so
    // most of the cleanup below is already a no-op. The guards inside
    // `#rejectAllPending` and `rejectPendingRedemptions` keep this safe;
    // calling `#onGiveUp` again exercises an idempotent path.
    this.#sendInOrder(messageString).catch((error) => {
      if (isTerminalSendError(error)) {
        const reason = (error as Error).message;
        this.#clearAckTimeout();
        this.#rejectAllPending(reason);
        this.rejectPendingRedemptions(reason);
        this.#onGiveUp?.(this.#peerId);
        return;
      }
      this.#logger.error(
        `${this.#peerId.slice(0, 8)}:: error sending remote message seq=${seq}:`,
        error,
      );
    });
  }

  /**
   * Send a 'message' delivery to the remote.
   *
   * @param target - The ref of the object to which the message is addressed.
   * @param message - The message to deliver.
   * @returns the crank result.
   */
  async deliverMessage(
    target: ERef,
    message: EndpointMessage,
  ): Promise<CrankResult> {
    return this.#deliverToPeer({
      method: 'deliver',
      params: ['message', target, message],
    });
  }

  /**
   * Send a 'notify' delivery to the remote.
   *
   * @param resolutions - One or more promise resolutions to deliver.
   * @returns the crank result.
   */
  async deliverNotify(resolutions: VatOneResolution[]): Promise<CrankResult> {
    return this.#deliverToPeer({
      method: 'deliver',
      params: ['notify', resolutions],
    });
  }

  /**
   * Send a 'dropExports' delivery to the remote.
   *
   * @param erefs - The refs of the exports to be dropped.
   * @returns the crank result.
   */
  async deliverDropExports(erefs: ERef[]): Promise<CrankResult> {
    return this.#deliverToPeer({
      method: 'deliver',
      params: ['dropExports', erefs],
    });
  }

  /**
   * Send a 'retireExports' delivery to the remote.
   *
   * @param erefs - The refs of the exports to be retired.
   * @returns the crank result.
   */
  async deliverRetireExports(erefs: ERef[]): Promise<CrankResult> {
    return this.#deliverToPeer({
      method: 'deliver',
      params: ['retireExports', erefs],
    });
  }

  /**
   * Send a 'retireImports' delivery to the remote.
   *
   * @param erefs - The refs of the imports to be retired.
   * @returns the crank result.
   */
  async deliverRetireImports(erefs: ERef[]): Promise<CrankResult> {
    return this.#deliverToPeer({
      method: 'deliver',
      params: ['retireImports', erefs],
    });
  }

  /**
   * Send a 'bringOutYourDead' delivery to the remote, requesting it to run
   * its garbage collection cycle. If the current BOYD was triggered by an
   * incoming remote request, skip sending to prevent infinite ping-pong.
   *
   * @returns the crank result.
   */
  async deliverBringOutYourDead(): Promise<CrankResult> {
    if (this.#remoteGcRequested) {
      this.#remoteGcRequested = false;
      return this.#myCrankResult;
    }
    return this.#deliverToPeer({
      method: 'deliver',
      params: ['bringOutYourDead'],
    });
  }

  // Warning: The handling of the GC deliveries ('dropExports', 'retireExports',
  // and 'dropImports') is very confusing.
  //
  // For example, in the context of this RemoteHandle, 'dropExports' means the
  // RemoteHandle at the other end of the network was delivered a 'dropExports'
  // by *its* kernel, telling it that references which that RemoteHandle had
  // been exporting to its kernel are no longer referenced by that kernel. But
  // exports from the remote end to its kernel are imports from the local kernel
  // into this RemoteHandle (which is to say, this end had to import them from
  // the local kernel here in order to have them so they could be exported at
  // the other end). This in turn means that receiving a 'dropExports' message
  // over the network tells this RemoteHandle to stop importing the indicated
  // references. A vat in these circumstances would use a 'dropImports' syscall
  // to accomplish this, and we use the same code that underpins the
  // 'dropImports' syscall to do that job here.  But it's definitely confusing
  // that we use 'dropImports' code to implement 'dropExports'. Analogous
  // reasoning applies to the other GC deliveries:
  //
  //      DELIVERY | "SYSCALL"
  // --------------+--------------
  //   dropExports | dropImports
  // retireExports | retireImports
  // retireImports | retireExports

  /**
   * Handle a 'dropExports' delivery from the remote end.
   *
   * @param erefs - The refs of the exports to be dropped.
   */
  #dropExports(erefs: ERef[]): void {
    const krefs = erefs.map((ref) =>
      this.#kernelStore.translateRefEtoK(this.remoteId, ref),
    );
    performDropImports(krefs, this.remoteId, this.#kernelStore);
  }

  /**
   * Handle a 'retireExports' delivery from the remote end.
   *
   * @param erefs - The refs of the exports to be retired.
   */
  #retireExports(erefs: ERef[]): void {
    const krefs = erefs.map((ref) =>
      this.#kernelStore.translateRefEtoK(this.remoteId, ref),
    );
    performRetireImports(krefs, this.remoteId, this.#kernelStore);
  }

  /**
   * Handle a 'retireImports' delivery from the remote end.
   *
   * @param erefs - The refs of the imports to be retired.
   */
  #retireImports(erefs: ERef[]): void {
    const krefs = erefs.map((ref) =>
      this.#kernelStore.translateRefEtoK(this.remoteId, ref),
    );
    performExportCleanup(krefs, true, this.remoteId, this.#kernelStore);
  }

  /**
   * Handle a delivery from the remote end.
   *
   * @param params - the delivery params, which vary based on the kind of delivery.
   */
  #handleRemoteDeliver(params: DeliveryParams): void {
    const [method] = params;
    switch (method) {
      case 'message': {
        const [, target, message] = params;
        this.#kernelQueue.enqueueSend(
          this.#kernelStore.translateRefEtoK(this.remoteId, target),
          this.#kernelStore.translateMessageEtoK(this.remoteId, message),
        );
        break;
      }
      case 'notify': {
        const [, resolutions] = params;
        const kResolutions: KernelOneResolution[] = resolutions.map(
          (resolution) => {
            const [rpid, rejected, data] = resolution;
            insistERef(rpid);
            return [
              this.#kernelStore.translateRefEtoK(this.remoteId, rpid),
              rejected,
              this.#kernelStore.translateCapDataEtoK(
                this.remoteId,
                data as CapData<ERef>,
              ),
            ];
          },
        );
        this.#kernelQueue.resolvePromises(this.remoteId, kResolutions);
        break;
      }
      case 'dropExports': {
        const [, erefs] = params;
        this.#dropExports(erefs);
        break;
      }
      case 'retireExports': {
        const [, erefs] = params;
        this.#retireExports(erefs);
        break;
      }
      case 'retireImports': {
        const [, erefs] = params;
        this.#retireImports(erefs);
        break;
      }
      case 'bringOutYourDead': {
        // Queue work like the arms above: `scheduleReap` is consumed only by the
        // run loop, via `nextReapAction`. The other GC arms need no guard — they
        // only touch refcounts, which the caller's crank commits by itself.
        this.#kernelStore.scheduleReap(this.remoteId);
        break;
      }
      default:
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw Error(`unknown remote delivery method ${method}`);
    }
  }

  /**
   * Prepare to handle an incoming redeemURL message. Validates and translates
   * but does not send the reply. Returns data needed to complete after commit.
   *
   * @param url - The ocap URL attempting to be redeemed.
   * @param replyKey - A sender-provided tag to send with the reply.
   * @returns Data needed to complete the operation after commit.
   */
  async #handleRedeemURLRequest(
    url: string,
    replyKey: string,
  ): Promise<DeferredRedeemURLRequest> {
    assert.typeof(replyKey, 'string');
    let kref: KRef;
    try {
      kref = await this.#remoteComms.redeemLocalOcapURL(url);
    } catch (error) {
      return {
        type: 'redeemURL',
        replyKey,
        error: `${(error as Error).message}`,
      };
    }
    const ref = this.#kernelStore.translateRefKtoE(this.remoteId, kref, true);
    return { type: 'redeemURL', replyKey, ref };
  }

  /**
   * Write the reply to a redeemURL request to the store, ready to send.
   *
   * @param data - What handling the request worked out.
   * @param ack - The sequence number of the request being replied to.
   * @returns The persisted reply, for {@link #transmitRemoteCommand}.
   */
  #persistRedeemURLReply(
    data: DeferredRedeemURLRequest,
    ack: number,
  ): PersistedCommand {
    const success = 'ref' in data;
    const value = success ? data.ref : data.error;
    return this.#persistRemoteCommand(
      {
        method: 'redeemURLReply',
        params: [success, data.replyKey, value],
      },
      {
        // exempt from capacity limit - this a reply that mustn't fail and is not vat-initiated
        exemptFromCapacityLimit: true,
        // The request being replied to. This crank records the receipt, so the
        // acknowledgement is durable exactly when the reply is.
        ack,
      },
    );
  }

  /**
   * Prepare to handle an incoming redeemURLReply message. Validates and
   * translates but does not modify in-memory state. Returns data needed to
   * complete after commit.
   *
   * @param success - Whether the redemption was successful.
   * @param replyKey - The reply key for matching to pending redemption.
   * @param result - Either the kref (on success) or error message (on failure).
   * @returns Data needed to complete the operation after commit.
   */
  #handleRedeemURLReply(
    success: boolean,
    replyKey: string,
    result: string,
  ): DeferredRedeemURLReply {
    if (!this.#pendingRedemptions.has(replyKey)) {
      throw Error(`unknown URL redemption reply key ${replyKey}`);
    }
    if (success) {
      insistERef(result);
      const ref = this.#kernelStore.translateRefEtoK(this.remoteId, result);
      return { type: 'redeemURLReply', replyKey, ref };
    }
    return { type: 'redeemURLReply', replyKey, error: result };
  }

  /**
   * Complete handling of an incoming redeemURLReply message by resolving the
   * pending promise.
   *
   * @param data - The data from #handleRedeemURLReply.
   */
  #completeHandleRedeemURLReply(data: DeferredRedeemURLReply): void {
    const handlers = this.#pendingRedemptions.get(data.replyKey);
    // handlers should exist since we validated in prepare, but check for safety
    if (handlers) {
      this.#pendingRedemptions.delete(data.replyKey);
      const [resolve, reject] = handlers;
      if ('ref' in data) {
        resolve(data.ref);
      } else {
        reject(data.error);
      }
    }
  }

  /**
   * Take a message off the wire from this peer.
   *
   * Acknowledgements and validation happen here, at receive time: they are
   * in-memory, idempotent, and must not wait for a turn in the run queue.
   * Everything that touches the kernel store happens in
   * {@link deliverInbound}, in a crank of its own, rather than in a savepoint
   * nested inside whichever crank is open.
   *
   * @param message - The message, as it arrived.
   */
  receiveFromPeer(message: string): void {
    const parsed = JSON.parse(message);

    // Handle standalone ACK message (no seq, no method - just ack)
    if (parsed.ack !== undefined && parsed.seq === undefined) {
      this.#handleAck(parsed.ack);
      return;
    }

    const { seq, ack } = parsed as RemoteCommand;

    // Handle piggyback ACK if present (ACK processing is idempotent)
    if (ack !== undefined) {
      this.#handleAck(ack);
    }

    // Start delayed ACK timer - will send standalone ACK if no outgoing
    // traffic. Ahead of everything below, including the duplicate check the
    // crank makes: a retransmission is the peer telling us it never got our
    // acknowledgement, and it has to provoke another one.
    this.#startDelayedAck();

    // Validate seq value. Here rather than in the crank, because a run queue
    // item that throws on delivery kills the run loop and is rolled back onto
    // the queue to kill the next boot too.
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
      throw Error(`invalid message seq: ${seq}`);
    }

    this.#kernelQueue.acceptRemoteInbound(this.remoteId, message);
  }

  /**
   * Take delivery of a message from the peer, in a crank of its own.
   *
   * @param message - The message, as it arrived.
   * @returns The crank outcome, carrying the work that follows the commit.
   */
  async deliverInbound(message: string): Promise<CrankResult> {
    const command = JSON.parse(message) as RemoteCommand;

    // Against the store, not `#highestReceivedSeq`: several messages from this
    // peer can be waiting their turn in the run queue at once, and the
    // in-memory value only catches up as each one's crank commits.
    const highestReceived =
      this.#kernelStore.getRemoteSeqState(this.remoteId)?.highestReceivedSeq ??
      0;
    if (command.seq <= highestReceived) {
      this.#logger.log(
        `${this.#peerId.slice(0, 8)}:: ignoring duplicate message seq=${command.seq} (highestReceived=${highestReceived})`,
      );
      return { didDelivery: this.remoteId };
    }

    const afterCommit = await this.#receiveInbound(command);
    return { didDelivery: this.remoteId, afterCommit };
  }

  /**
   * Carry out an inbound message's writes. Everything here belongs to the
   * crank's one transaction: the message is processed and its sequence number
   * recorded together, or neither happens, which is what makes delivery
   * exactly-once across a crash.
   *
   * @param command - The parsed message.
   * @returns The work to run once those writes are durable: in-memory state,
   * and sending the reply this has already written down.
   */
  async #receiveInbound(command: RemoteCommand): Promise<() => Promise<void>> {
    const { seq, method, params } = command;
    let deferredCompletion: DeferredCompletion | undefined;

    switch (method) {
      case 'deliver':
        this.#handleRemoteDeliver(params);
        break;
      case 'redeemURL':
        deferredCompletion = await this.#handleRedeemURLRequest(...params);
        break;
      case 'redeemURLReply':
        deferredCompletion = this.#handleRedeemURLReply(...params);
        break;
      default:
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw Error(`unknown remote message type ${method}`);
    }

    this.#kernelStore.setRemoteHighestReceivedSeq(this.remoteId, seq);

    // Written down inside the crank; only sending it waits for the commit.
    const reply =
      deferredCompletion?.type === 'redeemURL'
        ? this.#persistRedeemURLReply(deferredCompletion, seq)
        : undefined;

    return async () => {
      // Updating in-memory seq state after commit ensures any ACK piggybacked
      // on outgoing messages doesn't acknowledge uncommitted message receipts.
      this.#highestReceivedSeq = seq;

      // Set ping-pong prevention flag after commit so it's only visible once
      // the BOYD delivery is durably recorded.
      if (method === 'deliver' && params[0] === 'bringOutYourDead') {
        this.#remoteGcRequested = true;
      }

      if (reply) {
        this.#transmitRemoteCommand(reply);
      } else if (deferredCompletion?.type === 'redeemURLReply') {
        this.#completeHandleRedeemURLReply(deferredCompletion);
      }

      // Restart delayed ACK timer, which may have been cleared by transmitting.
      this.#startDelayedAck();
    };
  }

  /**
   * Obtain a reference to an object designated by an ocap URL.
   *
   * @param url - The ocap URL to be redeemed.
   *
   * @returns a promise for the kref of the object designated by `url`.
   */
  async redeemOcapURL(url: string): Promise<KRef> {
    const replyKey = `${this.#redemptionCounter}`;
    this.#redemptionCounter += 1;
    const { promise, resolve, reject } = makePromiseKit<KRef>();
    this.#pendingRedemptions.set(replyKey, [resolve, reject]);

    // Set up timeout handling with AbortSignal.
    // Use (MAX_RETRIES + 1)× ACK timeout as the redemption deadline: enough
    // time for the full ACK retry cycle (initial + retransmissions) to complete.
    const redemptionTimeoutMs = this.#ackTimeoutMs * (MAX_RETRIES + 1);
    const timeoutSignal = AbortSignal.timeout(redemptionTimeoutMs);
    let abortHandler: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, _reject) => {
      abortHandler = () => {
        // Clean up from pending redemptions map
        if (this.#pendingRedemptions.has(replyKey)) {
          this.#pendingRedemptions.delete(replyKey);
        }
        _reject(
          new Error(`URL redemption timed out after ${redemptionTimeoutMs}ms`),
        );
      };
      timeoutSignal.addEventListener('abort', abortHandler);
    });

    try {
      await this.#sendRemoteCommand({
        method: 'redeemURL',
        params: [url, replyKey],
      });
      // Wait for reply with timeout protection
      return await Promise.race([promise, timeoutPromise]);
    } catch (error) {
      // Clean up and remove from map if still pending
      if (this.#pendingRedemptions.has(replyKey)) {
        this.#pendingRedemptions.delete(replyKey);
      }
      throw error;
    } finally {
      // Clean up event listener to prevent unhandled rejection if operation
      // completes before timeout
      if (abortHandler) {
        timeoutSignal.removeEventListener('abort', abortHandler);
      }
    }
  }

  /**
   * Reject all pending URL redemptions with the given error message.
   * Called when we give up on this remote connection.
   *
   * @param errorMessage - The error message to reject with.
   */
  rejectPendingRedemptions(errorMessage: string): void {
    const error = Error(errorMessage);
    for (const [, [, reject]] of this.#pendingRedemptions) {
      reject(error);
    }
    this.#pendingRedemptions.clear();
  }

  /**
   * Permanently give up on this remote. Stops retransmitting, rejects all
   * pending messages and URL redemptions. Called by RemoteManager when the
   * transport layer determines the peer is unreachable.
   *
   * @param reason - Human-readable reason for giving up.
   */
  giveUp(reason: string): void {
    this.#clearAckTimeout();
    this.#rejectAllPending(reason);
    this.rejectPendingRedemptions(reason);
  }

  /**
   * Clean up resources held by this RemoteHandle.
   * Clears all timers and rejects pending promises to prevent resource leaks
   * and allow garbage collection. Called by RemoteManager during cleanup.
   */
  cleanup(): void {
    this.#clearAckTimeout();
    this.#clearDelayedAck();
    this.rejectPendingRedemptions('Remote connection cleanup');
  }

  /**
   * Persist the peer-restart side effects (kv-only). Reversible by the
   * caller's savepoint: if `forgetEndpointImports` throws (e.g. corrupt
   * c-list entry, refcount underflow) and the caller rolls back, no
   * in-memory state has been disturbed.
   *
   * Pairs with {@link finalizePeerRestart}, which the caller MUST invoke
   * exactly once after `releaseSavepoint` succeeds. Splitting the work
   * keeps non-reversible mutations (timers, rejected redemption promises,
   * in-memory seq counters) out of the savepoint window — those would
   * leave the in-memory view inconsistent with the persisted view if the
   * kv layer rolled back.
   */
  persistPeerRestart(): void {
    this.#logger.log(
      `${this.#peerId.slice(0, 8)}:: handling peer restart, resetting state`,
    );
    this.#kernelStore.clearRemoteSeqState(this.remoteId);
    this.#kernelStore.forgetEndpointImports(this.remoteId);
  }

  /**
   * Convenience wrapper that runs the persisted and in-memory phases
   * back-to-back. Use only outside a savepoint window — transactional
   * callers (e.g. {@link RemoteManager.handleIncarnationChange}) must call
   * {@link persistPeerRestart} inside the savepoint and
   * {@link finalizePeerRestart} after release, so a kv rollback can't
   * leave the in-memory view inconsistent with the persisted view.
   */
  handlePeerRestart(): void {
    this.persistPeerRestart();
    this.finalizePeerRestart();
  }

  /**
   * Apply the in-memory side of a peer restart: discard arrivals from the
   * incarnation that is gone, cancel timers, reject in-flight URL redemption
   * promises, and reset sequence counters. Must be called after
   * {@link persistPeerRestart} and after the caller's savepoint has been
   * released.
   */
  finalizePeerRestart(): void {
    this.#kernelQueue.discardRemoteInbound(this.remoteId);
    const pendingCount = this.#getPendingCount();
    if (this.#hasPendingMessages()) {
      this.#logger.log(
        `${this.#peerId.slice(0, 8)}:: discarding ${pendingCount} pending messages due to peer restart`,
      );
    }
    this.#clearAckTimeout();
    this.#clearDelayedAck();
    this.rejectPendingRedemptions('Remote peer restarted');
    this.#nextSendSeq = 0;
    this.#highestReceivedSeq = 0;
    this.#startSeq = 0;
    this.#lastTransmittedSeq = 0;
    this.#awaitingTransmit.clear();
    this.#retryCount = 0;
    this.#remoteGcRequested = false;
  }
}
