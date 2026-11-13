import {
  isRetryableNetworkError,
  getNetworkErrorCode,
  isResourceLimitError,
} from '@metamask/kernel-errors';
import {
  abortableDelay,
  DEFAULT_MAX_RETRY_ATTEMPTS,
} from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';

import type { ErrorLogger } from './channel-utils.ts';
import type { PeerStateManager, PeerState } from './peer-state-manager.ts';
import type { ReconnectionManager } from './reconnection.ts';
import type {
  Channel,
  OnRemoteGiveUp,
  OutboundHandshakeResult,
} from '../types.ts';

/**
 * Dependencies for creating a reconnection lifecycle handler.
 */
export type ReconnectionLifecycleDeps = {
  logger: Logger;
  outputError: ErrorLogger;
  signal: AbortSignal;
  peerStateManager: PeerStateManager;
  reconnectionManager: ReconnectionManager;
  maxRetryAttempts: number | undefined;
  onRemoteGiveUp: OnRemoteGiveUp | undefined;
  dialPeer: (peerId: string, hints: string[]) => Promise<Channel>;
  reuseOrReturnChannel: (
    peerId: string,
    dialedChannel: Channel,
  ) => Promise<Channel | null>;
  checkConnectionLimit: () => void;
  checkConnectionRateLimit: (peerId: string) => void;
  closeChannel: (channel: Channel, peerId: string) => Promise<void>;
  registerChannel: (
    peerId: string,
    channel: Channel,
    errorContext?: string,
  ) => void;
  /** Perform outbound handshake. */
  doOutboundHandshake: (channel: Channel) => Promise<OutboundHandshakeResult>;
};

/**
 * Result of creating a reconnection lifecycle handler.
 */
export type ReconnectionLifecycle = {
  handleConnectionLoss: (peerId: string) => void;
  attemptReconnection: (peerId: string, maxAttempts?: number) => Promise<void>;
};

/**
 * Creates a reconnection lifecycle handler for managing connection loss and reconnection attempts.
 *
 * @param deps - Dependencies for the reconnection lifecycle.
 * @returns Functions for handling connection loss and reconnection.
 */
