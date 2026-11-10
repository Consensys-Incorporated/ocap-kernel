import type { Logger } from '@metamask/logger';

import { initRemoteComms, initRemoteIdentity } from './remote-comms.ts';
import { RemoteHandle } from './RemoteHandle.ts';
import type { KernelQueue } from '../../KernelQueue.ts';
import { makeKernelError } from '../../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../../store/index.ts';
import type {
  CrankResult,
  PlatformServices,
  RemoteId,
  RunQueueItemPeerIncarnation,
} from '../../types.ts';
import type {
  RemoteIdentity,
  RemoteComms,
  RemoteMessageHandler,
  RemoteInfo,
  RemoteCommsOptions,
} from '../types.ts';

type RemoteManagerConstructorProps = {
  platformServices: PlatformServices;
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
  logger?: Logger;
  keySeed?: string | undefined;
  mnemonic?: string | undefined;
};

/**
 * Manages remote kernel connections and communications.
 */
export class RemoteManager {
  /** Currently active remote kernel connections, by ID */
  readonly #remotes: Map<RemoteId, RemoteHandle> = new Map();

  /** Currently active remote kernel connections, by remote Peer ID */
  readonly #remotesByPeer: Map<string, RemoteHandle> = new Map();

  /** Platform services for network operations */
  readonly #platformServices: PlatformServices;

  /** Storage holding the kernel's persistent state */
  readonly #kernelStore: KernelStore;

  /** The kernel's run queue */
  readonly #kernelQueue: KernelQueue;

  /** Logger for outputting messages to the console */
  readonly #logger: Logger | undefined;

  /** Optional seed string for libp2p key generation */
  readonly #keySeed: string | undefined;

  /** Optional mnemonic for seed derivation */
  readonly #mnemonic: string | undefined;

  /** Optional ACK timeout override for RemoteHandle instances */
  #ackTimeoutMs: number | undefined;

  /**
   * Unique identifier for this kernel instance.
   * Used to detect when a remote peer has lost its state and reconnected.
   */
  readonly #incarnationId: string;

  /** Remote identity (peer ID, crypto keys, OCAP URL operations) */
  #remoteIdentity: RemoteIdentity | undefined;

  /** Remote communications interface */
  #remoteComms: RemoteComms | undefined;

  /** Handler for incoming remote messages */
  #messageHandler: RemoteMessageHandler | undefined;

  /**
   * Peers whose restart's crank has torn the session down and has yet to
   * commit. A handshake reports the restart until then, so the new
   * incarnation's channel opens only once its session is in place.
   */
  readonly #recordingRestart = new Set<string>();

  /**
   * Creates a new RemoteManager instance.
   *
   * @param options - Constructor options.
   * @param options.platformServices - Platform-specific services for network communication.
   * @param options.kernelStore - The kernel's persistent state store.
   * @param options.kernelQueue - The kernel's message queue for scheduling deliveries.
   * @param options.logger - Logger instance for debugging and diagnostics.
   * @param options.keySeed - Seed for generating the kernel's cryptographic key pair.
   * @param options.mnemonic - BIP39 mnemonic for deriving the kernel's cryptographic key pair.
   */
  constructor({
    platformServices,
    kernelStore,
    kernelQueue,
    logger,
    keySeed,
    mnemonic,
  }: RemoteManagerConstructorProps) {
    this.#platformServices = platformServices;
    this.#kernelStore = kernelStore;
    this.#kernelQueue = kernelQueue;
    this.#logger = logger;
    this.#keySeed = keySeed;
    this.#mnemonic = mnemonic;
    // Get incarnation ID from store - it's persisted so it survives restarts
    this.#incarnationId = kernelStore.provideIncarnationId();
  }

  /**
   * Set the message handler for incoming remote messages.
   * This should be called during initialization to properly wire up message handling.
   *
   * @param handler - The function to handle incoming remote messages
   */
  setMessageHandler(handler: RemoteMessageHandler): void {
    this.#messageHandler = handler;
  }

  /**
   * Initialize the kernel's remote identity (peer ID, crypto keys, OCAP URL
   * operations) without starting network communications. This is sufficient
   * for issuing and redeeming local OCAP URLs.
   *
   * @param options - Options for identity initialization.
   * @param options.mnemonic - BIP39 mnemonic for seed recovery.
   * @returns a promise that resolves when initialization is complete.
   */
  async initIdentity(options?: {
    mnemonic?: string | undefined;
  }): Promise<void> {
    const mnemonic = options?.mnemonic ?? this.#mnemonic;
    const mergedOptions = {
      ...(mnemonic === undefined ? {} : { mnemonic }),
    };

    const { identity } = await initRemoteIdentity(
      this.#kernelStore,
      mergedOptions,
      this.#logger,
      this.#keySeed,
    );
    this.#remoteIdentity = identity;
  }

