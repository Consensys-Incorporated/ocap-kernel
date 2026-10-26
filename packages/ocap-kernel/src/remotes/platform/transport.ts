import { StreamResetError } from '@libp2p/interface';
import type { StreamCloseEvent } from '@libp2p/interface';
import {
  InvalidDataLengthError,
  InvalidDataLengthLengthError,
} from '@libp2p/utils';
import {
  AbortError,
  IntentionalCloseError,
  NetworkStoppedError,
  PeerRestartedError,
  ResourceLimitError,
} from '@metamask/kernel-errors';
import { installWakeDetector } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { toString as bufToString, fromString } from 'uint8arrays';

import { makeErrorLogger, writeWithTimeout } from './channel-utils.ts';
import { ConnectionFactory } from './connection-factory.ts';
import {
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_CONNECTION_RATE_LIMIT,
  DEFAULT_MAX_CONCURRENT_CONNECTIONS,
  DEFAULT_MAX_MESSAGE_SIZE_BYTES,
  DEFAULT_MESSAGE_RATE_LIMIT,
  DEFAULT_STALE_PEER_TIMEOUT_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
  SCTP_USER_INITIATED_ABORT,
  MIN_STREAM_INACTIVITY_TIMEOUT_MS,
  STREAM_INACTIVITY_TIMEOUT_MS,
} from './constants.ts';
import {
  performOutboundHandshake,
  performInboundHandshake,
} from './handshake.ts';
import type { HandshakeDeps } from './handshake.ts';
import { PeerStateManager } from './peer-state-manager.ts';
import {
  makeConnectionRateLimiter,
  makeMessageRateLimiter,
} from './rate-limiter.ts';
import { makeReconnectionLifecycle } from './reconnection-lifecycle.ts';
import { ReconnectionManager } from './reconnection.ts';
import {
  makeConnectionLimitChecker,
  makeMessageSizeValidator,
} from './validators.ts';
import type {
  RemoteMessageHandler,
  SendRemoteMessage,
  StopRemoteComms,
  Channel,
  OnRemoteGiveUp,
  OnIncarnationChange,
  OutboundHandshakeResult,
  RemoteCommsOptions,
} from '../types.ts';

/**
 * Detect whether a read error indicates an intentional disconnect.
 * Checks for the v3 typed `StreamResetError` (fired when the remote explicitly
 * aborts a stream, e.g. during shutdown) and falls back to legacy SCTP sniffing
 * for WebRTC user-initiated abort (code 12).
 *
 * @param problem - The error thrown by a stream read.
 * @returns Whether the error represents an intentional disconnect.
 */
function isIntentionalDisconnect(problem: unknown): boolean {
  if (problem instanceof StreamResetError) {
    return true;
  }
  const rtcProblem = problem as {
    errorDetail?: string;
    sctpCauseCode?: number;
  };
  return (
    rtcProblem?.errorDetail === 'sctp-failure' &&
    rtcProblem?.sctpCauseCode === SCTP_USER_INITIATED_ABORT
  );
}

/**
 * Initialize the remote comm system with information that must be provided by the kernel.
 *
 * @param keySeed - Seed value for key generation, in the form of a hex-encoded string.
 * @param options - Options for remote communications initialization.
 * @param options.relays - PeerIds/Multiaddrs of known message relays.
 * @param options.maxRetryAttempts - Maximum number of reconnection attempts. 0 = infinite (default).
 * @param options.maxQueue - Maximum pending messages per peer (default: 200).
 * @param options.maxConcurrentConnections - Maximum number of concurrent connections (default: 100).
 * @param options.maxMessageSizeBytes - Maximum message size in bytes (default: 1MB).
 * @param options.cleanupIntervalMs - Stale peer cleanup interval in milliseconds (default: 15 minutes).
 * @param options.stalePeerTimeoutMs - Stale peer timeout in milliseconds (default: 1 hour).
 * @param options.maxMessagesPerSecond - Maximum messages per second per peer (default: 100).
 * @param options.maxConnectionAttemptsPerMinute - Maximum connection attempts per minute per peer (default: 10).
 * @param remoteMessageHandler - Handler to be called when messages are received from elsewhere.
 * @param onRemoteGiveUp - Optional callback to be called when we give up on a remote (after max retries or non-retryable error).
 * @param localIncarnationId - This kernel's incarnation ID for handshake protocol.
 * @param onIncarnationChange - Optional callback when a remote peer's incarnation changes (peer restarted).
 *
 * @returns a function to send messages **and** a `stop()` to cancel/release everything.
 */