export function makeReconnectionLifecycle(
  deps: ReconnectionLifecycleDeps,
): ReconnectionLifecycle {
  const {
    logger,
    outputError,
    signal,
    peerStateManager,
    reconnectionManager,
    maxRetryAttempts,
    onRemoteGiveUp,
    dialPeer,
    reuseOrReturnChannel,
    checkConnectionLimit,
    checkConnectionRateLimit,
    closeChannel,
    registerChannel,
    doOutboundHandshake,
  } = deps;

  /**
   * Attempt to reconnect to a peer after connection loss.
   * Single orchestration loop per peer; abortable.
   *
   * @param peerId - The peer ID to reconnect to.
   * @param maxAttempts - The maximum number of reconnection attempts. 0 = infinite.
   */
  async function attemptReconnection(
    peerId: string,
    maxAttempts = maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS,
  ): Promise<void> {
    const state = peerStateManager.getState(peerId);
    let budget = maxAttempts;
    let restartedAs: string | undefined;

    while (reconnectionManager.isReconnecting(peerId) && !signal.aborted) {
      // Check for permanent failure before attempting
      if (reconnectionManager.isPermanentlyFailed(peerId)) {
        logger.log(
          `${peerId}:: permanently failed due to error pattern, giving up`,
        );
        reconnectionManager.stopReconnection(peerId);
        onRemoteGiveUp?.(peerId);
        return;
      }

      if (!reconnectionManager.shouldRetry(peerId, budget)) {
        logger.log(
          `${peerId}:: max reconnection attempts (${maxAttempts}, ${budget} counting repeated restarts) reached, giving up`,
        );
        reconnectionManager.stopReconnection(peerId);
        onRemoteGiveUp?.(peerId);
        return;
      }

      const nextAttempt = reconnectionManager.incrementAttempt(peerId);
      const delayMs = reconnectionManager.calculateBackoff(peerId);
      logger.log(
        `${peerId}:: scheduling reconnection attempt ${nextAttempt}${budget ? `/${budget}` : ''} in ${delayMs}ms`,
      );

      try {
        await abortableDelay(delayMs, signal);
      } catch (error) {
        if (signal.aborted) {
          reconnectionManager.stopReconnection(peerId);
          return;
        }
        throw error;
      }

      logger.log(
        `${peerId}:: reconnection attempt ${nextAttempt}${budget ? `/${budget}` : ''}`,
      );

      try {
        const result = await tryReconnect(state, peerId);
        if (result !== null && 'restartedAs' in result) {
          if (restartedAs === undefined) {
            // The peer answered, so its first restart in a run resets the
            // backoff.
            reconnectionManager.resetBackoff(peerId);
          } else if (
            result.restartedAs === restartedAs &&
            budget < 2 * maxAttempts
          ) {
            // The kernel reports a restart until its crank records it, so the
            // same incarnation again spends no attempt, though its backoff
            // still grows, until the budget has doubled.
            budget += 1;
          }
          restartedAs = result.restartedAs;
          continue;
        }
        if (!result) {
          // Channel was closed and existing also died - continue retry loop
          continue;
        }

        logger.log(`${peerId}:: reconnection successful`);
        reconnectionManager.resetBackoff(peerId);
        reconnectionManager.stopReconnection(peerId);
        return; // success
      } catch (problem) {
        if (signal.aborted) {
          reconnectionManager.stopReconnection(peerId);
          return;
        }
        // Handle rate limit errors (connectionRate) - these are temporary and
        // occur before any dial was performed, so don't count against retry quota
        if (isResourceLimitError(problem, 'connectionRate')) {
          reconnectionManager.decrementAttempt(peerId);
          logger.log(
            `${peerId}:: reconnection attempt ${nextAttempt} rate limited, will retry after backoff`,
          );
          continue;
        }
        // Connection limit errors (limitType: 'connection') occur after dial -
        // the attempt counts and channel cleanup is handled in tryReconnect
        if (isResourceLimitError(problem, 'connection')) {
          logger.log(
            `${peerId}:: reconnection attempt ${nextAttempt} hit connection limit, will retry after backoff`,
          );
          continue;
        }

        // Check if retryable BEFORE recording - non-retryable errors should not
        // contribute to permanent failure detection (they cause immediate give-up)
        if (!isRetryableNetworkError(problem)) {
          outputError(peerId, `non-retryable failure`, problem);
          reconnectionManager.stopReconnection(peerId);
          onRemoteGiveUp?.(peerId);
          return;
        }

        // Record the error for pattern analysis (only retryable errors reach here)
        const errorCode = getNetworkErrorCode(problem);
        reconnectionManager.recordError(peerId, errorCode);

        // Check if this error triggered permanent failure
        if (reconnectionManager.isPermanentlyFailed(peerId)) {
          outputError(
            peerId,
            `permanent failure detected (${errorCode})`,
            problem,
          );
          reconnectionManager.stopReconnection(peerId);
          onRemoteGiveUp?.(peerId);
          return;
        }

        outputError(peerId, `reconnection attempt ${nextAttempt}`, problem);
        // loop to next attempt
      }
    }
    // Loop exited - clean up reconnection state
    if (reconnectionManager.isReconnecting(peerId)) {
      reconnectionManager.stopReconnection(peerId);
    }
  }

  /**
   * Try to reconnect to a peer.
   *
   * @param state - The peer state.
   * @param peerId - The peer ID.
   * @returns The channel if successful, `{ restartedAs }` with the incarnation
   * the peer reported if it restarted, null if should retry.
   */
  async function tryReconnect(
    state: PeerState,
    peerId: string,
  ): Promise<Channel | { restartedAs: string } | null> {
    // Check connection rate limit before attempting dial
    checkConnectionRateLimit(peerId);

    const { locationHints: hints } = state;
    const dialedChannel = await dialPeer(peerId, hints);

    // Handle race condition - check if an existing channel appeared
    const channel = await reuseOrReturnChannel(peerId, dialedChannel);
    if (!channel) {
      return null;
    }

    // Re-check connection limit and register if this is a new channel
    if (state.channel !== channel) {
      try {
        checkConnectionLimit();
      } catch (error) {
        // Connection limit exceeded after dial - close the channel to prevent leak
        // Use try-catch to ensure the original error is always re-thrown
        try {
          await closeChannel(channel, peerId);
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
          await closeChannel(channel, peerId);
        } catch {
          // Ignore close errors - the original error takes priority
        }
        throw handshakeError;
      }
      if (!handshakeResult.success) {
        // Handshake failures are retryable (could be transient network issues)
        // Return null to signal retry instead of throwing non-retryable error
        logger.log(
          `${peerId}:: handshake failed during reconnection, will retry`,
        );
        await closeChannel(channel, peerId);
        return null;
      }
      if (handshakeResult.incarnationChanged) {
        logger.log(
          `${peerId}:: peer restarted during reconnection, re-dialing`,
        );
        await closeChannel(channel, peerId);
        return { restartedAs: handshakeResult.remoteIncarnationId };
      }
      registerChannel(peerId, channel, 'reading channel to');
    }

    return channel;
  }

  /**
   * Handle connection loss for a given peer ID.
   * Skips reconnection if the peer was intentionally closed or permanently failed.
   *
   * @param peerId - The peer ID to handle the connection loss for.
   */
  function handleConnectionLoss(peerId: string): void {
    // Don't reconnect if this peer intentionally closed the connection
    if (peerStateManager.isIntentionallyClosed(peerId)) {
      logger.log(
        `${peerId}:: connection lost but peer intentionally closed, skipping reconnection`,
      );
      return;
    }
    logger.log(`${peerId}:: connection lost, initiating reconnection`);
    const state = peerStateManager.getState(peerId);
    state.channel = undefined;

    if (!reconnectionManager.isReconnecting(peerId)) {
      const started = reconnectionManager.startReconnection(peerId);
      if (!started) {
        // Peer is permanently failed, don't attempt reconnection
        logger.log(
          `${peerId}:: peer is permanently failed, skipping reconnection`,
        );
        onRemoteGiveUp?.(peerId);
        return;
      }
      attemptReconnection(peerId).catch((problem) => {
        outputError(peerId, 'reconnection error', problem);
        reconnectionManager.stopReconnection(peerId);
      });
    }
  }

  return { handleConnectionLoss, attemptReconnection };
}