  /**
   * Get the remote identity object.
   *
   * @returns the remote identity object.
   * @throws if neither remote identity nor remote comms is initialized.
   */
  getRemoteIdentity(): RemoteIdentity {
    const identity = this.#remoteIdentity ?? this.#remoteComms;
    if (identity) {
      return identity;
    }
    throw Error('Remote identity not initialized');
  }

  /**
   * Check if remote identity is initialized (either standalone or via full comms).
   *
   * @returns true if remote identity is initialized, false otherwise.
   */
  isIdentityInitialized(): boolean {
    return (
      this.#remoteIdentity !== undefined || this.#remoteComms !== undefined
    );
  }

  /**
   * Handle when we give up on a remote (after max retries or non-retryable error).
   * Rejects all promises for which this remote is the decider, unless a
   * restart of the peer waits: its crank rejects them, as `PEER_RESTARTED`,
   * and lets go of the redemptions once it commits.
   *
   * @param peerId - The peer ID of the remote we're giving up on.
   */
  #handleRemoteGiveUp(peerId: string): void {
    // Find the RemoteId for this peerId
    const remote = this.#remotesByPeer.get(peerId);
    if (!remote) {
      // Remote not found - might have been cleaned up already
      return;
    }
    if (this.#restartWaits(peerId)) {
      this.#logger?.log(
        `Peer ${peerId.slice(0, 8)} not given up on while its restart waits; that crank rejects its promises`,
      );
      return;
    }

    const { remoteId } = remote;
    const reason = `Remote connection lost: ${peerId} (max retries reached or non-retryable error)`;
    const failure = makeKernelError('CONNECTION_LOST', reason);

    // Stop retransmitting and reject pending messages + URL redemptions.
    // Called from both ACK-timeout and transport give-up paths. The ACK
    // path calls giveUp() before invoking this callback, but giveUp() is
    // idempotent so the repeat is harmless and keeps the transport path correct.
    remote.giveUp(reason);

    // Reject all promises for which this remote is the decider
    for (const kpid of this.#kernelStore.getPromisesByDecider(remoteId)) {
      this.#kernelQueue.resolvePromises(remoteId, [[kpid, true, failure]]);
    }
  }

  /**
   * Handle a peer's reported incarnation after a successful handshake.
   *
   * When the observed incarnation is new for the peer, queues the change for
   * {@link applyIncarnationChange} to record in a crank of its own. The
   * transport needs the answer to finish the handshake and cannot wait for
   * that crank, so it comes from the incarnations the kernel knows: the one
   * the store holds and the ones waiting to be recorded. While a change from
   * a known incarnation waits, every handshake reports a restart. Nothing is
   * awaited between reading them and queueing the change, or two handshakes
   * could queue one incarnation twice.
   *
   * Fires on every handshake (not only on detected change) because the
   * in-memory PeerStateManager is unreliable across receiver restart and
   * stale-peer cleanup; the persisted value is the authoritative anchor for
   * detecting peer restart.
   *
   * @param peerId - The peer that completed the handshake.
   * @param observedIncarnation - The incarnationId the peer just reported.
   * @returns Whether the peer restarted, or a restart of it waits for its
   *   crank or is in one yet to commit. The transport then closes the
   *   connection, keeping stale outbound messages off it.
   */
  async #handleIncarnationChange(
    peerId: string,
    observedIncarnation: string,
  ): Promise<boolean> {
    const stored = this.#kernelStore.getPeerIncarnation(peerId);
    const waiting = this.#kernelQueue.waitingIncarnations(peerId);
    const known = stored === undefined ? waiting : [stored, ...waiting];
    if (!known.includes(observedIncarnation)) {
      this.#kernelQueue.acceptPeerIncarnation({
        peerId,
        incarnation: observedIncarnation,
        restart: known.length > 0,
      });
    }
    const restarted =
      this.#recordingRestart.has(peerId) ||
      known.some((incarnation) => incarnation !== observedIncarnation);
    if (restarted) {
      this.#remotesByPeer.get(peerId)?.holdForRestart();
    }
    return restarted;
  }

  /**
   * Whether a restart of a peer waits for its crank: a change from the
   * incarnation the store holds, or from a first one still waiting ahead of
   * it.
   *
   * @param peerId - The peer.
   * @returns True if a restart waits.
   */
  #restartWaits(peerId: string): boolean {
    const waiting = this.#kernelQueue.waitingIncarnations(peerId).length;
    return this.#kernelStore.getPeerIncarnation(peerId) === undefined
      ? waiting > 1
      : waiting > 0;
  }

  /**
   * Let every remote send again, for a kernel discarding the queued
   * incarnation changes that would have released them.
   */
  releaseRestartHolds(): void {
    for (const remote of this.#remotesByPeer.values()) {
      remote.releaseRestartHold();
    }
  }

  /**
   * Record a peer's incarnation change, for the run loop to call in a crank of
   * its own.
   *
   * @param item - The change, as accepted at handshake time.
   * @returns The crank outcome, carrying the work that follows the commit.
   */
  applyIncarnationChange(item: RunQueueItemPeerIncarnation): CrankResult {
    const { peerId, incarnation } = item;
    const stored = this.#kernelStore.getPeerIncarnation(peerId);
    // A handshake queues only an incarnation the kernel does not know, so this
    // is a kernel bug, and a second teardown would take what the new
    // incarnation has built since.
    if (stored === incarnation) {
      throw Error(
        `Peer ${peerId} incarnation ${incarnation} is already recorded`,
      );
    }
    const isRestart = stored !== undefined;
    const remote = isRestart ? this.#remotesByPeer.get(peerId) : undefined;

    // Snapshot the decider list BEFORE any kv mutation so the c-list lookup
    // can still find the promises through the entries forgetEndpointImports
    // is about to tear down. We materialize into an array because the
    // generator iterates over kv state that we'll mutate.
    const promisesToReject = remote
      ? Array.from(this.#kernelStore.getPromisesByDecider(remote.remoteId))
      : [];

    if (isRestart) {
      this.#logger?.log(
        `Peer ${peerId.slice(0, 8)} restarted (incarnation ${stored.slice(0, 8)} → ${incarnation.slice(0, 8)})`,
      );
      if (remote) {
        remote.persistPeerRestart();
        this.#recordingRestart.add(peerId);
      } else {
        // Every remote the store has holds a handle from boot, so this peer has
        // only shaken hands, and has no c-list.
        this.#logger?.warn(
          `Peer ${peerId.slice(0, 8)} restart detected but no live RemoteHandle; advancing persisted incarnation without c-list cleanup`,
        );
      }
    }
    this.#kernelStore.setPeerIncarnation(peerId, incarnation);

    if (!remote) {
      return {};
    }

    // In the crank, not after it, because rejecting writes; `false` leaves the
    // notifies to the crank's flush.
    const failure = makeKernelError(
      'PEER_RESTARTED',
      'Remote peer restarted (incarnation changed)',
    );
    for (const kpid of promisesToReject) {
      this.#kernelQueue.resolvePromises(
        remote.remoteId,
        [[kpid, true, failure]],
        false,
      );
    }

    return {
      afterCommit: async () => {
        this.#recordingRestart.delete(peerId);
        remote.finalizePeerRestart();
        // A later restart still waits, and what this remote sends belongs to
        // the incarnation it ends.
        if (this.#restartWaits(peerId)) {
          remote.holdForRestart();
        }
      },
    };
  }

  /**
   * Give every remote the store has a handle, for the kernel to call before its
   * run loop starts.
   */
  restoreRemotes(): void {
    for (const {
      remoteId,
      remoteInfo,
    } of this.#kernelStore.getAllRemoteRecords()) {
      this.#initializeRemote(remoteId, remoteInfo);
    }
  }

  /**
   * Initialize the remote comms object at kernel startup, and attach it to the
   * remotes {@link restoreRemotes} restored.
   *
   * @param options - Options for remote communications initialization.
   * @returns a promise that resolves when initialization is complete.
   */
  async initRemoteComms(options?: RemoteCommsOptions): Promise<void> {
    if (!this.#messageHandler) {
      throw Error(
        'Message handler must be set before initializing remote comms',
      );
    }

    // Merge mnemonic from constructor if not provided in options
    const mergedOptions: RemoteCommsOptions = {
      ...options,
      mnemonic: options?.mnemonic ?? this.#mnemonic,
    };

    this.#ackTimeoutMs = mergedOptions.ackTimeoutMs;

    const remoteComms = await initRemoteComms(
      this.#kernelStore,
      this.#platformServices,
      this.#messageHandler,
      mergedOptions,
      this.#logger,
      this.#keySeed,
      this.#handleRemoteGiveUp.bind(this),
      this.#incarnationId,
      this.#handleIncarnationChange.bind(this),
    );
    for (const remote of this.#remotes.values()) {
      remote.attachTransport({
        remoteComms,
        ackTimeoutMs: this.#ackTimeoutMs,
      });
    }
    // Last, since it opens `withRemote` to peers: every handle can send by now.
    this.#remoteComms = remoteComms;
    this.#remoteIdentity = remoteComms;
  }

  /**
   * Clean up remote manager state.
   * This should be called when remote comms are stopped externally.
   */
  cleanup(): void {
    // Clean up all RemoteHandle instances to clear their timers
    for (const remote of this.#remotes.values()) {
      remote.cleanup();
    }
    this.#remoteIdentity = undefined;
    this.#remoteComms = undefined;
    this.#remotes.clear();
    this.#remotesByPeer.clear();
  }

  /**
   * Get the remote comms object.
   *
   * @returns the remote comms object.
   * @throws if the remote comms object is not initialized.
   */
  getRemoteComms(): RemoteComms {
    if (this.#remoteComms) {
      return this.#remoteComms;
    }
    throw Error('Remote comms not initialized');
  }

  /**
   * Check if remote comms is initialized.
   *
   * @returns true if remote comms is initialized, false otherwise.
   */
  isRemoteCommsInitialized(): boolean {
    return this.#remoteComms !== undefined;
  }

  /**
   * Get the peer ID of this kernel.
   *
   * @returns the peer ID.
   * @throws if remote identity is not initialized.
   */
  getPeerId(): string {
    return this.getRemoteIdentity().getPeerId();
  }

  /**
   * Set up bookkeeping for a newly established remote connection, at once.
   * Call it only through {@link withRemote}, which waits for the open crank to
   * end.
   *
   * @param peerId - Peer ID of the kernel at the other end of the connection.
   * @param hints - Optional list of possible relays via which the requested peer might be contacted.
   * @returns the RemoteHandle that was set up.
   */
  establishRemote(peerId: string, hints: string[] = []): RemoteHandle {
    // Before any write, so that remote comms being down costs no remote ID.
    this.getRemoteComms();
    const remoteId = this.#kernelStore.getNextRemoteId();
    const remoteInfo: RemoteInfo = { peerId, hints };
    // Before the records, since making the handle reads the store and can
    // throw: a record left with no handle would give the peer a second remote.
    const remote = this.#initializeRemote(remoteId, remoteInfo);
    try {
      this.#kernelStore.initEndpoint(remoteId);
      // After the endpoint: a restart loads remotes from this record, so one
      // written before `initEndpoint` threw would come back with no endpoint.
      this.#kernelStore.setRemoteInfo(remoteId, remoteInfo);
    } catch (error) {
      // A write that threw must leave no handle for a later caller.
      this.#remotes.delete(remoteId);
      this.#remotesByPeer.delete(peerId);
      throw error;
    }
    return remote;
  }

  /**
   * Initializes a remote handle for communication with a remote kernel, with
   * the transport if remote comms are up.
   *
   * @param remoteId - The unique identifier for the remote kernel.
   * @param info - Information about the remote including peer ID and connection hints.
   * @returns A handle for communicating with the remote kernel.
   */
  #initializeRemote(remoteId: RemoteId, info: RemoteInfo): RemoteHandle {
    const { peerId, hints } = info;

    const remote = RemoteHandle.make({
      remoteId,
      peerId,
      kernelStore: this.#kernelStore,
      kernelQueue: this.#kernelQueue,
      remoteComms: this.#remoteComms,
      locationHints: hints,
      logger: this.#logger,
      onGiveUp: this.#handleRemoteGiveUp.bind(this),
      ackTimeoutMs: this.#ackTimeoutMs,
    });
    // Made after the handshake that found the restart, so held as that
    // handshake would have held it.
    if (this.#restartWaits(peerId)) {
      remote.holdForRestart();
    }
    this.#remotes.set(remoteId, remote);
    this.#remotesByPeer.set(peerId, remote);
    return remote;
  }

  /**
   * Act on the RemoteHandle for a peer, setting one up if it has none. A new
   * one is set up once the open crank, if any, has ended: set up inside it,
   * an abort would give its ID to the next new remote while its handle lives
   * on. `use` runs as soon as the handle exists, never after an `await`, so a
   * peer's messages are taken in the order they came.
   *
   * @param peerId - The libp2p peer for which a handle is sought.
   * @param options - Options bag.
   * @param options.hints - Possible relays via which the peer might be
   * contacted.
   * @param options.use - What to do with the handle. For a new peer, only
   * what it writes before its first `await` is held with the setup.
   * @returns A promise for what `use` returns.
   */
  async withRemote<Result>(
    peerId: string,
    {
      hints = [],
      use,
    }: {
      hints?: string[];
      use: (remote: RemoteHandle) => Result | Promise<Result>;
    },
  ): Promise<Result> {
    // A stored peer has a handle from boot, but until remote comms are up it
    // could not acknowledge or answer a message, nor send a redemption.
    this.getRemoteComms();
    if (this.#remotesByPeer.has(peerId)) {
      return use(this.#provideRemote(peerId, hints));
    }
    this.#kernelQueue.assertRunLoopAlive('set up a remote');
    // Boxed, since `writeOutsideCrank` refuses a promise; one `use` returns is
    // the caller's to await.
    const { used } = await this.#kernelQueue.writeOutsideCrank(() => ({
      // `#provideRemote`, not `establishRemote`: a setup held for an
      // earlier caller may run first.
      used: use(this.#provideRemote(peerId, hints)),
    }));
    return used;
  }

  /**
   * Get or create a RemoteHandle for a given peer ID, now.
   *
   * @param peerId - The peer.
   * @param hints - Its location hints.
   * @returns Its RemoteHandle.
   */
  #provideRemote(peerId: string, hints: string[]): RemoteHandle {
    const existing = this.#remotesByPeer.get(peerId);
    if (existing) {
      if (hints.length > 0) {
        this.getRemoteComms()
          .registerLocationHints(peerId, hints)
          .catch((error: unknown) => {
            this.#logger?.error(
              `Failed to register location hints for ${peerId}: ${String(error)}`,
            );
          });
      }
      return existing;
    }
    return this.establishRemote(peerId, hints);
  }

  /**
   * Get a remote by its ID.
   *
   * @param remoteId - The ID of the remote.
   * @returns the remote's RemoteHandle.
   * @throws if the remote is not found.
   */
  getRemote(remoteId: RemoteId): RemoteHandle {
    const remote = this.#remotes.get(remoteId);
    if (remote === undefined) {
      throw Error(`Remote not found: ${remoteId}`);
    }
    return remote;
  }

  /**
   * Handle a message from a remote kernel.
   *
   * @param from - The peer ID of the sender.
   * @param message - The message content.
   * @returns Null: nothing is answered on arrival, and any reply goes out once
   * the crank that takes the message has committed.
   */
  async handleRemoteMessage(
    from: string,
    message: string,
  ): Promise<string | null> {
    await this.withRemote(from, {
      use: (remote) => remote.receiveFromPeer(message),
    });
    return null;
  }

  /**
   * Explicitly close a connection to a peer.
   * Marks the peer as intentionally closed to prevent automatic reconnection.
   *
   * @param peerId - The peer ID to close the connection for.
   */
  async closeConnection(peerId: string): Promise<void> {
    this.getRemoteComms(); // Ensure remote comms is initialized
    await this.#platformServices.closeConnection(peerId);
  }

  /**
   * Schedule reap for remotes that match the filter.
   * This is for debugging and testing purposes only.
   *
   * @param filter - A function that returns true if the remote should be reaped.
   */
  reapRemotes(filter: (remoteId: RemoteId) => boolean = () => true): void {
    for (const remoteId of this.#remotes.keys()) {
      if (filter(remoteId)) {
        this.#kernelStore.scheduleReap(remoteId);
      }
    }
  }

  /**
   * Take note of where a peer might be.
   *
   * @param peerId - The peer ID to which this information applies.
   * @param hints - Location hints for the peer.
   */
  async registerLocationHints(peerId: string, hints: string[]): Promise<void> {
    await this.getRemoteComms().registerLocationHints(peerId, hints);
  }

  /**
   * Manually reconnect to a peer after intentional close.
   * Clears the intentional close flag and initiates reconnection.
   *
   * @param peerId - The peer ID to reconnect to.
   * @param hints - Optional hints for reconnection.
   */
  async reconnectPeer(peerId: string, hints: string[] = []): Promise<void> {
    this.getRemoteComms(); // Ensure remote comms is initialized
    await this.#platformServices.reconnectPeer(peerId, hints);
  }
}
