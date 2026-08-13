import type { Logger } from '@metamask/logger';

import { initRemoteComms, initRemoteIdentity } from './remote-comms.ts';
import { RemoteHandle } from './RemoteHandle.ts';
import type { KernelQueue } from '../../KernelQueue.ts';
import { makeKernelError } from '../../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../../store/index.ts';
import type { PlatformServices, RemoteId } from '../../types.ts';
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
   * Rejects all promises for which this remote is the decider.
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
   * Compares the observed incarnation against the value persisted in the
   * kernel store. When they differ AND a previous value was on file, the peer
   * has truly restarted: persist the new incarnation and reset the
   * RemoteHandle's seq dedup state, atomically with respect to the kv layer
   * so a crash mid-reset can't leave us with the new dedup state under the
   * old recorded incarnation.
   *
   * The savepoint guards only kv-layer writes (`setPeerIncarnation` plus
   * everything `handlePeerRestart` persists via `clearRemoteSeqState` and
   * `forgetEndpointImports`). Run-queue mutations (`resolvePromises`) and
   * the in-memory counter resets inside `RemoteHandle.handlePeerRestart`
   * are NOT reversible by a savepoint, so we collect the work to do inside
   * the savepoint, commit, and then fan it out — mirroring the
   * deferred-completion pattern in `RemoteHandle.handleRemoteMessage`.
   *
   * Fires on every handshake (not only on detected change) because the
   * in-memory PeerStateManager is unreliable across receiver restart and
   * stale-peer cleanup; the persisted value is the authoritative anchor for
   * detecting peer restart.
   *
   * @param peerId - The peer that completed the handshake.
   * @param observedIncarnation - The incarnationId the peer just reported.
   * @returns Whether the peer was determined to have restarted (a defined
   *   prior value differed from the observed one). The transport uses this
   *   to suppress stale outbound messages on the same connection.
   */
  async #handleIncarnationChange(
    peerId: string,
    observedIncarnation: string,
  ): Promise<boolean> {
    const stored = this.#kernelStore.getPeerIncarnation(peerId);
    if (stored === observedIncarnation) {
      return false;
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

    const savepoint = `peerIncarnation_${peerId}`;
    this.#kernelStore.createSavepoint(savepoint);
    try {
      if (isRestart) {
        this.#logger?.log(
          `Peer ${peerId.slice(0, 8)} restarted (incarnation ${stored.slice(0, 8)} → ${observedIncarnation.slice(0, 8)})`,
        );
        if (remote) {
          remote.persistPeerRestart();
        } else {
          // No live RemoteHandle for the peer but a persisted incarnation
          // exists — usually a transient race during kernel boot before
          // initRemoteComms has finished restoring remotes. The persisted
          // bookkeeping the missing handle would have cleaned up may leak.
          // Surfacing as a warning so operators can correlate.
          this.#logger?.warn(
            `Peer ${peerId.slice(0, 8)} restart detected but no live RemoteHandle; advancing persisted incarnation without c-list cleanup`,
          );
        }
      }
      this.#kernelStore.setPeerIncarnation(peerId, observedIncarnation);
      this.#kernelStore.releaseSavepoint(savepoint);
    } catch (error) {
      try {
        this.#kernelStore.rollbackSavepoint(savepoint);
      } catch (rollbackError) {
        // The release above is inside the `try`, and a failed RELEASE discards
        // the whole savepoint stack — so this rollback reports a savepoint that
        // is already gone, over the database failure an operator actually needs.
        // Still attempted, because a release that failed for a reason of its own
        // may well have left the savepoint standing.
        this.#logger?.error(`Rollback of ${savepoint} failed`, rollbackError);
      }
      throw error;
    }

    // Post-commit fan-out: in-memory state changes and run-queue
    // mutations are not reversible by a savepoint, so they wait until the
    // kv layer is durable.
    if (isRestart && remote) {
      remote.finalizePeerRestart();
      if (promisesToReject.length > 0) {
        const failure = makeKernelError(
          'PEER_RESTARTED',
          'Remote peer restarted (incarnation changed)',
        );
        for (const kpid of promisesToReject) {
          this.#kernelQueue.resolvePromises(remote.remoteId, [
            [kpid, true, failure],
          ]);
        }
      }
    }

    return isRestart;
  }

  /**
   * Initialize the remote comms object at kernel startup.
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

    this.#remoteComms = await initRemoteComms(
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
    this.#remoteIdentity = this.#remoteComms;

    // Restore all remotes that were previously established
    for (const {
      remoteId,
      remoteInfo,
    } of this.#kernelStore.getAllRemoteRecords()) {
      this.#initializeRemote(remoteId, remoteInfo);
    }
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
   * Set up bookkeeping for a newly established remote connection.
   *
   * @param peerId - Peer ID of the kernel at the other end of the connection.
   * @param hints - Optional list of possible relays via which the requested peer might be contacted.
   * @returns the RemoteHandle that was set up.
   */
  establishRemote(peerId: string, hints: string[] = []): RemoteHandle {
    const remoteId = this.#kernelStore.getNextRemoteId();
    const remoteInfo: RemoteInfo = { peerId, hints };
    const remote = this.#initializeRemote(remoteId, remoteInfo);
    this.#kernelStore.setRemoteInfo(remoteId, remoteInfo);
    this.#kernelStore.initEndpoint(remoteId);
    return remote;
  }

  /**
   * Initializes a remote handle for communication with a remote kernel.
   *
   * @param remoteId - The unique identifier for the remote kernel.
   * @param info - Information about the remote including peer ID and connection hints.
   * @returns A handle for communicating with the remote kernel.
   */
  #initializeRemote(remoteId: RemoteId, info: RemoteInfo): RemoteHandle {
    const { peerId, hints } = info;
    const remoteComms = this.getRemoteComms();

    const remote = RemoteHandle.make({
      remoteId,
      peerId,
      kernelStore: this.#kernelStore,
      kernelQueue: this.#kernelQueue,
      remoteComms,
      locationHints: hints,
      logger: this.#logger,
      onGiveUp: this.#handleRemoteGiveUp.bind(this),
      ackTimeoutMs: this.#ackTimeoutMs,
    });
    this.#remotes.set(remoteId, remote);
    this.#remotesByPeer.set(peerId, remote);
    return remote;
  }

  /**
   * Get or create a RemoteHandle for a given peer ID.
   *
   * @param peerId - The libp2p peer for which a handle is sought.
   * @param hints - Optional list of possible relays via which the requested peer might be contacted.
   *
   * @returns an existing or new RemoteHandle to communicate with `peerId`.
   */
  remoteFor(peerId: string, hints: string[] = []): RemoteHandle {
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
   * @returns a promise for the response message, or null if no response is needed.
   */
  async handleRemoteMessage(
    from: string,
    message: string,
  ): Promise<string | null> {
    const remote = this.remoteFor(from);
    return await remote.handleRemoteMessage(message);
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
