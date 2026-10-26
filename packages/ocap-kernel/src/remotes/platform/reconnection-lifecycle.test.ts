import * as kernelErrors from '@metamask/kernel-errors';
import * as kernelUtils from '@metamask/kernel-utils';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { makeReconnectionLifecycle } from './reconnection-lifecycle.ts';
import type { ReconnectionLifecycleDeps } from './reconnection-lifecycle.ts';
import { ReconnectionManager } from './reconnection.ts';
import type { Channel } from '../types.ts';

// Mock kernel-utils for abortableDelay
vi.mock('@metamask/kernel-utils', async () => {
  const actual = await vi.importActual<typeof kernelUtils>(
    '@metamask/kernel-utils',
  );
  return {
    ...actual,
    abortableDelay: vi.fn(),
  };
});

// Mock kernel-errors for isRetryableNetworkError and getNetworkErrorCode
vi.mock('@metamask/kernel-errors', async () => {
  const actual = await vi.importActual<typeof kernelErrors>(
    '@metamask/kernel-errors',
  );
  return {
    ...actual,
    isRetryableNetworkError: vi.fn(),
    getNetworkErrorCode: vi.fn().mockReturnValue('ECONNREFUSED'),
  };
});

// Helper to flush pending promises/microtasks
const flushPromises = async (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('reconnection-lifecycle', () => {
  let deps: ReconnectionLifecycleDeps;
  let abortController: AbortController;
  let mockChannel: Channel;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up default mock behaviors
    (kernelUtils.abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    (
      kernelErrors.isRetryableNetworkError as ReturnType<typeof vi.fn>
    ).mockReturnValue(true);

    abortController = new AbortController();
    mockChannel = {
      peerId: 'testPeer',
      msgStream: {
        write: vi.fn(),
        read: vi.fn(),
        unwrap: vi.fn(),
      },
    } as unknown as Channel;

    deps = {
      logger: { log: vi.fn() },
      outputError: vi.fn(),
      signal: abortController.signal,
      peerStateManager: {
        getState: vi.fn().mockReturnValue({
          channel: undefined,
          locationHints: ['hint1'],
        }),
        isIntentionallyClosed: vi.fn().mockReturnValue(false),
      },
      reconnectionManager: {
        isReconnecting: vi.fn().mockReturnValue(true),
        shouldRetry: vi.fn().mockReturnValue(true),
        incrementAttempt: vi.fn().mockReturnValue(1),
        decrementAttempt: vi.fn(),
        calculateBackoff: vi.fn().mockReturnValue(100),
        startReconnection: vi.fn().mockReturnValue(true),
        stopReconnection: vi.fn(),
        resetBackoff: vi.fn(),
        isPermanentlyFailed: vi.fn().mockReturnValue(false),
        recordError: vi.fn(),
      },
      maxRetryAttempts: 3,
      onRemoteGiveUp: vi.fn(),
      dialPeer: vi.fn().mockResolvedValue(mockChannel),
      reuseOrReturnChannel: vi.fn().mockResolvedValue(mockChannel),
      checkConnectionLimit: vi.fn(),
      checkConnectionRateLimit: vi.fn(),
      closeChannel: vi.fn().mockResolvedValue(undefined),
      registerChannel: vi.fn(),
      doOutboundHandshake: vi
        .fn()
        .mockResolvedValue({ success: true, incarnationChanged: false }),
    } as unknown as ReconnectionLifecycleDeps;
  });

  describe('makeReconnectionLifecycle', () => {
    it('returns handleConnectionLoss and attemptReconnection functions', () => {
      const lifecycle = makeReconnectionLifecycle(deps);

      expect(typeof lifecycle.handleConnectionLoss).toBe('function');
      expect(typeof lifecycle.attemptReconnection).toBe('function');
    });
  });

  describe('handleConnectionLoss', () => {
    it('skips reconnection for intentionally closed peers', () => {
      (
        deps.peerStateManager.isIntentionallyClosed as ReturnType<typeof vi.fn>
      ).mockReturnValue(true);
      const lifecycle = makeReconnectionLifecycle(deps);

      lifecycle.handleConnectionLoss('peer1');

      expect(deps.reconnectionManager.startReconnection).not.toHaveBeenCalled();
      expect(deps.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('intentionally closed'),
      );
    });

    it('clears channel on connection loss', () => {
      const state = { channel: mockChannel, locationHints: [] };
      (
        deps.peerStateManager.getState as ReturnType<typeof vi.fn>
      ).mockReturnValue(state);
      const lifecycle = makeReconnectionLifecycle(deps);

      lifecycle.handleConnectionLoss('peer1');

      expect(state.channel).toBeUndefined();
    });

    it('starts reconnection if not already reconnecting', async () => {
      (
        deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);
      const lifecycle = makeReconnectionLifecycle(deps);

      lifecycle.handleConnectionLoss('peer1');
      await flushPromises();

      expect(deps.reconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer1',
      );
    });

    it('does not start reconnection if already reconnecting', () => {
      (
        deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>
      ).mockReturnValue(true);
      const lifecycle = makeReconnectionLifecycle(deps);

      lifecycle.handleConnectionLoss('peer1');

      expect(deps.reconnectionManager.startReconnection).not.toHaveBeenCalled();
    });

    it('logs connection loss message', async () => {
      (
        deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);
      const lifecycle = makeReconnectionLifecycle(deps);

      lifecycle.handleConnectionLoss('peer1');
      await flushPromises();

      expect(deps.logger.log).toHaveBeenCalledWith(
        'peer1:: connection lost, initiating reconnection',
      );
    });
  });

  describe('attemptReconnection', () => {
    it('stops when max attempts reached', async () => {
      (
        deps.reconnectionManager.shouldRetry as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);
      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.reconnectionManager.stopReconnection).toHaveBeenCalledWith(
        'peer1',
      );
      expect(deps.onRemoteGiveUp).toHaveBeenCalledWith('peer1');
    });

    it('dials peer with location hints', async () => {
      // Make it succeed on first attempt
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.dialPeer).toHaveBeenCalledWith('peer1', ['hint1']);
    });

    it('registers channel on successful reconnection', async () => {
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.registerChannel).toHaveBeenCalledWith(
        'peer1',
        mockChannel,
        'reading channel to',
      );
    });

    it('performs handshake before registering channel', async () => {
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.doOutboundHandshake).toHaveBeenCalledWith(mockChannel);
      // Verify handshake is called before registerChannel
      const handshakeCallOrder = (
        deps.doOutboundHandshake as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0];
      const registerCallOrder = (
        deps.registerChannel as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0];
      expect(handshakeCallOrder).toBeLessThan(registerCallOrder as number);
    });

    it('closes channel and retries when handshake fails', async () => {
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
      (deps.doOutboundHandshake as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        incarnationChanged: false,
      });

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      // Handshake failure should close the channel and log, not throw
      expect(deps.closeChannel).toHaveBeenCalledWith(mockChannel, 'peer1');
      expect(deps.registerChannel).not.toHaveBeenCalled();
      expect(deps.logger.log).toHaveBeenCalledWith(
        'peer1:: handshake failed during reconnection, will retry',
      );
      // Should NOT call outputError or onRemoteGiveUp since handshake failures are retryable
      expect(deps.outputError).not.toHaveBeenCalledWith(
        'peer1',
        expect.stringContaining('non-retryable'),
        expect.any(Error),
      );
    });

    it('closes channel and re-dials when the handshake reports a restart', async () => {
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
      (deps.doOutboundHandshake as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          success: true,
          incarnationChanged: true,
          remoteIncarnationId: 'incarnation-B',
        })
        .mockResolvedValueOnce({ success: true, incarnationChanged: false });

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.closeChannel).toHaveBeenCalledTimes(1);
      expect(deps.closeChannel).toHaveBeenCalledWith(mockChannel, 'peer1');
      expect(deps.dialPeer).toHaveBeenCalledTimes(2);
      expect(deps.registerChannel).toHaveBeenCalledTimes(1);
      // Once for the restart, once on success.
      expect(deps.reconnectionManager.resetBackoff).toHaveBeenCalledTimes(2);
    });

    it('reconnects to a peer that restarts on the last attempt', async () => {
      const reconnectionManager = new ReconnectionManager();
      reconnectionManager.startReconnection('peer1');
      deps.reconnectionManager = reconnectionManager;
      const attemptsAtDial: number[] = [];
      vi.spyOn(deps, 'dialPeer').mockImplementation(async () => {
        attemptsAtDial.push(reconnectionManager.getAttemptCount('peer1'));
        if (attemptsAtDial.length <= 2) {
          throw new Error('Connection failed');
        }
        return mockChannel;
      });
      (
        deps.doOutboundHandshake as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce({
        success: true,
        incarnationChanged: true,
        remoteIncarnationId: 'incarnation-B',
      });

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(attemptsAtDial).toStrictEqual([1, 2, 3, 1]);
      expect(deps.registerChannel).toHaveBeenCalledTimes(1);
      expect(deps.onRemoteGiveUp).not.toHaveBeenCalled();
    });

    it('gives up on a peer that reports a restart on every handshake', async () => {
      const reconnectionManager = new ReconnectionManager();
      reconnectionManager.startReconnection('peer1');
      deps.reconnectionManager = reconnectionManager;
      let incarnation = 0;
      vi.spyOn(deps, 'doOutboundHandshake').mockImplementation(async () => {
        incarnation += 1;
        return {
          success: true,
          incarnationChanged: true,
          remoteIncarnationId: `incarnation-${incarnation}`,
        };
      });
      const attemptsAtDial: number[] = [];
      vi.spyOn(deps, 'dialPeer').mockImplementation(async () => {
        attemptsAtDial.push(reconnectionManager.getAttemptCount('peer1'));
        // Bounds the loop if the budget never runs out.
        if (attemptsAtDial.length >= 10) {
          abortController.abort();
        }
        return mockChannel;
      });

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.onRemoteGiveUp).toHaveBeenCalledWith('peer1');
      expect(attemptsAtDial).toStrictEqual([1, 1, 2, 3]);
    });

    it('spends no attempt on a restart reported again before the kernel records it', async () => {
      const reconnectionManager = new ReconnectionManager();
      reconnectionManager.startReconnection('peer1');
      deps.reconnectionManager = reconnectionManager;
      const restart = {
        success: true,
        incarnationChanged: true,
        remoteIncarnationId: 'incarnation-B',
      };
      (deps.doOutboundHandshake as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(restart)
        .mockResolvedValueOnce(restart)
        .mockResolvedValueOnce(restart)
        .mockResolvedValueOnce(restart)
        .mockResolvedValueOnce(restart);
      const attemptsAtDial: number[] = [];
      vi.spyOn(deps, 'dialPeer').mockImplementation(async () => {
        attemptsAtDial.push(reconnectionManager.getAttemptCount('peer1'));
        return mockChannel;
      });

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(attemptsAtDial).toStrictEqual([1, 1, 2, 3, 4, 5]);
      expect(deps.registerChannel).toHaveBeenCalledTimes(1);
      expect(deps.onRemoteGiveUp).not.toHaveBeenCalled();
    });

    it.each([
      { maxAttempts: 3, dials: [1, 1, 2, 3, 4, 5, 6], gaveUp: true },
      { maxAttempts: 0, dials: [1, 1, 2, 3, 4, 5, 6, 7, 8, 9], gaveUp: false },
    ])(
      'gives back no more attempts than a budget of $maxAttempts to a restart the kernel never records',
      async ({ maxAttempts, dials, gaveUp }) => {
        const reconnectionManager = new ReconnectionManager();
        reconnectionManager.startReconnection('peer1');
        deps.reconnectionManager = reconnectionManager;
        (
          deps.doOutboundHandshake as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          success: true,
          incarnationChanged: true,
          remoteIncarnationId: 'incarnation-B',
        });
        const attemptsAtDial: number[] = [];
        vi.spyOn(deps, 'dialPeer').mockImplementation(async () => {
          attemptsAtDial.push(reconnectionManager.getAttemptCount('peer1'));
          if (attemptsAtDial.length === 10) {
            reconnectionManager.stopReconnection('peer1');
          }
          return mockChannel;
        });

        const lifecycle = makeReconnectionLifecycle(deps);

        await lifecycle.attemptReconnection('peer1', maxAttempts);

        expect({
          dials: attemptsAtDial,
          gaveUp:
            (deps.onRemoteGiveUp as ReturnType<typeof vi.fn>).mock.calls
              .length > 0,
        }).toStrictEqual({ dials, gaveUp });
      },
    );

    it('gives back attempts to the latest restart a peer reports', async () => {
      const reconnectionManager = new ReconnectionManager();
      reconnectionManager.startReconnection('peer1');
      deps.reconnectionManager = reconnectionManager;
      let handshakes = 0;
      vi.spyOn(deps, 'doOutboundHandshake').mockImplementation(async () => {
        handshakes += 1;
        return {
          success: true,
          incarnationChanged: true,
          remoteIncarnationId:
            handshakes === 1 ? 'incarnation-B' : 'incarnation-C',
        };
      });
      const attemptsAtDial: number[] = [];
      vi.spyOn(deps, 'dialPeer').mockImplementation(async () => {
        attemptsAtDial.push(reconnectionManager.getAttemptCount('peer1'));
        return mockChannel;
      });

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1', 3);

      expect(attemptsAtDial).toStrictEqual([1, 1, 2, 3, 4, 5, 6]);
    });

    it('resets backoff on successful reconnection', async () => {
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.reconnectionManager.resetBackoff).toHaveBeenCalledWith(
        'peer1',
      );
      expect(deps.reconnectionManager.stopReconnection).toHaveBeenCalledWith(
        'peer1',
      );
    });

    it('stops when signal is aborted during delay', async () => {
      (
        kernelUtils.abortableDelay as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('Aborted'));
      abortController.abort();

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.reconnectionManager.stopReconnection).toHaveBeenCalledWith(
        'peer1',
      );
    });

    it('stops when signal is aborted during dial', async () => {
      (deps.dialPeer as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection failed'),
      );
      abortController.abort();

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.reconnectionManager.stopReconnection).toHaveBeenCalled();
    });

    it('gives up on non-retryable errors', async () => {
      (deps.dialPeer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Auth failed'),
      );
      (
        kernelErrors.isRetryableNetworkError as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.reconnectionManager.stopReconnection).toHaveBeenCalledWith(
        'peer1',
      );
      expect(deps.onRemoteGiveUp).toHaveBeenCalledWith('peer1');
      expect(deps.outputError).toHaveBeenCalledWith(
        'peer1',
        'non-retryable failure',
        expect.any(Error),
      );
    });

    it('retries on retryable errors', async () => {
      (deps.dialPeer as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValueOnce(mockChannel);

      (
        kernelErrors.isRetryableNetworkError as ReturnType<typeof vi.fn>
      ).mockReturnValue(true);
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true) // First attempt check
        .mockReturnValueOnce(true) // Second attempt check
        .mockReturnValueOnce(false); // Exit loop

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.dialPeer).toHaveBeenCalledTimes(2);
    });

    it('continues retry loop when reuseOrReturnChannel returns null', async () => {
      (deps.reuseOrReturnChannel as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockChannel);

      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true) // First attempt
        .mockReturnValueOnce(true) // After null channel
        .mockReturnValueOnce(false); // After success

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.reuseOrReturnChannel).toHaveBeenCalledTimes(2);
    });

    it('checks connection limit before registering', async () => {
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.checkConnectionLimit).toHaveBeenCalledTimes(1);
    });

    it('checks connection rate limit before dialing', async () => {
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.checkConnectionRateLimit).toHaveBeenCalledTimes(1);
      expect(deps.checkConnectionRateLimit).toHaveBeenCalledWith('peer1');
    });

    it('continues loop on ResourceLimitError instead of giving up', async () => {
      const { ResourceLimitError } = kernelErrors;
      (
        deps.checkConnectionRateLimit as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(() => {
        throw new ResourceLimitError('Rate limit exceeded', {
          data: { limitType: 'connectionRate', current: 10, limit: 10 },
        });
      });

      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true) // First attempt - rate limited
        .mockReturnValueOnce(true) // Second attempt - success
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      // Should not call onRemoteGiveUp because rate limit is retryable
      expect(deps.onRemoteGiveUp).not.toHaveBeenCalled();
      // Should have tried twice (once rate limited, once successful)
      expect(deps.reconnectionManager.incrementAttempt).toHaveBeenCalledTimes(
        2,
      );
      expect(deps.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('rate limited'),
      );
    });

    it('decrements attempt count when rate limited to preserve retry quota', async () => {
      const { ResourceLimitError } = kernelErrors;
      (
        deps.checkConnectionRateLimit as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(() => {
        throw new ResourceLimitError('Rate limit exceeded', {
          data: { limitType: 'connectionRate', current: 10, limit: 10 },
        });
      });

      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true) // First attempt - rate limited
        .mockReturnValueOnce(true) // Second attempt - success
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      // Should have decremented attempt count when rate limited
      // so that rate-limited attempts don't consume retry quota
      expect(deps.reconnectionManager.decrementAttempt).toHaveBeenCalledWith(
        'peer1',
      );
      expect(deps.reconnectionManager.decrementAttempt).toHaveBeenCalledTimes(
        1,
      );
    });

    it('does not decrement attempt count for connection limit errors', async () => {
      const { ResourceLimitError } = kernelErrors;
      (
        deps.checkConnectionLimit as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(() => {
        throw new ResourceLimitError('Connection limit exceeded', {
          data: { limitType: 'connection', current: 100, limit: 100 },
        });
      });

      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true) // First attempt - connection limit
        .mockReturnValueOnce(true) // Second attempt - success
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      // Should NOT decrement attempt count because dial was performed
      expect(deps.reconnectionManager.decrementAttempt).not.toHaveBeenCalled();
    });

    it('retries connection limit errors without calling isRetryableNetworkError', async () => {
      const { ResourceLimitError } = kernelErrors;
      // Mock isRetryableNetworkError to return false - connection limit errors
      // should be retried regardless via explicit handling
      (
        kernelErrors.isRetryableNetworkError as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);

      (
        deps.checkConnectionLimit as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(() => {
        throw new ResourceLimitError('Connection limit exceeded', {
          data: { limitType: 'connection', current: 100, limit: 100 },
        });
      });

      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true) // First attempt - connection limit
        .mockReturnValueOnce(true) // Second attempt - success
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      // Should NOT call onRemoteGiveUp - connection limit errors are retryable
      expect(deps.onRemoteGiveUp).not.toHaveBeenCalled();
      // Should have retried and succeeded
      expect(deps.reconnectionManager.resetBackoff).toHaveBeenCalledWith(
        'peer1',
      );
      expect(deps.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('hit connection limit'),
      );
    });

    it('closes channel when connection limit is exceeded after dial', async () => {
      const { ResourceLimitError } = kernelErrors;
      (
        deps.checkConnectionLimit as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(() => {
        throw new ResourceLimitError('Connection limit exceeded', {
          data: { limitType: 'connection', current: 100, limit: 100 },
        });
      });

      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true) // First attempt - connection limit
        .mockReturnValueOnce(true) // Second attempt - success
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      // Should close the channel to prevent resource leak
      expect(deps.closeChannel).toHaveBeenCalledWith(mockChannel, 'peer1');
    });

    it('propagates ResourceLimitError even when closeChannel fails', async () => {
      const { ResourceLimitError } = kernelErrors;
      // Mock isRetryableNetworkError to return false - we want to verify the
      // ResourceLimitError is still correctly identified
      (
        kernelErrors.isRetryableNetworkError as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);

      (
        deps.checkConnectionLimit as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(() => {
        throw new ResourceLimitError('Connection limit exceeded', {
          data: { limitType: 'connection', current: 100, limit: 100 },
        });
      });

      // closeChannel throws an error
      (deps.closeChannel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Channel already closed'),
      );

      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true) // First attempt - connection limit + close error
        .mockReturnValueOnce(true) // Second attempt - success
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      // Should NOT call onRemoteGiveUp - the original ResourceLimitError should
      // be preserved even though closeChannel failed
      expect(deps.onRemoteGiveUp).not.toHaveBeenCalled();
      // Should have retried and succeeded
      expect(deps.reconnectionManager.resetBackoff).toHaveBeenCalledWith(
        'peer1',
      );
    });

    it('logs reconnection attempts', async () => {
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      expect(deps.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('scheduling reconnection attempt'),
      );
      expect(deps.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('reconnection successful'),
      );
    });

    it('uses default max retry attempts when not specified', async () => {
      deps.maxRetryAttempts = undefined;
      (
        deps.reconnectionManager.shouldRetry as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      // Should use DEFAULT_MAX_RETRY_ATTEMPTS (0 = infinite)
      expect(deps.reconnectionManager.shouldRetry).toHaveBeenCalledWith(
        'peer1',
        0,
      );
    });

    it('cleans up reconnection state when loop exits naturally', async () => {
      (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      await lifecycle.attemptReconnection('peer1');

      // stopReconnection should be called on success
      expect(deps.reconnectionManager.stopReconnection).toHaveBeenCalled();
    });

    describe('permanent failure detection', () => {
      it('gives up when peer is permanently failed at start of loop', async () => {
        (
          deps.reconnectionManager.isPermanentlyFailed as ReturnType<
            typeof vi.fn
          >
        ).mockReturnValue(true);

        const lifecycle = makeReconnectionLifecycle(deps);

        await lifecycle.attemptReconnection('peer1');

        expect(deps.reconnectionManager.stopReconnection).toHaveBeenCalledWith(
          'peer1',
        );
        expect(deps.onRemoteGiveUp).toHaveBeenCalledWith('peer1');
        expect(deps.logger.log).toHaveBeenCalledWith(
          expect.stringContaining('permanently failed'),
        );
      });

      it('records error after failed dial attempt', async () => {
        const error = new Error('Connection refused');
        (error as Error & { code: string }).code = 'ECONNREFUSED';
        (deps.dialPeer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
          error,
        );
        (
          kernelErrors.isRetryableNetworkError as ReturnType<typeof vi.fn>
        ).mockReturnValue(true);
        (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
          .mockReturnValueOnce(true)
          .mockReturnValueOnce(false);

        const lifecycle = makeReconnectionLifecycle(deps);

        await lifecycle.attemptReconnection('peer1');

        expect(deps.reconnectionManager.recordError).toHaveBeenCalledWith(
          'peer1',
          'ECONNREFUSED',
        );
      });

      it('gives up when error triggers permanent failure', async () => {
        const error = new Error('Connection refused');
        (deps.dialPeer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
          error,
        );
        (
          kernelErrors.isRetryableNetworkError as ReturnType<typeof vi.fn>
        ).mockReturnValue(true);
        (
          deps.reconnectionManager.isPermanentlyFailed as ReturnType<
            typeof vi.fn
          >
        )
          .mockReturnValueOnce(false) // At start of loop
          .mockReturnValueOnce(true); // After recording error

        const lifecycle = makeReconnectionLifecycle(deps);

        await lifecycle.attemptReconnection('peer1');

        expect(deps.reconnectionManager.stopReconnection).toHaveBeenCalledWith(
          'peer1',
        );
        expect(deps.onRemoteGiveUp).toHaveBeenCalledWith('peer1');
        expect(deps.outputError).toHaveBeenCalledWith(
          'peer1',
          expect.stringContaining('permanent failure detected'),
          expect.any(Error),
        );
      });

      it('continues retrying when error does not trigger permanent failure', async () => {
        (deps.dialPeer as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(new Error('Temporary failure'))
          .mockResolvedValueOnce(mockChannel);
        (
          kernelErrors.isRetryableNetworkError as ReturnType<typeof vi.fn>
        ).mockReturnValue(true);
        (
          deps.reconnectionManager.isPermanentlyFailed as ReturnType<
            typeof vi.fn
          >
        ).mockReturnValue(false);
        (deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>)
          .mockReturnValueOnce(true)
          .mockReturnValueOnce(true)
          .mockReturnValueOnce(false);

        const lifecycle = makeReconnectionLifecycle(deps);

        await lifecycle.attemptReconnection('peer1');

        expect(deps.dialPeer).toHaveBeenCalledTimes(2);
        expect(deps.reconnectionManager.recordError).toHaveBeenCalled();
      });

      it('does not record non-retryable errors in history', async () => {
        const error = new Error('Auth failed');
        (deps.dialPeer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
          error,
        );
        // Non-retryable error
        (
          kernelErrors.isRetryableNetworkError as ReturnType<typeof vi.fn>
        ).mockReturnValue(false);

        const lifecycle = makeReconnectionLifecycle(deps);

        await lifecycle.attemptReconnection('peer1');

        // Non-retryable errors should NOT be recorded - they don't contribute
        // to permanent failure detection
        expect(deps.reconnectionManager.recordError).not.toHaveBeenCalled();
        // But should still give up
        expect(deps.onRemoteGiveUp).toHaveBeenCalledWith('peer1');
      });
    });
  });

  describe('handleConnectionLoss with permanent failure', () => {
    it('skips reconnection and calls onRemoteGiveUp for permanently failed peer', () => {
      (
        deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);
      (
        deps.reconnectionManager.startReconnection as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);

      const lifecycle = makeReconnectionLifecycle(deps);

      lifecycle.handleConnectionLoss('peer1');

      expect(deps.reconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer1',
      );
      expect(deps.onRemoteGiveUp).toHaveBeenCalledWith('peer1');
      expect(deps.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('permanently failed'),
      );
    });

    it('proceeds with reconnection when startReconnection returns true', () => {
      (
        deps.reconnectionManager.isReconnecting as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);
      (
        deps.reconnectionManager.startReconnection as ReturnType<typeof vi.fn>
      ).mockReturnValue(true);

      const lifecycle = makeReconnectionLifecycle(deps);

      lifecycle.handleConnectionLoss('peer1');

      expect(deps.reconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer1',
      );
      expect(deps.onRemoteGiveUp).not.toHaveBeenCalled();
    });
  });
});