export async function initTransport(
  keySeed: string,
  options: RemoteCommsOptions,
  remoteMessageHandler: RemoteMessageHandler,
  onRemoteGiveUp?: OnRemoteGiveUp,
  localIncarnationId?: string,
  onIncarnationChange?: OnIncarnationChange,
): Promise<{
  sendRemoteMessage: SendRemoteMessage;
  stop: StopRemoteComms;
  closeConnection: (peerId: string) => Promise<void>;
  registerLocationHints: (peerId: string, hints: string[]) => void;
  reconnectPeer: (peerId: string, hints?: string[]) => Promise<void>;
  resetAllBackoffs: () => void;
  getListenAddresses: () => string[];
}> {
  const {
    relays = [],
    maxRetryAttempts,
    maxConcurrentConnections = DEFAULT_MAX_CONCURRENT_CONNECTIONS,
    maxMessageSizeBytes = DEFAULT_MAX_MESSAGE_SIZE_BYTES,
    cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
    stalePeerTimeoutMs = DEFAULT_STALE_PEER_TIMEOUT_MS,
    maxMessagesPerSecond = DEFAULT_MESSAGE_RATE_LIMIT,
    maxConnectionAttemptsPerMinute = DEFAULT_CONNECTION_RATE_LIMIT,
    reconnectionBaseDelayMs,
    reconnectionMaxDelayMs,
    handshakeTimeoutMs,
    writeTimeoutMs,
    streamInactivityTimeoutMs,
    directTransports,
    allowedWsHosts,
  } = options;
  let cleanupWakeDetector: (() => void) | undefined;
  const stopController = new AbortController();
  const { signal } = stopController;
  const logger = new Logger();
  const outputError = makeErrorLogger(logger);
  const reconnectionManagerOpts: ConstructorParameters<
    typeof ReconnectionManager
  >[0] = {};
  if (reconnectionBaseDelayMs !== undefined) {
    reconnectionManagerOpts.backoffBaseDelayMs = reconnectionBaseDelayMs;
  }
  if (reconnectionMaxDelayMs !== undefined) {
    reconnectionManagerOpts.backoffMaxDelayMs = reconnectionMaxDelayMs;
  }
  const reconnectionManager = new ReconnectionManager(reconnectionManagerOpts);
  const peerStateManager = new PeerStateManager(logger, stalePeerTimeoutMs);
  const validateMessageSize = makeMessageSizeValidator(maxMessageSizeBytes);
  const checkConnectionLimit = makeConnectionLimitChecker(
    maxConcurrentConnections,
    () => peerStateManager.countActiveConnections(),
  );
  const messageRateLimiter = makeMessageRateLimiter(maxMessagesPerSecond);
  const connectionRateLimiter = makeConnectionRateLimiter(
    maxConnectionAttemptsPerMinute,
  );
  let cleanupIntervalId: ReturnType<typeof setInterval> | undefined;
  // Holder for handleConnectionLoss - assigned after reconnectionLifecycle is created.
  // The inner function is only called from callbacks after initialization completes.
  const connectionLossHolder: {
    impl: ((peerId: string) => void) | undefined;
  } = { impl: undefined };
  const handleConnectionLoss = (peerId: string): void => {
    if (!connectionLossHolder.impl) {
      throw new Error('handleConnectionLoss called before initialization');
    }
    connectionLossHolder.impl(peerId);
  };
  const connectionFactory = await ConnectionFactory.make({
    keySeed,
    knownRelays: relays,
    logger,
    signal,
    maxRetryAttempts,
    reconnectionBaseDelayMs,
    reconnectionMaxDelayMs,
    maxMessageSizeBytes,
    directTransports,
    allowedWsHosts,
  });

  // Create handshake dependencies (only if incarnation ID is configured).
  // The incarnation ID is optional primarily for unit tests that don't need
  // handshake behavior. In production, the kernel always provides an incarnation ID.
  const handshakeDeps: HandshakeDeps | undefined = localIncarnationId
    ? {
        localIncarnationId,
        logger,
        setRemoteIncarnation: (peerId: string, incarnationId: string) =>
          peerStateManager.setRemoteIncarnation(peerId, incarnationId),
        handshakeTimeoutMs,
        writeTimeoutMs,
      }
    : undefined;

  // `dialIdempotent` gives every concurrent dialer of a peer the same channel.
  // The peer acks one handshake, so a second one reads the peer's next message
  // instead, or times out, and its caller closes the shared channel.
  const outboundHandshakes = new WeakMap<
    Channel,
    ReturnType<typeof runOutboundHandshake>
  >();

  /**
   * Perform the outbound handshake on a channel once, however many callers
   * ask for it.
   *
   * @param channel - The channel to perform handshake on.
   * @returns Object with success status and whether incarnation changed.
   */
  async function doOutboundHandshake(
    channel: Channel,
  ): ReturnType<typeof runOutboundHandshake> {
    let handshake = outboundHandshakes.get(channel);
    if (!handshake) {
      handshake = runOutboundHandshake(channel);
      outboundHandshakes.set(channel, handshake);
    }
    return handshake;
  }

  /**
   * Perform outbound handshake and handle incarnation changes.
   *
   * @param channel - The channel to perform handshake on.
   * @returns Object with success status, whether incarnation changed, and the
   * incarnation the peer reported.
   */
  async function runOutboundHandshake(
    channel: Channel,
  ): Promise<OutboundHandshakeResult> {
    if (!handshakeDeps) {
      return harden({ success: true, incarnationChanged: false }); // No handshake configured, skip
    }
    let result;
    try {
      result = await performOutboundHandshake(channel, handshakeDeps);
    } catch (problem) {
      outputError(channel.peerId, 'outbound handshake', problem);
      return harden({ success: false, incarnationChanged: false });
    }
    // The PSM-detected change is unreliable across receiver-side state loss;
    // the kernel-side callback (backed by persistent storage) is the
    // authoritative source. Take the OR of both so callers' stale-message
    // guards trip whenever either layer detected a restart.
    //
    // Treat a callback throw as a handshake failure rather than letting it
    // propagate: the caller relies on the {success} return to decide
    // whether to close the channel, and an unhandled throw would skip
    // that close path on the inbound side.
    let kernelDetectedRestart: boolean;
    try {
      kernelDetectedRestart =
        (await onIncarnationChange?.(
          channel.peerId,
          result.remoteIncarnationId,
        )) ?? false;
    } catch (problem) {
      outputError(channel.peerId, 'outbound incarnation callback', problem);
      return harden({ success: false, incarnationChanged: false });
    }
    const incarnationChanged =
      result.incarnationChanged || kernelDetectedRestart;
    if (incarnationChanged) {
      logger.log(
        `${channel.peerId.slice(0, 8)}:: incarnation changed during outbound handshake`,
      );
    }
    return harden({
      success: true,
      incarnationChanged,
      remoteIncarnationId: result.remoteIncarnationId,
    });
  }

  /**
   * Perform inbound handshake and handle incarnation changes.
   *
   * On detected restart we reject the inbound channel: the kernel has yet to
   * tear down its c-list and seq state for this peer, so accepting the channel
   * here would let any concurrent in-flight outbound send write a pre-restart
   * payload over a fresh-incarnation channel, and what the peer sent on it
   * would be taken ahead of the waiting change, as the old incarnation's. The
   * caller closes the channel and the peer re-dials — symmetric with the
   * outbound `PeerRestartedError` path.
   *
   * @param channel - The channel to perform handshake on.
   * @returns True if handshake succeeded and the channel should be registered;
   *   false if the handshake failed OR a restart was detected (caller closes).
   */
  async function doInboundHandshake(channel: Channel): Promise<boolean> {
    if (!handshakeDeps) {
      return true;
    }
    let result;
    try {
      result = await performInboundHandshake(channel, handshakeDeps);
    } catch (problem) {
      outputError(channel.peerId, 'inbound handshake', problem);
      return false;
    }
    // Treat a callback throw as a handshake failure: the caller closes
    // the channel only when this returns false, so an unhandled throw
    // would let the channel escape upstream and be closed (noisily) by
    // the outer onInboundConnection catch. Better to fail closed here.
    let kernelDetectedRestart: boolean;
    try {
      kernelDetectedRestart =
        (await onIncarnationChange?.(
          channel.peerId,
          result.remoteIncarnationId,
        )) ?? false;
    } catch (problem) {
      outputError(channel.peerId, 'inbound incarnation callback', problem);
      return false;
    }
    if (result.incarnationChanged || kernelDetectedRestart) {
      logger.log(
        `${channel.peerId.slice(0, 8)}:: incarnation changed during inbound handshake, rejecting channel to force re-dial`,
      );
      return false;
    }
    return true;
  }

  /**
   * Clean up stale peer data for peers inactive for more than stalePeerTimeoutMs.
   * A peer is considered stale if:
   * - It has no active channel
   * - It has been inactive for more than stalePeerTimeoutMs
   */
  function cleanupStalePeers(): void {
    const stalePeers = peerStateManager.getStalePeers();
    for (const peerId of stalePeers) {
      peerStateManager.removePeer(peerId);
      reconnectionManager.stopReconnection(peerId);
      messageRateLimiter.clearKey(peerId);
      connectionRateLimiter.clearKey(peerId);
    }
    // Also prune stale rate limiter entries that may not have peer state
    messageRateLimiter.pruneStale();
    connectionRateLimiter.pruneStale();
  }

  /**
   * Register a channel for a peer, closing any previous channel.
   * This ensures proper cleanup of old channels to prevent leaks.
   * Handshake must be completed BEFORE calling this function.
   *
   * @param peerId - The peer ID.
   * @param channel - The channel to register.
   * @param errorContext - Context string for error logging.
   */
  function registerChannel(
    peerId: string,
    channel: Channel,
    errorContext = 'reading channel to',
  ): void {
    const state = peerStateManager.getState(peerId);
    const previousChannel = state.channel;
    if (previousChannel === channel) {
      // Every caller that shared the channel's dial registers it.
      return;
    }
    state.channel = channel;
    peerStateManager.updateConnectionTime(peerId);

    // Set stream inactivity timeout for detecting dead streams.
    // This is distinct from the per-write timeout — it covers bidirectional
    // silence across the stream's lifetime.
    channel.stream.inactivityTimeout = Math.max(
      streamInactivityTimeoutMs ?? STREAM_INACTIVITY_TIMEOUT_MS,
      MIN_STREAM_INACTIVITY_TIMEOUT_MS,
    );

    // Listen for v3 fine-grained close events for diagnostics.
    channel.stream.addEventListener(
      'close',
      (evt: Event) => {
        const { local, error } = evt as StreamCloseEvent;
        if (local) {
          const suffix = error ? `: ${error.message}` : '';
          logger.log(`${peerId}:: stream closed locally${suffix}`);
        } else if (error) {
          logger.log(`${peerId}:: stream reset by remote: ${error.message}`);
        } else {
          logger.log(`${peerId}:: stream closed by remote (clean)`);
        }
      },
      { once: true },
    );

    readChannel(channel).catch((problem) => {
      outputError(peerId, errorContext, problem);
    });

    // If we replaced an existing channel, close it to avoid leaks and stale readers.
    if (previousChannel) {
      const closePromise = connectionFactory.closeChannel(
        previousChannel,
        peerId,
      );
      if (typeof closePromise?.catch === 'function') {
        closePromise.catch((problem) => {
          outputError(peerId, 'closing replaced channel', problem);
        });
      }
    }
  }

  /**
   * Check if an existing channel exists for a peer, and if so, reuse it.
   * Otherwise, return the dialed channel for the caller to register.
   * This handles race conditions when simultaneous inbound + outbound connections occur.
   *
   * @param peerId - The peer ID for the channel.
   * @param dialedChannel - The newly dialed channel.
   * @returns The channel to use (either existing or the dialed one), or null if
   * the existing channel died during the await and the dialed channel was already closed.
   */
  async function reuseOrReturnChannel(
    peerId: string,
    dialedChannel: Channel,
  ): Promise<Channel | null> {
    const state = peerStateManager.getState(peerId);
    const existingChannel = state.channel;
    if (existingChannel) {
      // Close the dialed channel if it's different from the existing one
      if (dialedChannel !== existingChannel) {
        await connectionFactory.closeChannel(dialedChannel, peerId);
        // Re-check if existing channel is still valid after await
        // It may have been removed if readChannel exited during the close,
        // or a new channel may have been registered concurrently
        const currentChannel = state.channel;
        if (currentChannel === existingChannel) {
          // Existing channel is still valid, use it
          return existingChannel;
        }
        if (currentChannel) {
          // A different channel was registered concurrently, use that instead
          return currentChannel;
        }
        // Existing channel died during await, but we already closed dialed channel
        // Return null to signal caller needs to handle this (re-dial or fail)
        return null;
      }
      // Same channel, check if it's still valid
      if (state.channel === existingChannel) {
        // Still the same channel, use it
        return existingChannel;
      }
      // Channel changed during our check, use the current one
      if (state.channel) {
        return state.channel;
      }
      // Channel became null, return null to signal re-dial needed
      return null;
    }
    // No existing channel, return the dialed one for registration
    return dialedChannel;
  }

  /**
   * Receive a message from a peer.
   *
   * @param from - The peer ID that the message is from.
   * @param message - The message to receive.
   */
  async function receiveMessage(from: string, message: string): Promise<void> {
    logger.log(`${from}:: recv ${message.substring(0, 200)}`);

    // Pass all messages to handler (including ACK-only messages - handler handles them)
    // Handshake messages are handled during connection establishment, not here.
    try {
      const reply = await remoteMessageHandler(from, message);
      // Send reply if non-empty (reply is already a serialized string from RemoteHandle)
      if (reply) {
        // IMPORTANT: Don't await here! Awaiting would block the read loop.
        // Fire-and-forget - RemoteHandle handles ACK tracking.
        sendRemoteMessage(from, reply).catch((replyError) => {
          outputError(from, 'sending reply', replyError);
        });
      }
    } catch (handlerError) {
      outputError(from, 'processing received message', handlerError);
    }
  }

  /**
   * Start reading (and processing) messages arriving on a channel.
   *
   * @param channel - The channel to read from.
   */
  async function readChannel(channel: Channel): Promise<void> {
    try {
      for (;;) {
        if (signal.aborted) {
          logger.log(`reader abort: ${channel.peerId}`);
          throw new AbortError();
        }
        let readBuf;
        try {
          readBuf = await channel.msgStream.read();
        } catch (problem) {
          if (
            problem instanceof InvalidDataLengthError ||
            problem instanceof InvalidDataLengthLengthError
          ) {
            // Peer announced a payload larger than maxMessageSizeBytes. The
            // length-prefixed framing is now poisoned (subsequent bytes are
            // not on a message boundary), so we cannot continue on this
            // stream. Surface a uniform "message too long" error to match the
            // sender-side validator.
            const sizeError = new ResourceLimitError(
              `Inbound message exceeds size limit: ${problem.message}`,
              {
                cause: problem,
                data: { limitType: 'messageSize' },
              },
            );
            outputError(
              channel.peerId,
              `reading message from ${channel.peerId}`,
              sizeError,
            );
            handleConnectionLoss(channel.peerId);
            logger.log(`closed channel to ${channel.peerId}`);
            throw sizeError;
          }
          if (problem instanceof StreamResetError) {
            // Remote-initiated stream reset: treat as connection loss and
            // reconnect. Do NOT mark as intentionally closed — a malicious
            // peer could otherwise permanently suppress the connection.
            logger.log(
              `${channel.peerId}:: stream reset by remote, reconnecting`,
            );
            handleConnectionLoss(channel.peerId);
          } else if (isIntentionalDisconnect(problem)) {
            // Locally-initiated close (SCTP user abort): honour as intentional.
            logger.log(`${channel.peerId}:: remote intentionally disconnected`);
            peerStateManager.markIntentionallyClosed(channel.peerId);
          } else {
            outputError(
              channel.peerId,
              `reading message from ${channel.peerId}`,
              problem,
            );
            // Only trigger reconnection for non-intentional disconnects
            handleConnectionLoss(channel.peerId);
          }
          logger.log(`closed channel to ${channel.peerId}`);
          throw problem;
        }
        reconnectionManager.resetBackoff(channel.peerId); // successful inbound traffic
        peerStateManager.updateConnectionTime(channel.peerId);
        await receiveMessage(channel.peerId, bufToString(readBuf.subarray()));
      }
    } finally {
      // Always remove the channel when readChannel exits to prevent stale channels
      // This ensures that subsequent sends will establish a new connection
      const state = peerStateManager.getState(channel.peerId);
      if (state.channel === channel) {
        state.channel = undefined;
      }
    }
  }

  // Initialize reconnection lifecycle and bind to the holder
  const reconnectionLifecycle = makeReconnectionLifecycle({
    logger,
    outputError,
    signal,
    peerStateManager,
    reconnectionManager,
    maxRetryAttempts,
    onRemoteGiveUp,
    dialPeer: async (peerId, hints) =>
      connectionFactory.dialIdempotent(peerId, hints, false),
    reuseOrReturnChannel,
    checkConnectionLimit,
    checkConnectionRateLimit: (peerId: string) =>
      connectionRateLimiter.checkAndRecord(peerId, 'connectionRate'),
    closeChannel: async (channel, peerId) =>
      connectionFactory.closeChannel(channel, peerId),
    registerChannel,
    doOutboundHandshake,
  });
  connectionLossHolder.impl = reconnectionLifecycle.handleConnectionLoss;

  /**
   * Send a message string to a peer.
   * The message is already serialized (with seq/ack) by RemoteHandle.
   *
   * @param targetPeerId - The peer ID to send the message to.
   * @param message - The serialized message string.
   * @returns Promise that resolves when the send completes.
   */
  async function sendRemoteMessage(
    targetPeerId: string,
    message: string,
  ): Promise<void> {
    if (signal.aborted) {
      throw new NetworkStoppedError();
    }

    if (peerStateManager.isIntentionallyClosed(targetPeerId)) {
      throw new IntentionalCloseError();
    }

    // Validate message size before sending
    validateMessageSize(message);

    // Check and record message rate limit atomically to prevent TOCTOU race
    // Note: This records before send completes, so failed sends consume quota.
    // This is intentional - recording after send would allow concurrent sends
    // to bypass the rate limit via TOCTOU attacks.
    messageRateLimiter.checkAndRecord(targetPeerId, 'messageRate');

    const state = peerStateManager.getState(targetPeerId);

    // Get or establish channel
    let { channel } = state;
    if (!channel) {
      // Clear permanent failure status - user is explicitly trying to communicate
      // This allows user-initiated messages to "resurrect" a permanently-failed peer
      if (reconnectionManager.isPermanentlyFailed(targetPeerId)) {
        logger.log(
          `${targetPeerId.slice(0, 8)}:: clearing permanent failure status on user-initiated send`,
        );
        reconnectionManager.clearPermanentFailure(targetPeerId);
      }

      // Check connection limit before attempting to dial
      checkConnectionLimit();

      // Check connection attempt rate limit
      connectionRateLimiter.checkAndRecord(targetPeerId, 'connectionRate');

      try {
        const { locationHints: hints } = state;
        channel = await connectionFactory.dialIdempotent(
          targetPeerId,
          hints,
          true,
        );

        // Handle race condition - check if an existing channel appeared
        const resolvedChannel = await reuseOrReturnChannel(
          targetPeerId,
          channel,
        );
        if (!resolvedChannel) {
          // Channel was closed and existing also died - throw to trigger retry
          throw Error('Connection race condition - retry needed');
        }
        channel = resolvedChannel;

        // Re-check connection limit after reuseOrReturnChannel to prevent race conditions
        if (state.channel !== channel) {
          try {
            checkConnectionLimit();
          } catch (error) {
            // Connection limit exceeded after dial - close the channel to prevent leak
            // Use try-catch to ensure the original error is always re-thrown
            try {
              await connectionFactory.closeChannel(channel, targetPeerId);
            } catch {
              // Ignore close errors - the original ResourceLimitError takes priority
            }
            throw error;
          }
          // Perform handshake before registering the channel
          let handshakeResult;
          try {
            handshakeResult = await doOutboundHandshake(channel);
          } catch (handshakeError) {
            // Handshake threw (e.g., onRemoteGiveUp callback failed) - close channel to prevent leak
            try {
              await connectionFactory.closeChannel(channel, targetPeerId);
            } catch {
              // Ignore close errors - the original error takes priority
            }
            throw handshakeError;
          }
          if (!handshakeResult.success) {
            await connectionFactory.closeChannel(channel, targetPeerId);
            throw Error('Handshake failed');
          }
          if (handshakeResult.incarnationChanged) {
            // Peer restarted: close this freshly-dialed channel without
            // registering it. Registering here would let concurrent in-flight
            // sends bypass the handshake check and write pre-restart payloads
            // on the same channel, and anything read from it would be taken as
            // the old incarnation's.
            try {
              await connectionFactory.closeChannel(channel, targetPeerId);
            } catch (closeError) {
              outputError(
                targetPeerId,
                'closing channel after peer restart',
                closeError,
              );
            }
            throw new PeerRestartedError();
          }
          registerChannel(targetPeerId, channel, 'reading channel to');
        }
      } catch (problem) {
        // PeerRestartedError means the handshake succeeded against a
        // reachable peer that just changed incarnations — don't treat that
        // as a connectivity failure. handleConnectionLoss would clear
        // state.channel and could clobber an inbound channel a concurrent
        // handshake just registered.
        if (problem instanceof PeerRestartedError) {
          logger.log(
            `${targetPeerId.slice(0, 8)}:: aborting outbound send: peer restarted`,
          );
        } else {
          outputError(targetPeerId, `opening connection`, problem);
          handleConnectionLoss(targetPeerId);
        }
        throw problem;
      }
    }

    try {
      await writeWithTimeout(
        channel,
        fromString(message),
        writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
      );
      peerStateManager.updateConnectionTime(targetPeerId);
      reconnectionManager.resetBackoff(targetPeerId);
    } catch (problem) {
      outputError(targetPeerId, `sending message`, problem);
      handleConnectionLoss(targetPeerId);
      throw problem;
    }
  }

  /**
   * Handle wake from sleep event.
   */
  function handleWakeFromSleep(): void {
    logger.log('Wake from sleep detected, resetting reconnection backoffs');
    reconnectionManager.resetAllBackoffs();
  }

  /**
   * Close a rejected inbound channel, logging any errors.
   *
   * @param channel - The channel to close.
   */
  function closeRejectedChannel(channel: Channel): void {
    connectionFactory.closeChannel(channel, channel.peerId).catch((problem) => {
      outputError(channel.peerId, 'closing rejected inbound channel', problem);
    });
  }

  /**
   * Handle inbound connection setup including handshake.
   *
   * @param channel - The inbound channel.
   */
  async function handleInboundConnection(channel: Channel): Promise<void> {
    // Reject inbound connections from intentionally closed peers
    if (peerStateManager.isIntentionallyClosed(channel.peerId)) {
      logger.log(
        `${channel.peerId}:: rejecting inbound connection from intentionally closed peer`,
      );
      closeRejectedChannel(channel);
      return;
    }

    // Check connection limit before accepting
    try {
      checkConnectionLimit();
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        logger.log(
          `${channel.peerId}:: rejecting inbound connection due to connection limit`,
        );
        closeRejectedChannel(channel);
        return;
      }
      throw error;
    }

    // Perform handshake before registering the channel. doInboundHandshake
    // returns false on either handshake failure or a detected peer restart;
    // both cases require closing the channel without registration.
    const handshakeOk = await doInboundHandshake(channel);
    if (!handshakeOk) {
      await connectionFactory.closeChannel(channel, channel.peerId);
      return;
    }

    registerChannel(channel.peerId, channel, 'error in inbound channel read');
  }

  // Set up inbound connection handler
  connectionFactory.onInboundConnection((channel) => {
    handleInboundConnection(channel).catch((problem) => {
      outputError(channel.peerId, 'inbound connection setup', problem);
      // Close the channel to prevent resource leak if setup failed
      closeRejectedChannel(channel);
    });
  });

  // Safety net for peer-level disconnects (fires when last connection to a peer closes).
  // Only triggers reconnection if readChannel hasn't already cleaned up.
  // If a channel still exists, readChannel's own error/finally will handle cleanup.
  connectionFactory.onPeerDisconnect((peerId) => {
    if (signal.aborted) {
      return; // shutting down, don't start spurious reconnection
    }
    const state = peerStateManager.getState(peerId);
    if (!state.channel) {
      handleConnectionLoss(peerId);
    }
  });

  // Install wake detector to reset backoff on sleep/wake
  cleanupWakeDetector = installWakeDetector(handleWakeFromSleep);

  // Start periodic cleanup of stale peer data
  cleanupIntervalId = setInterval(() => {
    cleanupStalePeers();
  }, cleanupIntervalMs);

  /**
   * Explicitly close a connection to a peer.
   * Marks the peer as intentionally closed to prevent automatic reconnection.
   *
   * @param peerId - The peer ID to close the connection for.
   */
  async function closeConnection(peerId: string): Promise<void> {
    logger.log(`${peerId}:: explicitly closing connection`);
    peerStateManager.markIntentionallyClosed(peerId);
    const state = peerStateManager.getState(peerId);
    // Remove channel - the readChannel cleanup will handle stream closure
    state.channel = undefined;
    if (reconnectionManager.isReconnecting(peerId)) {
      reconnectionManager.stopReconnection(peerId);
    }
  }

  /**
   * Take note of where a peer might be.
   *
   * @param peerId - The peer ID to which this information applies.
   * @param hints - Location hints for the peer.
   */
  function registerLocationHints(peerId: string, hints: string[]): void {
    peerStateManager.addLocationHints(peerId, hints);
  }

  /**
   * Manually reconnect to a peer after intentional close or permanent failure.
   * Clears the intentional close flag and permanent failure status,
   * then initiates reconnection.
   *
   * @param peerId - The peer ID to reconnect to.
   * @param hints - The hints to use for the reconnection.
   */
  async function reconnectPeer(
    peerId: string,
    hints: string[] = [],
  ): Promise<void> {
    logger.log(`${peerId}:: manually reconnecting`);
    peerStateManager.clearIntentionallyClosed(peerId);
    // If already reconnecting, don't start another attempt and don't clear error history
    // Clearing error history while reconnection is in progress would reset progress
    // toward permanent failure detection
    if (reconnectionManager.isReconnecting(peerId)) {
      return;
    }
    // Clear permanent failure status - user explicitly wants to reconnect
    // Only clear when not already reconnecting to preserve error tracking during active attempts
    reconnectionManager.clearPermanentFailure(peerId);
    registerLocationHints(peerId, hints);
    handleConnectionLoss(peerId);
  }

  /**
   * Stop the network.
   */
  async function stop(): Promise<void> {
    logger.log('Stopping kernel network...');
    // Stop wake detector
    if (cleanupWakeDetector) {
      cleanupWakeDetector();
      cleanupWakeDetector = undefined;
    }
    // Stop cleanup interval
    if (cleanupIntervalId) {
      clearInterval(cleanupIntervalId);
      cleanupIntervalId = undefined;
    }
    stopController.abort(); // cancels all delays and dials
    // Gracefully close all active channel streams to unblock pending reads.
    // Fire-and-forget: close() sends a FIN so the remote sees a clean stream
    // end (read returns undefined) rather than a reset (StreamResetError).
    for (const state of peerStateManager.getAllStates()) {
      const { channel } = state;
      if (channel) {
        channel.stream.close().catch((closeError) => {
          outputError(channel.peerId, 'closing stream during stop', closeError);
        });
        state.channel = undefined;
      }
    }
    await connectionFactory.stop();
    peerStateManager.clear();
    reconnectionManager.clear();
    messageRateLimiter.clear();
    connectionRateLimiter.clear();
  }

  /**
   * Reset all reconnection backoffs.
   * Called when a cross-incarnation wake is detected to avoid unnecessary delays.
   */
  function resetAllBackoffs(): void {
    logger.log('Resetting all reconnection backoffs');
    reconnectionManager.resetAllBackoffs();
  }

  // Return the sender with a stop handle and connection management functions
  return {
    sendRemoteMessage,
    stop,
    closeConnection,
    registerLocationHints,
    reconnectPeer,
    resetAllBackoffs,
    getListenAddresses: () => connectionFactory.getListenAddresses(),
  };
}
