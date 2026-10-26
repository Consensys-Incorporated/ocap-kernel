import { UnexpectedEOFError } from '@libp2p/utils';
import { AbortError } from '@metamask/kernel-errors';
import { makeAbortSignalMock } from '@ocap/repo-tools/test-utils';
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
} from 'vitest';

// Import the module we're testing - must be after mocks are set up
let initTransport: typeof import('./transport.ts').initTransport;

// Mock ReconnectionManager
const mockReconnectionManager = {
  isReconnecting: vi.fn().mockReturnValue(false),
  startReconnection: vi.fn().mockReturnValue(true),
  stopReconnection: vi.fn(),
  shouldRetry: vi.fn().mockReturnValue(true),
  incrementAttempt: vi.fn().mockReturnValue(1),
  decrementAttempt: vi.fn(),
  calculateBackoff: vi.fn().mockReturnValue(100),
  resetBackoff: vi.fn(),
  resetAllBackoffs: vi.fn(),
  clear: vi.fn(),
  clearPeer: vi.fn(),
  isPermanentlyFailed: vi.fn().mockReturnValue(false),
  recordError: vi.fn(),
  clearPermanentFailure: vi.fn(),
};

vi.mock('./reconnection.ts', () => {
  class MockReconnectionManager {
    isReconnecting = mockReconnectionManager.isReconnecting;

    startReconnection = mockReconnectionManager.startReconnection;

    stopReconnection = mockReconnectionManager.stopReconnection;

    shouldRetry = mockReconnectionManager.shouldRetry;

    incrementAttempt = mockReconnectionManager.incrementAttempt;

    decrementAttempt = mockReconnectionManager.decrementAttempt;

    calculateBackoff = mockReconnectionManager.calculateBackoff;

    resetBackoff = mockReconnectionManager.resetBackoff;

    resetAllBackoffs = mockReconnectionManager.resetAllBackoffs;

    clear = mockReconnectionManager.clear;

    clearPeer = mockReconnectionManager.clearPeer;

    isPermanentlyFailed = mockReconnectionManager.isPermanentlyFailed;

    recordError = mockReconnectionManager.recordError;

    clearPermanentFailure = mockReconnectionManager.clearPermanentFailure;
  }
  return {
    ReconnectionManager: MockReconnectionManager,
  };
});

// Mock ConnectionFactory
type MockStream = {
  status: string;
  inactivityTimeout: number;
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
};

type MockChannel = {
  peerId: string;
  stream: MockStream;
  msgStream: {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    unwrap: ReturnType<typeof vi.fn>;
  };
};

const mockConnectionFactory = {
  dialIdempotent: vi.fn(),
  onInboundConnection: vi.fn(),
  onPeerDisconnect: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  closeChannel: vi.fn().mockResolvedValue(undefined),
  getListenAddresses: vi.fn().mockReturnValue([]),
};

vi.mock('./connection-factory.ts', () => {
  return {
    ConnectionFactory: {
      make: vi.fn(async () => Promise.resolve(mockConnectionFactory)),
    },
  };
});

// Mock Logger
const mockLogger = {
  log: vi.fn(),
  error: vi.fn(),
};

vi.mock('@metamask/logger', () => {
  class MockLogger {
    log = mockLogger.log;

    error = mockLogger.error;
  }
  return {
    Logger: MockLogger,
  };
});

// Mock kernel-utils
vi.mock('@metamask/kernel-utils', () => {
  return {
    abortableDelay: vi.fn(),
    installWakeDetector: vi.fn(() => vi.fn()),
    DEFAULT_MAX_RETRY_ATTEMPTS: 0,
  };
});

// Mock kernel-errors
vi.mock('@metamask/kernel-errors', () => ({
  AbortError: class MockAbortError extends Error {
    constructor() {
      super('Aborted');
      this.name = 'AbortError';
    }
  },
  ResourceLimitError: class MockResourceLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ResourceLimitError';
    }
  },
  PeerRestartedError: class MockPeerRestartedError extends Error {
    constructor() {
      super('Remote peer restarted: message not sent to avoid stale delivery');
      this.name = 'PeerRestartedError';
    }
  },
  IntentionalCloseError: class MockIntentionalCloseError extends Error {
    constructor() {
      super('Message delivery failed after intentional close');
      this.name = 'IntentionalCloseError';
    }
  },
  NetworkStoppedError: class MockNetworkStoppedError extends Error {
    constructor() {
      super('Network stopped');
      this.name = 'NetworkStoppedError';
    }
  },
  isRetryableNetworkError: vi.fn().mockImplementation((error: unknown) => {
    const errorWithCode = error as { code?: string };
    return (
      errorWithCode?.code === 'ECONNRESET' ||
      errorWithCode?.code === 'ETIMEDOUT'
    );
  }),
  getNetworkErrorCode: vi.fn().mockImplementation((error: unknown) => {
    const errorWithCode = error as { code?: string; name?: string };
    return errorWithCode?.code ?? errorWithCode?.name ?? 'UNKNOWN';
  }),
  isResourceLimitError: vi.fn().mockReturnValue(false),
}));

// Mock uint8arrays
vi.mock('uint8arrays', () => ({
  toString: vi.fn((buffer: Uint8Array) => new TextDecoder().decode(buffer)),
  fromString: vi.fn((str: string) => new TextEncoder().encode(str)),
}));

/**
 * Helper to create a test message string in the format expected by sendRemoteMessage.
 * Network layer now receives pre-serialized strings from RemoteHandle (which adds seq/ack).
 *
 * @param content - The content string (for test identification).
 * @returns JSON string containing test message.
 */
function makeTestMessage(content: string): string {
  return JSON.stringify({
    seq: 1,
    method: 'deliver',
    params: ['notify', [[content, false, { body: '""', slots: [] }]]],
  });
}

describe('transport.initTransport', () => {
  // Import after all mocks are set up
  beforeAll(async () => {
    const networkModule = await import('./transport.ts');
    initTransport = networkModule.initTransport;
  });

  beforeEach(() => {
    // Clear mock call history
    mockReconnectionManager.isReconnecting.mockClear();
    mockReconnectionManager.startReconnection.mockClear();
    mockReconnectionManager.stopReconnection.mockClear();
    mockReconnectionManager.shouldRetry.mockClear();
    mockReconnectionManager.incrementAttempt.mockClear();
    mockReconnectionManager.decrementAttempt.mockClear();
    mockReconnectionManager.calculateBackoff.mockClear();
    mockReconnectionManager.resetBackoff.mockClear();
    mockReconnectionManager.resetAllBackoffs.mockClear();
    mockReconnectionManager.clear.mockClear();
    mockReconnectionManager.clearPeer.mockClear();
    mockReconnectionManager.isPermanentlyFailed.mockClear();
    mockReconnectionManager.recordError.mockClear();
    mockReconnectionManager.clearPermanentFailure.mockClear();

    mockConnectionFactory.dialIdempotent.mockReset();
    mockConnectionFactory.onInboundConnection.mockClear();
    mockConnectionFactory.stop.mockClear();
    mockConnectionFactory.closeChannel.mockClear();

    mockLogger.log.mockClear();
    mockLogger.error.mockClear();

    // MessageQueue instances are automatically created fresh for each test

    // Reset mock implementations
    mockReconnectionManager.isReconnecting.mockReturnValue(false);
    mockReconnectionManager.shouldRetry.mockReturnValue(true);
    mockReconnectionManager.incrementAttempt.mockReturnValue(1);
    mockReconnectionManager.calculateBackoff.mockReturnValue(100);
    mockConnectionFactory.stop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  const createMockChannel = (peerId: string): MockChannel => {
    const stream: MockStream = {
      status: 'open',
      inactivityTimeout: 0,
      addEventListener: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
    };
    return {
      peerId,
      stream,
      msgStream: {
        read: vi
          .fn<() => Promise<Uint8Array | undefined>>()
          .mockImplementation(async () => {
            return await new Promise<Uint8Array | undefined>(() => {
              /* Never resolves by default */
            });
          }),
        write: vi
          .fn<(buffer: Uint8Array) => Promise<void>>()
          .mockResolvedValue(undefined),
        unwrap: vi.fn(() => stream),
      },
    };
  };

  describe('initialization', () => {
    it('passes correct parameters to ConnectionFactory.make', async () => {
      const { ConnectionFactory } = await import('./connection-factory.ts');
      const keySeed = '0xabcd';
      const knownRelays = [
        '/dns4/relay1.example/tcp/443/wss/p2p/relay1',
        '/dns4/relay2.example/tcp/443/wss/p2p/relay2',
      ];

      await initTransport(keySeed, { relays: knownRelays }, vi.fn());

      expect(ConnectionFactory.make).toHaveBeenCalledWith({
        keySeed,
        knownRelays,
        logger: expect.any(Object),
        signal: expect.any(AbortSignal),
        maxRetryAttempts: undefined,
        maxMessageSizeBytes: 1024 * 1024,
        directTransports: undefined,
      });
    });

    it('passes maxRetryAttempts to ConnectionFactory.make', async () => {
      const { ConnectionFactory } = await import('./connection-factory.ts');
      const keySeed = '0xabcd';
      const maxRetryAttempts = 5;

      await initTransport(keySeed, { relays: [], maxRetryAttempts }, vi.fn());

      expect(ConnectionFactory.make).toHaveBeenCalledWith({
        keySeed,
        knownRelays: [],
        logger: expect.any(Object),
        signal: expect.any(AbortSignal),
        maxRetryAttempts,
        maxMessageSizeBytes: 1024 * 1024,
        directTransports: undefined,
      });
    });

    it('passes the reconnection backoff to ConnectionFactory.make', async () => {
      const { ConnectionFactory } = await import('./connection-factory.ts');

      await initTransport(
        '0xabcd',
        { relays: [], reconnectionBaseDelayMs: 10, reconnectionMaxDelayMs: 50 },
        vi.fn(),
      );

      expect(ConnectionFactory.make).toHaveBeenCalledWith(
        expect.objectContaining({
          reconnectionBaseDelayMs: 10,
          reconnectionMaxDelayMs: 50,
        }),
      );
    });

    it('passes directTransports to ConnectionFactory.make', async () => {
      const { ConnectionFactory } = await import('./connection-factory.ts');
      const keySeed = '0xabcd';
      const mockQuic = { tag: 'quic' };
      const mockTcp = { tag: 'tcp' };
      const directTransports = [
        {
          transport: mockQuic,
          listenAddresses: ['/ip4/0.0.0.0/udp/0/quic-v1'],
        },
        {
          transport: mockTcp,
          listenAddresses: ['/ip4/0.0.0.0/tcp/4001'],
        },
      ];

      await initTransport(keySeed, { relays: [], directTransports }, vi.fn());

      expect(ConnectionFactory.make).toHaveBeenCalledWith({
        keySeed,
        knownRelays: [],
        logger: expect.any(Object),
        signal: expect.any(AbortSignal),
        maxRetryAttempts: undefined,
        maxMessageSizeBytes: 1024 * 1024,
        directTransports,
      });
    });

    it('returns sendRemoteMessage, stop, closeConnection, registerLocationHints, reconnectPeer, and getListenAddresses', async () => {
      const result = await initTransport('0x1234', {}, vi.fn());

      expect(result).toHaveProperty('sendRemoteMessage');
      expect(result).toHaveProperty('stop');
      expect(result).toHaveProperty('closeConnection');
      expect(result).toHaveProperty('registerLocationHints');
      expect(result).toHaveProperty('reconnectPeer');
      expect(result).toHaveProperty('getListenAddresses');
      expect(typeof result.sendRemoteMessage).toBe('function');
      expect(typeof result.stop).toBe('function');
      expect(typeof result.closeConnection).toBe('function');
      expect(typeof result.registerLocationHints).toBe('function');
      expect(typeof result.reconnectPeer).toBe('function');
      expect(typeof result.getListenAddresses).toBe('function');
    });
  });

  describe('basic messaging', () => {
    it('opens channel and sends message to new peer', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        {
          relays: ['/dns4/relay.example/tcp/443/wss/p2p/relay1'],
        },
        vi.fn(),
      );

      await sendRemoteMessage('peer-1', makeTestMessage('hello'));

      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledWith(
        'peer-1',
        [],
        true,
      );
      expect(mockChannel.msgStream.write).toHaveBeenCalledWith(
        expect.any(Uint8Array),
      );
    });

    it('reuses existing channel for same peer', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Send first message
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledTimes(1);
      expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(1);

      // Send second message - should reuse channel (no new dial)
      await sendRemoteMessage('peer-1', makeTestMessage('msg2'));

      // Should still be only 1 dial (channel reused)
      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledTimes(1);
      expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(2);
    });

    it('opens separate channels for different peers', async () => {
      const mockChannel1 = createMockChannel('peer-1');
      const mockChannel2 = createMockChannel('peer-2');
      mockConnectionFactory.dialIdempotent
        .mockResolvedValueOnce(mockChannel1)
        .mockResolvedValueOnce(mockChannel2);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      await sendRemoteMessage('peer-1', makeTestMessage('hello'));
      await sendRemoteMessage('peer-2', makeTestMessage('world'));

      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledTimes(2);
    });

    it('passes hints to ConnectionFactory', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);
      const hints = ['/dns4/hint.example/tcp/443/wss/p2p/hint'];

      const { sendRemoteMessage, registerLocationHints } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      registerLocationHints('peer-1', hints);
      await sendRemoteMessage('peer-1', makeTestMessage('hello'));

      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledWith(
        'peer-1',
        hints,
        true,
      );
    });
  });

  describe('inbound connections', () => {
    it('registers inbound connection handler', async () => {
      await initTransport('0x1234', {}, vi.fn());

      expect(mockConnectionFactory.onInboundConnection).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });

    it('handles inbound messages', async () => {
      const remoteHandler = vi.fn().mockResolvedValue('ok');
      let inboundHandler: ((channel: MockChannel) => void) | undefined;

      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      await initTransport('0x1234', {}, remoteHandler);

      const mockChannel = createMockChannel('inbound-peer');
      const messageBuffer = new TextEncoder().encode('test-message');
      mockChannel.msgStream.read.mockResolvedValueOnce(messageBuffer);
      mockChannel.msgStream.read.mockReturnValue(
        new Promise<Uint8Array>(() => {
          /* Block after first message */
        }),
      );

      inboundHandler?.(mockChannel);

      await vi.waitFor(() => {
        expect(remoteHandler).toHaveBeenCalledWith(
          'inbound-peer',
          'test-message',
        );
      });
    });

    it('handles errors from remoteMessageHandler', async () => {
      const remoteHandler = vi
        .fn()
        .mockRejectedValue(new Error('Handler error'));
      let inboundHandler: ((channel: MockChannel) => void) | undefined;

      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      await initTransport('0x1234', {}, remoteHandler);

      const mockChannel = createMockChannel('inbound-peer');
      const messageBuffer = new TextEncoder().encode('test-message');
      mockChannel.msgStream.read.mockResolvedValueOnce(messageBuffer);
      mockChannel.msgStream.read.mockReturnValue(
        new Promise<Uint8Array>(() => {
          /* Block after first message */
        }),
      );

      inboundHandler?.(mockChannel);

      // Handler error should be caught and not crash the read loop
      await vi.waitFor(() => {
        expect(remoteHandler).toHaveBeenCalledWith(
          'inbound-peer',
          'test-message',
        );
      });

      // Read loop should continue (not throw)
      expect(mockChannel.msgStream.read).toHaveBeenCalled();
    });
  });

  describe('connection loss and reconnection', () => {
    it('still dials even when reconnecting (sends are best-effort)', async () => {
      // With the simplified network layer, sends always attempt to dial
      // The reconnection loop is separate and handles retries
      mockReconnectionManager.isReconnecting.mockReturnValue(true);

      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Send succeeds because dial succeeds
      await sendRemoteMessage('peer-1', makeTestMessage('msg'));

      // Dial should happen even during reconnection
      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledTimes(1);
      expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(1);
    });

    it('handles write failure and triggers reconnection', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.write
        .mockResolvedValueOnce(undefined) // First write succeeds
        .mockRejectedValueOnce(
          Object.assign(new Error('Write failed'), { code: 'ECONNRESET' }),
        ); // Second write fails
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // First send establishes channel
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));
      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledTimes(1);

      // Second send fails and triggers reconnection
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Write failed');

      expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer-1',
      );
    }, 5000);

    it('starts reconnection on read error', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      await initTransport('0x1234', {}, vi.fn());

      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.read.mockRejectedValue(new Error('Read failed'));

      inboundHandler?.(mockChannel);

      await vi.waitFor(() => {
        expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
          'peer-1',
        );
      });
    });

    it('handles graceful disconnect without error logging', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      await initTransport('0x1234', {}, vi.fn());

      const mockChannel = createMockChannel('peer-1');
      const gracefulDisconnectError = Object.assign(new Error('SCTP failure'), {
        errorDetail: 'sctp-failure',
        sctpCauseCode: 12, // SCTP_USER_INITIATED_ABORT
      });
      mockChannel.msgStream.read.mockRejectedValue(gracefulDisconnectError);

      inboundHandler?.(mockChannel);

      await vi.waitFor(() => {
        // Should log intentional disconnect message
        expect(mockLogger.log).toHaveBeenCalledWith(
          'peer-1:: remote intentionally disconnected',
        );
        expect(mockLogger.log).toHaveBeenCalledWith('closed channel to peer-1');
        // Should not start reconnection for intentional disconnect
        expect(
          mockReconnectionManager.startReconnection,
        ).not.toHaveBeenCalled();
      });
    });

    it('treats StreamResetError as connection loss, not intentional close', async () => {
      const { StreamResetError: MockStreamResetError } =
        await import('@libp2p/interface');
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      await initTransport('0x1234', {}, vi.fn());

      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.read.mockRejectedValue(
        new MockStreamResetError('stream reset'),
      );

      inboundHandler?.(mockChannel);

      await vi.waitFor(() => {
        // StreamResetError from the remote triggers reconnection, not
        // intentional close — a malicious peer could otherwise permanently
        // suppress the connection by aborting the stream.
        expect(mockLogger.log).toHaveBeenCalledWith(
          'peer-1:: stream reset by remote, reconnecting',
        );
        expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
          'peer-1',
        );
      });
    });

    it('starts reconnection on peer:disconnect when no active channel', async () => {
      let disconnectHandler: ((peerId: string) => void) | undefined;
      mockConnectionFactory.onPeerDisconnect.mockImplementation(
        (handler: (peerId: string) => void) => {
          disconnectHandler = handler;
        },
      );

      await initTransport('0x1234', {}, vi.fn());

      // peer-1 has no channel (never connected), so peer:disconnect triggers reconnection
      disconnectHandler?.('peer-1');

      expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer-1',
      );
    });

    it('does not trigger reconnection on peer:disconnect when channel is active', async () => {
      let disconnectHandler: ((peerId: string) => void) | undefined;
      mockConnectionFactory.onPeerDisconnect.mockImplementation(
        (handler: (peerId: string) => void) => {
          disconnectHandler = handler;
        },
      );

      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage: send } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      // Establish an active channel
      await send('peer-1', makeTestMessage('msg1'));

      // peer:disconnect fires but channel is still active — readChannel handles cleanup
      disconnectHandler?.('peer-1');

      expect(mockReconnectionManager.startReconnection).not.toHaveBeenCalled();
    });

    it('throws AbortError when signal aborted during read', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      const { stop } = await initTransport('0x1234', {}, vi.fn());

      const mockChannel = createMockChannel('peer-1');
      // Make read resolve after stop so loop continues and checks signal.aborted
      let shouldResolve = false;
      const poll = async (): Promise<Uint8Array> => {
        // Wait until stop is called
        // oxlint-disable-next-line no-unmodified-loop-condition
        while (!shouldResolve) {
          await new Promise<void>((resolve) => {
            setImmediate(() => resolve());
          });
        }
        // Return a value so loop continues to next iteration where it checks signal.aborted
        return new TextEncoder().encode('dummy');
      };
      mockChannel.msgStream.read.mockReturnValue(poll());

      // Start reading in background
      inboundHandler?.(mockChannel);

      // Give it a moment to start the read
      await new Promise((resolve) => setImmediate(resolve));

      // Stop should abort the signal, then resolve the read so loop checks signal.aborted
      shouldResolve = true;
      await stop();

      // Wait for the abort error to be logged
      await vi.waitFor(() => {
        expect(mockLogger.log).toHaveBeenCalledWith('reader abort: peer-1');
        // Error should be caught and logged via outputError
        expect(mockLogger.log).toHaveBeenCalledWith(
          expect.stringContaining('error error in inbound channel read'),
        );
      });
    });

    it('treats UnexpectedEOFError as connection loss and triggers reconnection', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      const remoteHandler = vi.fn().mockResolvedValue('ok');
      await initTransport('0x1234', {}, remoteHandler);

      const mockChannel = createMockChannel('peer-1');
      // lpStream throws UnexpectedEOFError on EOF — both for clean
      // end-of-stream between messages and for a partial-message drop.
      // The read loop can't distinguish the two, so it must treat any
      // EOF as a potential mid-message drop and trigger reconnection
      // (rather than silently exiting and leaving the sender to
      // retransmit into a dead channel).
      mockChannel.msgStream.read.mockRejectedValueOnce(
        new UnexpectedEOFError('stream closed'),
      );

      inboundHandler?.(mockChannel);

      await vi.waitFor(() => {
        expect(remoteHandler).not.toHaveBeenCalled();
        expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
          'peer-1',
        );
      });
    });

    it('reconnection re-establishes channel after connection loss', async () => {
      // Drive reconnection state deterministically
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });
      mockReconnectionManager.shouldRetry.mockReturnValue(true);
      mockReconnectionManager.incrementAttempt.mockReturnValue(1);
      mockReconnectionManager.calculateBackoff.mockReturnValue(0); // No delay

      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      // Setup for reconnection scenario
      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.write
        .mockResolvedValueOnce(undefined) // Initial message succeeds
        .mockRejectedValueOnce(
          Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
        ) // Second write fails, triggering reconnection
        .mockResolvedValue(undefined); // Post-reconnection writes succeed

      mockConnectionFactory.dialIdempotent
        .mockResolvedValueOnce(mockChannel) // Initial connection
        .mockResolvedValueOnce(mockChannel); // Reconnection succeeds

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // First send establishes channel
      await sendRemoteMessage('peer-1', makeTestMessage('initial-msg'));

      // Second send fails and triggers reconnection
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('fail-msg')),
      ).rejects.toThrow('Connection lost');

      // Wait for reconnection to start and complete
      await vi.waitFor(() => {
        expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
          'peer-1',
        );
        expect(mockReconnectionManager.stopReconnection).toHaveBeenCalledWith(
          'peer-1',
        );
      });

      // After reconnection completes, new sends should work
      reconnecting = false;
      await sendRemoteMessage('peer-1', makeTestMessage('after-reconnect'));
      expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(3);
    });

    it('resets backoff on each successful send', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.write.mockResolvedValue(undefined);
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Clear any resetBackoff calls from initialization
      mockReconnectionManager.resetBackoff.mockClear();

      // Send multiple messages successfully
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));
      await sendRemoteMessage('peer-1', makeTestMessage('msg2'));
      await sendRemoteMessage('peer-1', makeTestMessage('msg3'));

      // Each successful send should reset backoff
      expect(mockReconnectionManager.resetBackoff).toHaveBeenCalledTimes(3);
      expect(mockReconnectionManager.resetBackoff).toHaveBeenCalledWith(
        'peer-1',
      );
    });
  });

  describe('stop functionality', () => {
    it('returns a stop function', async () => {
      const { stop } = await initTransport('0x1234', {}, vi.fn());

      expect(typeof stop).toBe('function');
    });

    it('cleans up resources on stop', async () => {
      const { stop } = await initTransport('0x1234', {}, vi.fn());

      await stop();

      expect(mockConnectionFactory.stop).toHaveBeenCalled();
      expect(mockReconnectionManager.clear).toHaveBeenCalled();
    });

    it('gracefully closes active channel streams on stop', async () => {
      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      // Establish a channel by sending a message
      await sendRemoteMessage('peer-1', makeTestMessage('msg'));

      await stop();

      expect(mockChannel.stream.close).toHaveBeenCalled();
    });

    it('does not send messages after stop', async () => {
      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      await stop();
      // sendRemoteMessage now throws after stop
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg')),
      ).rejects.toThrow('Network stopped');

      expect(mockConnectionFactory.dialIdempotent).not.toHaveBeenCalled();
    });

    it('aborts ongoing reconnection on stop', async () => {
      const { abortableDelay } = await import('@metamask/kernel-utils');

      (abortableDelay as ReturnType<typeof vi.fn>).mockImplementation(
        // oxlint-disable-next-line typescript/promise-function-async, typescript/no-misused-promises
        (_ms: number, signal?: AbortSignal) => {
          if (signal?.aborted) {
            return Promise.reject(new AbortError());
          }
          return new Promise<void>((_resolve, reject) => {
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(new AbortError());
              });
            }
          });
        },
      );

      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.write
        .mockResolvedValueOnce(undefined) // First write succeeds
        .mockRejectedValue(
          Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
        ); // Subsequent writes fail
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      // Establish channel
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Trigger reconnection with write failure (happens in background)
      sendRemoteMessage('peer-1', makeTestMessage('msg2')).catch(() => {
        /* Ignore error */
      });

      // Give reconnection a chance to start
      await new Promise((resolve) => setImmediate(resolve));

      // Stop should abort the reconnection
      await stop();

      expect(mockConnectionFactory.stop).toHaveBeenCalled();
      expect(mockReconnectionManager.clear).toHaveBeenCalled();
    });

    it('can be called multiple times safely', async () => {
      const { stop } = await initTransport('0x1234', {}, vi.fn());

      // Multiple calls should not throw
      await stop();
      await stop();
      await stop();

      // Should have been called
      expect(mockConnectionFactory.stop).toHaveBeenCalled();
      expect(mockReconnectionManager.clear).toHaveBeenCalled();
    });
  });

  describe('closeConnection', () => {
    it('returns a closeConnection function', async () => {
      const { closeConnection } = await initTransport('0x1234', {}, vi.fn());

      expect(typeof closeConnection).toBe('function');
    });

    it('marks peer as intentionally closed and prevents message sending', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, closeConnection } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      // Establish channel
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Close connection
      await closeConnection('peer-1');

      // Attempting to send should throw
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Message delivery failed after intentional close');
    });

    it('deletes channel and stops reconnection', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, closeConnection } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      // Establish channel
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Start reconnection (simulate by setting reconnecting state)
      mockReconnectionManager.isReconnecting.mockReturnValue(true);

      await closeConnection('peer-1');

      expect(mockReconnectionManager.stopReconnection).toHaveBeenCalledWith(
        'peer-1',
      );
    });

    it('rejects sends immediately after close', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, closeConnection } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      // Establish channel
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Close connection
      await closeConnection('peer-1');

      // Any sends after close should immediately reject
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Message delivery failed after intentional close');
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg3')),
      ).rejects.toThrow('Message delivery failed after intentional close');
    });

    it('prevents automatic reconnection after intentional close', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, closeConnection } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      // Establish connection
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Close connection intentionally
      await closeConnection('peer-1');

      // Attempting to send should throw before attempting to write
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Message delivery failed after intentional close');

      // Should not start reconnection (sendRemoteMessage throws before handleConnectionLoss)
      expect(mockReconnectionManager.startReconnection).not.toHaveBeenCalled();
    });

    it('rejects inbound connections from intentionally closed peers', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      const { closeConnection } = await initTransport('0x1234', {}, vi.fn());

      // Close connection first
      await closeConnection('peer-1');

      // Try to establish inbound connection from closed peer
      const mockChannel = createMockChannel('peer-1');
      inboundHandler?.(mockChannel);

      await vi.waitFor(() => {
        // Should log rejection message
        expect(mockLogger.log).toHaveBeenCalledWith(
          'peer-1:: rejecting inbound connection from intentionally closed peer',
        );
        // Should not start reading from this channel
        expect(mockChannel.msgStream.read).not.toHaveBeenCalled();
        // Should close the channel to prevent resource leaks
        expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
          mockChannel,
          'peer-1',
        );
      });
    });
  });

  describe('registerLocationHints', () => {
    it('returns a registerLocationHints function', async () => {
      const { registerLocationHints } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      expect(typeof registerLocationHints).toBe('function');
    });
  });

  describe('reconnectPeer', () => {
    it('returns a reconnectPeer function', async () => {
      const { reconnectPeer } = await initTransport('0x1234', {}, vi.fn());

      expect(typeof reconnectPeer).toBe('function');
    });

    it('clears intentional close flag and initiates reconnection', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, closeConnection, reconnectPeer } =
        await initTransport('0x1234', {}, vi.fn());

      // Establish and close connection
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));
      await closeConnection('peer-1');

      // Verify peer is marked as intentionally closed
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Message delivery failed after intentional close');

      // Reconnect peer
      await reconnectPeer('peer-1');

      // Should start reconnection
      expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer-1',
      );
    });

    it('reconnects peer with provided hints', async () => {
      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      // Set up reconnection state
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });
      mockReconnectionManager.shouldRetry.mockReturnValue(true);
      mockReconnectionManager.incrementAttempt.mockReturnValue(1);
      mockReconnectionManager.calculateBackoff.mockReturnValue(0); // No delay for test

      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { closeConnection, reconnectPeer } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      await closeConnection('peer-1');

      const hints = ['/dns4/relay.example/tcp/443/wss/p2p/relay'];
      await reconnectPeer('peer-1', hints);

      // Should start reconnection with hints
      expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer-1',
      );

      // Wait for reconnection attempt
      await vi.waitFor(() => {
        expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledWith(
          'peer-1',
          hints,
          false,
        );
      });
    });

    it('reconnects peer with empty hints when not provided', async () => {
      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      // Set up reconnection state
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });
      mockReconnectionManager.shouldRetry.mockReturnValue(true);
      mockReconnectionManager.incrementAttempt.mockReturnValue(1);
      mockReconnectionManager.calculateBackoff.mockReturnValue(0); // No delay for test

      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { closeConnection, reconnectPeer } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      await closeConnection('peer-1');
      await reconnectPeer('peer-1');

      // Wait for reconnection attempt with empty hints
      await vi.waitFor(() => {
        expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledWith(
          'peer-1',
          [],
          false,
        );
      });
    });

    it('does not start duplicate reconnection if already reconnecting', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { closeConnection, reconnectPeer } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      await closeConnection('peer-1');

      // Set up reconnection state
      mockReconnectionManager.isReconnecting.mockReturnValue(true);

      await reconnectPeer('peer-1');

      // Should not start another reconnection
      expect(mockReconnectionManager.startReconnection).not.toHaveBeenCalled();
    });

    it('does not clear error history when reconnection is already in progress', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { closeConnection, reconnectPeer } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      await closeConnection('peer-1');

      // Set up reconnection state - already reconnecting
      mockReconnectionManager.isReconnecting.mockReturnValue(true);

      await reconnectPeer('peer-1');

      // Should not clear permanent failure status (which also clears error history)
      // when reconnection is already in progress
      expect(
        mockReconnectionManager.clearPermanentFailure,
      ).not.toHaveBeenCalled();
    });

    it('clears permanent failure status when manually reconnecting', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { closeConnection, reconnectPeer } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      await closeConnection('peer-1');
      await reconnectPeer('peer-1');

      // Should clear permanent failure status before attempting reconnection
      expect(
        mockReconnectionManager.clearPermanentFailure,
      ).toHaveBeenCalledWith('peer-1');
      // Then start reconnection
      expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer-1',
      );
    });

    it('allows sending messages after reconnection', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, closeConnection, reconnectPeer } =
        await initTransport('0x1234', {}, vi.fn());

      // Establish, close, and reconnect
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));
      await closeConnection('peer-1');
      await reconnectPeer('peer-1');

      // Wait for reconnection to complete
      await vi.waitFor(() => {
        expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalled();
      });

      // Reset reconnection state to simulate successful reconnection
      mockReconnectionManager.isReconnecting.mockReturnValue(false);

      // Should be able to send messages after reconnection
      await sendRemoteMessage('peer-1', makeTestMessage('msg2'));
      expect(mockChannel.msgStream.write).toHaveBeenCalled();
    });
  });

  describe('wake from sleep', () => {
    it('installs wake detector and handles wake events', async () => {
      const { installWakeDetector } = await import('@metamask/kernel-utils');
      let wakeHandler: (() => void) | undefined;

      (installWakeDetector as ReturnType<typeof vi.fn>).mockImplementation(
        (handler) => {
          wakeHandler = handler;
          return vi.fn();
        },
      );

      await initTransport('0x1234', {}, vi.fn());

      expect(installWakeDetector).toHaveBeenCalled();

      // Trigger wake event
      wakeHandler?.();

      expect(mockReconnectionManager.resetAllBackoffs).toHaveBeenCalled();
    });

    it('cleans up wake detector on stop', async () => {
      const cleanupFn = vi.fn();
      const { installWakeDetector } = await import('@metamask/kernel-utils');
      (installWakeDetector as ReturnType<typeof vi.fn>).mockReturnValue(
        cleanupFn,
      );

      const { stop } = await initTransport('0x1234', {}, vi.fn());

      await stop();

      expect(cleanupFn).toHaveBeenCalled();
    });
  });

  describe('resetAllBackoffs', () => {
    it('exposes resetAllBackoffs that delegates to reconnection manager', async () => {
      const transport = await initTransport('0x1234', {}, vi.fn());

      transport.resetAllBackoffs();

      expect(mockReconnectionManager.resetAllBackoffs).toHaveBeenCalledOnce();
    });
  });

  describe('race conditions', () => {
    it('queues message if reconnection starts during dial', async () => {
      // Initially not reconnecting
      mockReconnectionManager.isReconnecting.mockReturnValue(false);

      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockImplementation(async () => {
        // Simulate reconnection starting during dial
        mockReconnectionManager.isReconnecting.mockReturnValue(true);
        // Small delay to simulate async operation
        await new Promise((resolve) => setImmediate(resolve));
        return mockChannel;
      });

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Send message - it should handle the race condition gracefully
      // Promise resolves when write completes (no ACK needed in network layer)
      await sendRemoteMessage('peer-1', makeTestMessage('msg'));

      // Verify dial was called
      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledWith(
        'peer-1',
        [],
        true,
      );
    });

    it('does not start duplicate reconnection loops', async () => {
      // Capture inbound handler before init
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      // Drive reconnection state deterministically
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });
      // Allow first retry, then stop to prevent infinite loop
      // The loop needs to stay active when second handleConnectionLoss is called,
      // but should exit after successful flush
      mockReconnectionManager.shouldRetry
        .mockReturnValueOnce(true) // First attempt - allows loop to stay active for second handleConnectionLoss
        .mockReturnValue(false); // After flush completes, stop to prevent infinite loop

      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      // Fail initial dial to trigger first handleConnectionLoss, then allow reconnection loop to succeed
      const reconChannel = createMockChannel('peer-1');
      // Ensure flush completes successfully so loop exits naturally
      reconChannel.msgStream.write.mockResolvedValue(undefined);
      // Make dialIdempotent resolve after a small delay to ensure reconnection loop is active
      // when inbound error is processed
      mockConnectionFactory.dialIdempotent
        .mockRejectedValueOnce(
          Object.assign(new Error('Dial failed'), { code: 'ECONNRESET' }),
        )
        .mockImplementation(async () => {
          // Small delay to ensure reconnection state is checked before dial completes
          await new Promise((resolve) => setImmediate(resolve));
          return reconChannel;
        });

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Trigger first connection loss (this starts reconnection)
      // Dial fails and throws, but reconnection is started in background
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg-1')),
      ).rejects.toThrow('Dial failed');

      // Trigger another connection loss via inbound read error for same peer
      // This should happen while reconnection is still active (reconnecting = true)
      // The dialIdempotent delay ensures the reconnection loop hasn't completed yet
      const inboundChannel = createMockChannel('peer-1');
      inboundChannel.msgStream.read.mockRejectedValueOnce(
        new Error('Read failed'),
      );
      inboundHandler?.(inboundChannel);

      await vi.waitFor(() => {
        expect(mockReconnectionManager.startReconnection).toHaveBeenCalledTimes(
          1,
        );
        expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
          'peer-1',
        );
      });
    });

    it('reuses existing channel when inbound connection arrives during reconnection dial', async () => {
      // Capture inbound handler before init
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      // Create channels
      const outboundChannel = createMockChannel('peer-1');
      const inboundChannel = createMockChannel('peer-1');

      // Control when the dial completes
      let resolveDial: ((channel: MockChannel) => void) | undefined;
      const dialPromise = new Promise<MockChannel>((resolve) => {
        resolveDial = resolve;
      });
      mockConnectionFactory.dialIdempotent.mockReturnValue(dialPromise);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Start sending a message - this will trigger the dial
      const sendPromise = sendRemoteMessage('peer-1', makeTestMessage('hello'));

      // Verify dial was initiated
      await vi.waitFor(() => {
        expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalled();
      });

      // While the dial is pending, an inbound connection arrives from the same peer
      inboundHandler?.(inboundChannel);

      // Now complete the dial - the outbound channel should be closed since inbound is already registered
      resolveDial?.(outboundChannel);

      // Wait for the message to be sent
      await sendPromise;

      // The outbound channel should have been closed since inbound connection was already established
      expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
        outboundChannel,
        'peer-1',
      );

      // Verify that messages go through the inbound channel (which was registered first)
      // or the outbound channel that was dialed - either is acceptable
      // The important thing is that we don't have duplicate channels
      const totalWrites =
        inboundChannel.msgStream.write.mock.calls.length +
        outboundChannel.msgStream.write.mock.calls.length;
      expect(totalWrites).toBeGreaterThanOrEqual(1);
    });
  });

  describe('error handling', () => {
    it('handles dial errors gracefully', async () => {
      mockConnectionFactory.dialIdempotent.mockRejectedValue(
        new Error('Dial failed'),
      );

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // sendRemoteMessage throws the error after triggering reconnection
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg')),
      ).rejects.toThrow('Dial failed');

      expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer-1',
      );
    });

    it('handles non-retryable errors during reconnection', async () => {
      // Drive reconnection state deterministically
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });

      const mockChannel = createMockChannel('peer-1');

      mockConnectionFactory.dialIdempotent
        .mockResolvedValueOnce(mockChannel) // initial connection
        .mockRejectedValueOnce(new Error('Permanent failure')); // non-retryable during reconnection

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Establish channel
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Trigger reconnection via retryable write failure
      mockChannel.msgStream.write.mockRejectedValueOnce(
        Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
      );
      // sendRemoteMessage throws after triggering reconnection
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Connection lost');

      // Ensure reconnection attempt dial happened
      await vi.waitFor(() => {
        expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledTimes(2);
      });

      await vi.waitFor(() => {
        expect(mockReconnectionManager.stopReconnection).toHaveBeenCalledWith(
          'peer-1',
        );
      });
    });

    it('stops reconnection and clears queue when max attempts reached', async () => {
      // Drive reconnection state deterministically
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      // First call should return true (to enter loop), then false when checking after flush failure
      mockReconnectionManager.shouldRetry
        .mockReturnValueOnce(true) // Enter loop
        .mockReturnValueOnce(false); // Max attempts reached (checked after flush failure)
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });

      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.write.mockRejectedValue(
        Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
      );
      mockConnectionFactory.dialIdempotent
        .mockResolvedValueOnce(mockChannel) // initial connection
        .mockResolvedValue(mockChannel); // reconnection attempts (dial succeeds, flush fails)

      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      // First write fails (which establishes channel), triggering reconnection
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg1')),
      ).rejects.toThrow('Connection lost');

      // Second send also fails
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Connection lost');

      // Wait for reconnection to start and check max attempts
      await vi.waitFor(() => {
        expect(mockReconnectionManager.shouldRetry).toHaveBeenCalled();
        expect(mockReconnectionManager.stopReconnection).toHaveBeenCalledWith(
          'peer-1',
        );
      });

      await stop();
    });

    it('calls onRemoteGiveUp when max attempts reached', async () => {
      const onRemoteGiveUp = vi.fn();
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.shouldRetry
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false); // Max attempts reached (checked after flush failure)
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });

      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.write.mockRejectedValue(
        Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
      );
      mockConnectionFactory.dialIdempotent
        .mockResolvedValueOnce(mockChannel)
        .mockResolvedValue(mockChannel);

      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
        onRemoteGiveUp,
      );

      // Sends fail and trigger reconnection
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg1')),
      ).rejects.toThrow('Connection lost');
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Connection lost');

      await vi.waitFor(() => {
        expect(onRemoteGiveUp).toHaveBeenCalledWith('peer-1');
      });

      await stop();
    });

    it('respects maxRetryAttempts limit during reconnection', async () => {
      const maxRetryAttempts = 3;
      const onRemoteGiveUp = vi.fn();
      let attemptCount = 0;
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        attemptCount = 0; // Reset on start
        return true;
      });
      mockReconnectionManager.incrementAttempt.mockImplementation(() => {
        attemptCount += 1;
        return attemptCount;
      });
      mockReconnectionManager.shouldRetry.mockImplementation(
        (_peerId: string, maxAttempts: number) => {
          if (maxAttempts === 0) {
            return true;
          }
          // shouldRetry should return false when attemptCount >= maxAttempts
          return attemptCount < maxAttempts;
        },
      );
      mockReconnectionManager.calculateBackoff.mockReturnValue(0); // No delay for test
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });
      mockReconnectionManager.isPermanentlyFailed.mockReturnValue(false);

      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      // All dial attempts fail with retryable error
      mockConnectionFactory.dialIdempotent.mockRejectedValue(
        Object.assign(new Error('Connection failed'), { code: 'ECONNRESET' }),
      );

      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        { maxRetryAttempts },
        vi.fn(),
        onRemoteGiveUp,
      );

      // First send fails and triggers reconnection
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg1')),
      ).rejects.toThrow('Connection failed');

      // Wait for maxRetryAttempts to be reached
      await vi.waitFor(
        () => {
          // Should have called incrementAttempt exactly maxRetryAttempts times
          expect(
            mockReconnectionManager.incrementAttempt,
          ).toHaveBeenCalledTimes(maxRetryAttempts);
          // Should have stopped reconnection and called onRemoteGiveUp
          expect(mockReconnectionManager.stopReconnection).toHaveBeenCalledWith(
            'peer-1',
          );
          expect(onRemoteGiveUp).toHaveBeenCalledWith('peer-1');
        },
        { timeout: 10000 },
      );

      await stop();
    }, 10000);

    it('calls onRemoteGiveUp when non-retryable error occurs', async () => {
      const onRemoteGiveUp = vi.fn();
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.shouldRetry.mockReturnValue(true);
      mockReconnectionManager.incrementAttempt.mockReturnValue(1);
      mockReconnectionManager.calculateBackoff.mockReturnValue(0);
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });
      mockReconnectionManager.isPermanentlyFailed.mockReturnValue(false);

      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { isRetryableNetworkError } =
        await import('@metamask/kernel-errors');
      vi.mocked(isRetryableNetworkError).mockReturnValue(false);

      // Initial dial fails with retryable error, reconnection dial fails with non-retryable
      mockConnectionFactory.dialIdempotent
        .mockRejectedValueOnce(
          Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
        )
        .mockRejectedValueOnce(new Error('Non-retryable error'));

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
        onRemoteGiveUp,
      );

      // First send fails and triggers reconnection
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg1')),
      ).rejects.toThrow('Connection lost');

      await vi.waitFor(() => {
        expect(onRemoteGiveUp).toHaveBeenCalledWith('peer-1');
      });
    });

    it('resets backoff on successful message send', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      await sendRemoteMessage('peer-1', makeTestMessage('msg'));

      expect(mockReconnectionManager.resetBackoff).toHaveBeenCalledWith(
        'peer-1',
      );
    });

    it('resets backoff on successful message receive', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      await initTransport('0x1234', {}, vi.fn());

      const mockChannel = createMockChannel('inbound-peer');
      const messageBuffer = new TextEncoder().encode('inbound-msg');
      mockChannel.msgStream.read.mockResolvedValueOnce(messageBuffer);
      mockChannel.msgStream.read.mockReturnValue(
        new Promise<Uint8Array>(() => {
          /* Never resolves */
        }),
      );

      inboundHandler?.(mockChannel);

      await vi.waitFor(() => {
        expect(mockReconnectionManager.resetBackoff).toHaveBeenCalledWith(
          'inbound-peer',
        );
      });
    });
  });

  describe('connection management', () => {
    it('successful reconnection allows subsequent sends', async () => {
      // Drive reconnection state deterministically
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });
      mockReconnectionManager.shouldRetry.mockReturnValue(true);
      mockReconnectionManager.calculateBackoff.mockReturnValue(0);

      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.write.mockResolvedValue(undefined);
      mockConnectionFactory.dialIdempotent
        .mockResolvedValueOnce(mockChannel) // initial connection
        .mockResolvedValueOnce(mockChannel); // reconnection

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Establish channel
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Trigger reconnection via write failure
      mockChannel.msgStream.write.mockRejectedValueOnce(
        Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
      );
      // This send throws but triggers reconnection
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Connection lost');

      // Wait for reconnection to complete
      await vi.waitFor(() => {
        expect(mockReconnectionManager.stopReconnection).toHaveBeenCalledWith(
          'peer-1',
        );
      });

      // Reset write mock for successful send
      mockChannel.msgStream.write.mockResolvedValue(undefined);
      reconnecting = false;

      // After reconnection, new sends should work
      await sendRemoteMessage('peer-1', makeTestMessage('msg3'));
      expect(mockChannel.msgStream.write).toHaveBeenCalled();
    });

    it('triggers reconnection on write failure', async () => {
      // Drive reconnection state deterministically
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });
      mockReconnectionManager.shouldRetry.mockReturnValue(false); // Stop after first attempt

      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.write
        .mockResolvedValueOnce(undefined) // initial message
        .mockRejectedValueOnce(
          Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
        ); // triggers reconnection

      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Establish channel
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Trigger reconnection via write failure
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('msg2')),
      ).rejects.toThrow('Connection lost');

      // Should have triggered reconnection
      expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer-1',
      );
    });
  });

  describe('message size limits', () => {
    it('rejects messages exceeding size limit', async () => {
      const maxMessageSizeBytes = 1000; // 1KB limit for test
      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        { maxMessageSizeBytes },
        vi.fn(),
      );

      // Create a message that exceeds the limit
      const largeContent = 'x'.repeat(1500); // > 1KB
      const largeMessage = makeTestMessage(largeContent);

      await expect(sendRemoteMessage('peer-1', largeMessage)).rejects.toThrow(
        /Message size .* bytes exceeds limit of 1000 bytes/u,
      );

      // Should not attempt to dial
      expect(mockConnectionFactory.dialIdempotent).not.toHaveBeenCalled();
    });

    it('allows messages within size limit', async () => {
      const maxMessageSizeBytes = 10000; // 10KB limit
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        { maxMessageSizeBytes },
        vi.fn(),
      );

      // Create a message within the limit
      const smallContent = 'x'.repeat(100);
      const smallMessage = makeTestMessage(smallContent);

      await sendRemoteMessage('peer-1', smallMessage);

      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalled();
      expect(mockChannel.msgStream.write).toHaveBeenCalled();
    });

    it('uses default 1MB limit when not specified', async () => {
      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Create a message that exceeds 1MB
      const hugeContent = 'x'.repeat(1024 * 1024 + 100); // > 1MB
      const hugeMessage = makeTestMessage(hugeContent);

      await expect(sendRemoteMessage('peer-1', hugeMessage)).rejects.toThrow(
        /exceeds limit of 1048576 bytes/u,
      );
    });
  });

  describe('connection limits', () => {
    it('rejects new connections when limit is reached', async () => {
      const maxConcurrentConnections = 2;
      let channelCount = 0;
      mockConnectionFactory.dialIdempotent.mockImplementation(
        async (peerId: string) => {
          channelCount += 1;
          return createMockChannel(peerId);
        },
      );

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        { maxConcurrentConnections },
        vi.fn(),
      );

      // Establish connections up to the limit
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));
      await sendRemoteMessage('peer-2', makeTestMessage('msg2'));

      expect(channelCount).toBe(2);

      // Third connection should be rejected
      await expect(
        sendRemoteMessage('peer-3', makeTestMessage('msg3')),
      ).rejects.toThrow(
        /Connection limit reached: 2\/2 concurrent connections/u,
      );

      // Should not have attempted to dial the third peer
      expect(channelCount).toBe(2);
    });

    it('allows new connections after existing ones close', async () => {
      const maxConcurrentConnections = 2;
      const channels: MockChannel[] = [];
      mockConnectionFactory.dialIdempotent.mockImplementation(
        async (peerId: string) => {
          const channel = createMockChannel(peerId);
          channels.push(channel);
          return channel;
        },
      );

      const { sendRemoteMessage, closeConnection } = await initTransport(
        '0x1234',
        { maxConcurrentConnections },
        vi.fn(),
      );

      // Establish connections up to the limit
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));
      await sendRemoteMessage('peer-2', makeTestMessage('msg2'));

      expect(channels).toHaveLength(2);

      // Close peer-1 connection to free up a slot
      await closeConnection('peer-1');

      // Now we should be able to establish a new connection
      await sendRemoteMessage('peer-3', makeTestMessage('msg3'));
      expect(channels).toHaveLength(3);
    });

    it('rejects inbound connections when limit is reached', async () => {
      const maxConcurrentConnections = 2;
      mockConnectionFactory.dialIdempotent.mockImplementation(
        async (peerId: string) => createMockChannel(peerId),
      );

      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        { maxConcurrentConnections },
        vi.fn(),
      );

      // Establish connections up to the limit
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));
      await sendRemoteMessage('peer-2', makeTestMessage('msg2'));

      // Try inbound connection - should be rejected
      const inboundChannel = createMockChannel('peer-3');
      inboundHandler?.(inboundChannel);

      await vi.waitFor(() => {
        expect(mockLogger.log).toHaveBeenCalledWith(
          'peer-3:: rejecting inbound connection due to connection limit',
        );
        // Should close the channel to prevent resource leaks
        expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
          inboundChannel,
          'peer-3',
        );
      });

      // Should not have started reading from the rejected channel
      expect(inboundChannel.msgStream.read).not.toHaveBeenCalled();
    });

    it('uses default 100 connection limit when not specified', async () => {
      // This test just verifies the option is used - we won't actually create 100 connections
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Should be able to send (well under 100 connections)
      await sendRemoteMessage('peer-1', makeTestMessage('msg'));
      expect(mockChannel.msgStream.write).toHaveBeenCalled();
    });

    it('closes channel when connection limit exceeded after dial due to race condition', async () => {
      const maxConcurrentConnections = 1;
      const dialedChannels: MockChannel[] = [];

      // Track when dial completes so we can inject a race condition
      let resolveFirstDial: ((channel: MockChannel) => void) | undefined;
      const firstDialPromise = new Promise<MockChannel>((resolve) => {
        resolveFirstDial = resolve;
      });

      mockConnectionFactory.dialIdempotent.mockImplementation(
        async (peerId: string) => {
          const channel = createMockChannel(peerId);
          dialedChannels.push(channel);

          if (peerId === 'peer-1') {
            // First dial waits to be resolved manually
            return firstDialPromise;
          }
          // Second dial completes immediately
          return channel;
        },
      );

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        { maxConcurrentConnections },
        vi.fn(),
      );

      // Start first send (will wait at dial)
      const firstSendPromise = sendRemoteMessage(
        'peer-1',
        makeTestMessage('msg1'),
      );

      // Wait for first dial to start
      await vi.waitFor(() => {
        expect(dialedChannels).toHaveLength(1);
      });

      // Start and complete second send while first is still dialing
      // This establishes a connection, filling the limit
      await sendRemoteMessage('peer-2', makeTestMessage('msg2'));

      // Now complete the first dial - post-dial check should fail
      // because we're now at the connection limit
      resolveFirstDial?.(dialedChannels[0] as MockChannel);

      // First send should fail with connection limit error
      await expect(firstSendPromise).rejects.toThrow(
        /Connection limit reached/u,
      );

      // The channel from the first dial should have been closed to prevent leak
      expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
        dialedChannels[0],
        'peer-1',
      );
    });
  });

  describe('stale peer cleanup', () => {
    it('sets up cleanup interval with configured cleanupIntervalMs', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const cleanupIntervalMs = 5000;

      const { stop } = await initTransport(
        '0x1234',
        { cleanupIntervalMs },
        vi.fn(),
      );

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        cleanupIntervalMs,
      );

      await stop();
      setIntervalSpy.mockRestore();
    });

    it('clears cleanup interval on stop', async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const { stop } = await initTransport(
        '0x1234',
        { cleanupIntervalMs: 5000 },
        vi.fn(),
      );

      await stop();

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('uses default cleanup interval when not specified', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      const { stop } = await initTransport('0x1234', {}, vi.fn());

      // Default is 15 minutes (15 * 60 * 1000 = 900000ms)
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 900000);

      await stop();
      setIntervalSpy.mockRestore();
    });
  });

  describe('channel lifecycle', () => {
    it('closes previous channel when registering new one for same peer', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      const mockChannel1 = createMockChannel('peer-1');
      const mockChannel2 = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent
        .mockResolvedValueOnce(mockChannel1)
        .mockResolvedValueOnce(mockChannel2);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Establish first channel via outbound
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Simulate inbound connection from same peer (creates second channel)
      inboundHandler?.(mockChannel2);

      await vi.waitFor(() => {
        // Should have closed the previous channel
        expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
          mockChannel1,
          'peer-1',
        );
      });
    });

    it('reuses existing channel when dial race occurs', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // First send establishes channel
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Second send should reuse existing channel (no new dial)
      await sendRemoteMessage('peer-1', makeTestMessage('msg2'));

      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledTimes(1);
      expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(2);
    });

    it('handles concurrent inbound and outbound connection', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler) => {
          inboundHandler = handler;
        },
      );

      const outboundChannel = createMockChannel('peer-1');
      const inboundChannel = createMockChannel('peer-1');

      // Make dial slow to allow inbound to arrive during dial
      mockConnectionFactory.dialIdempotent.mockImplementation(async () => {
        // Simulate inbound arriving during dial
        inboundHandler?.(inboundChannel);
        await new Promise((resolve) => setImmediate(resolve));
        return outboundChannel;
      });

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // The outbound channel should have been closed since inbound arrived first
      await vi.waitFor(() => {
        expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
          outboundChannel,
          'peer-1',
        );
      });
    });

    it('attaches close event listener to underlying stream', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      expect(mockChannel.stream.addEventListener).toHaveBeenCalledWith(
        'close',
        expect.any(Function),
        { once: true },
      );

      await stop();
    });

    it('sets default inactivityTimeout on stream when registering channel', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      expect(mockChannel.stream.inactivityTimeout).toBe(120_000);

      await stop();
    });

    it('uses custom streamInactivityTimeoutMs when provided', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        { streamInactivityTimeoutMs: 5_000 },
        vi.fn(),
      );

      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      expect(mockChannel.stream.inactivityTimeout).toBe(5_000);

      await stop();
    });

    it.each([
      {
        scenario: 'local close without error',
        event: { local: true },
        expectedLog: 'peer-1:: stream closed locally',
      },
      {
        scenario: 'local close with error',
        event: { local: true, error: new Error('write timeout') },
        expectedLog: 'peer-1:: stream closed locally: write timeout',
      },
      {
        scenario: 'remote close with error',
        event: { local: false, error: new Error('connection reset') },
        expectedLog: 'peer-1:: stream reset by remote: connection reset',
      },
      {
        scenario: 'remote clean close',
        event: {},
        expectedLog: 'peer-1:: stream closed by remote (clean)',
      },
    ])('logs $scenario via close event', async ({ event, expectedLog }) => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Get the close event listener that was attached
      const closeListener = mockChannel.stream.addEventListener.mock
        .calls[0]?.[1] as (evt: Event) => void;

      // Fire the close event
      mockLogger.log.mockClear();
      closeListener(event as unknown as Event);

      expect(mockLogger.log).toHaveBeenCalledWith(expectedLog);

      await stop();
    });

    it('updates lastConnectionTime on each message send', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage, stop } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
      );

      // Send first message - establishes channel and updates lastConnectionTime
      await sendRemoteMessage('peer-1', makeTestMessage('msg1'));

      // Send second message - should also update lastConnectionTime
      await sendRemoteMessage('peer-1', makeTestMessage('msg2'));

      // Both writes should have completed successfully
      expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(2);

      await stop();
    });
  });

  describe('message send timeout', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('times out after 10 seconds when write hangs', async () => {
      const mockChannel = createMockChannel('peer-1');
      // Make write never resolve to simulate a hang
      mockChannel.msgStream.write.mockReturnValue(
        new Promise<void>(() => {
          /* Never resolves */
        }),
      );
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      // Track all created abort signals so we can trigger abort manually
      const mockSignals: ReturnType<typeof makeAbortSignalMock>[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        const signal = makeAbortSignalMock(ms);
        mockSignals.push(signal);
        return signal;
      });

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      const sendPromise = sendRemoteMessage(
        'peer-1',
        makeTestMessage('test message'),
      );

      // Wait for the write to be initiated
      await vi.waitFor(() => {
        expect(mockChannel.msgStream.write).toHaveBeenCalled();
      });

      // Manually trigger the abort on the signal to simulate timeout
      for (const signal of mockSignals) {
        signal.abort();
      }

      // sendRemoteMessage should reject with timeout error
      await expect(sendPromise).rejects.toThrow('Message send timed out');
    });

    it('does not timeout if write completes before timeout', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockChannel.msgStream.write.mockResolvedValue(undefined);
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      let mockSignal: ReturnType<typeof makeAbortSignalMock> | undefined;
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        mockSignal = makeAbortSignalMock(ms);
        return mockSignal;
      });

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Write resolves immediately, so promise should resolve (not reject)
      await sendRemoteMessage('peer-1', makeTestMessage('test message'));

      // Verify timeout signal was not aborted
      expect(mockSignal?.aborted).toBe(false);
    });

    it('handles timeout errors and triggers connection loss handling', async () => {
      const mockChannel = createMockChannel('peer-1');
      // Make write never resolve to simulate a hang
      mockChannel.msgStream.write.mockReturnValue(
        new Promise<void>(() => {
          /* Never resolves */
        }),
      );
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      // Track all created abort signals so we can trigger abort manually
      const mockSignals: ReturnType<typeof makeAbortSignalMock>[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        const signal = makeAbortSignalMock(ms);
        mockSignals.push(signal);
        return signal;
      });

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      const sendPromise = sendRemoteMessage(
        'peer-1',
        makeTestMessage('test message'),
      );

      // Wait for the write to be initiated
      await vi.waitFor(() => {
        expect(mockChannel.msgStream.write).toHaveBeenCalled();
      });

      // Manually trigger the abort on the signal to simulate timeout
      for (const signal of mockSignals) {
        signal.abort();
      }

      // Wait for the promise to reject
      await expect(sendPromise).rejects.toThrow('Message send timed out');

      // Verify that connection loss handling was triggered
      expect(mockReconnectionManager.startReconnection).toHaveBeenCalledWith(
        'peer-1',
      );
    });

    it('propagates write errors that occur before timeout', async () => {
      // Ensure isReconnecting returns false so we actually call writeWithTimeout
      mockReconnectionManager.isReconnecting.mockReturnValue(false);

      const mockChannel = createMockChannel('peer-1');
      const writeError = new Error('Write failed');
      mockChannel.msgStream.write.mockRejectedValue(writeError);
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // sendRemoteMessage throws the write error
      await expect(
        sendRemoteMessage('peer-1', makeTestMessage('test message')),
      ).rejects.toThrow('Write failed');

      // Verify that connection loss handling was triggered
      expect(mockReconnectionManager.startReconnection).toHaveBeenCalled();
    });

    it('writeWithTimeout uses AbortSignal.timeout with 10 second default', async () => {
      const mockChannel = createMockChannel('peer-1');
      // Make write resolve immediately to avoid timeout
      mockChannel.msgStream.write.mockResolvedValue(undefined);
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      let mockSignal: ReturnType<typeof makeAbortSignalMock> | undefined;
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        mockSignal = makeAbortSignalMock(ms);
        return mockSignal;
      });

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      await sendRemoteMessage('peer-1', makeTestMessage('test message'));

      // Verify AbortSignal.timeout was called with 10 seconds (default)
      expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
      expect(mockSignal?.timeoutMs).toBe(10_000);
    });

    it('error message includes correct timeout duration', async () => {
      const mockChannel = createMockChannel('peer-1');
      // Make write never resolve to simulate a hang
      mockChannel.msgStream.write.mockReturnValue(
        new Promise<void>(() => {
          /* Never resolves */
        }),
      );
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      // Track all created abort signals so we can trigger abort manually
      const mockSignals: ReturnType<typeof makeAbortSignalMock>[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        const signal = makeAbortSignalMock(ms);
        mockSignals.push(signal);
        return signal;
      });

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      const sendPromise = sendRemoteMessage(
        'peer-1',
        makeTestMessage('test message'),
      );

      // Wait for the write to be initiated
      await vi.waitFor(() => {
        expect(mockChannel.msgStream.write).toHaveBeenCalled();
      });

      // Manually trigger the abort on the signal to simulate timeout
      for (const signal of mockSignals) {
        signal.abort();
      }

      // Verify error message includes the correct timeout duration (10000ms)
      await expect(sendPromise).rejects.toThrow('10000ms');
    });

    it('handles multiple concurrent writes with timeout', async () => {
      const mockChannel = createMockChannel('peer-1');
      // Make write never resolve to simulate a hang
      mockChannel.msgStream.write.mockReturnValue(
        new Promise<void>(() => {
          /* Never resolves */
        }),
      );
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      // Track all created abort signals so we can trigger abort manually
      const mockSignals: ReturnType<typeof makeAbortSignalMock>[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        const signal = makeAbortSignalMock(ms);
        mockSignals.push(signal);
        return signal;
      });

      const { sendRemoteMessage } = await initTransport('0x1234', {}, vi.fn());

      // Send multiple messages concurrently
      const sendPromise1 = sendRemoteMessage(
        'peer-1',
        makeTestMessage('message 1'),
      );
      const sendPromise2 = sendRemoteMessage(
        'peer-1',
        makeTestMessage('message 2'),
      );

      // Wait for writes to be initiated
      await vi.waitFor(() => {
        expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(2);
      });

      // Manually trigger the abort on all signals to simulate timeout
      for (const signal of mockSignals) {
        signal.abort();
      }

      // Both promises should reject with timeout error
      await expect(sendPromise1).rejects.toThrow('Message send timed out');
      await expect(sendPromise2).rejects.toThrow('Message send timed out');

      // Verify that each write got its own timeout signal
      expect(mockSignals.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('handshake protocol', () => {
    it('sends handshake on outbound connection and waits for ack', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);

      const localIncarnationId = 'test-incarnation-id';
      // Mock read to return handshakeAck for the outbound handshake
      const handshakeAck = JSON.stringify({
        method: 'handshakeAck',
        params: { incarnationId: 'remote-incarnation-id' },
      });
      mockChannel.msgStream.read
        .mockResolvedValueOnce(new TextEncoder().encode(handshakeAck))
        .mockReturnValue(
          new Promise<Uint8Array | undefined>(() => {
            /* Never resolves - normal read loop */
          }),
        );

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
        undefined, // onRemoteGiveUp
        localIncarnationId,
      );

      // Send a message to establish outbound connection
      await sendRemoteMessage('peer-1', makeTestMessage('hello'));

      // Verify handshake was sent (first write)
      expect(mockChannel.msgStream.write).toHaveBeenCalled();
      const { calls } = mockChannel.msgStream.write.mock;
      const firstWrite = new TextDecoder().decode(calls[0]?.[0] as Uint8Array);
      const handshakeMsg = JSON.parse(firstWrite);
      expect(handshakeMsg).toStrictEqual({
        method: 'handshake',
        params: { incarnationId: localIncarnationId },
      });

      // Second write should be the actual message
      const secondWrite = new TextDecoder().decode(calls[1]?.[0] as Uint8Array);
      expect(secondWrite).toContain('hello');
    });

    it('sends one handshake and starts one read loop when concurrent sends share a dial', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);
      const handshakeAck = JSON.stringify({
        method: 'handshakeAck',
        params: { incarnationId: 'remote-incarnation-id' },
      });
      mockChannel.msgStream.read
        .mockResolvedValueOnce(new TextEncoder().encode(handshakeAck))
        .mockReturnValue(
          new Promise<Uint8Array | undefined>(() => {
            /* Never resolves - normal read loop */
          }),
        );

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        { handshakeTimeoutMs: 50 },
        vi.fn(),
        undefined, // onRemoteGiveUp
        'test-incarnation-id',
      );

      await Promise.all([
        sendRemoteMessage('peer-1', makeTestMessage('first')),
        sendRemoteMessage('peer-1', makeTestMessage('second')),
      ]);

      const writtenMethods = mockChannel.msgStream.write.mock.calls.map(
        ([bytes]) =>
          JSON.parse(new TextDecoder().decode(bytes as Uint8Array)).method,
      );
      expect(writtenMethods).toStrictEqual(['handshake', 'deliver', 'deliver']);
      // The handshake's read, then a single read loop.
      expect(mockChannel.msgStream.read).toHaveBeenCalledTimes(2);
    });

    it.each([
      { outcome: 'fails', reply: 'handshake', restart: false },
      { outcome: 'reports a restart', reply: 'handshakeAck', restart: true },
    ])(
      'gives concurrent sends the outcome of a shared handshake that $outcome',
      async ({ reply, restart }) => {
        const mockChannel = createMockChannel('peer-1');
        mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);
        mockChannel.msgStream.read.mockResolvedValueOnce(
          new TextEncoder().encode(
            JSON.stringify({
              method: reply,
              params: { incarnationId: 'remote-incarnation-id' },
            }),
          ),
        );
        const onIncarnationChange = vi.fn().mockResolvedValue(restart);

        const { sendRemoteMessage } = await initTransport(
          '0x1234',
          { handshakeTimeoutMs: 50 },
          vi.fn(),
          undefined, // onRemoteGiveUp
          'test-incarnation-id',
          onIncarnationChange,
        );

        const sends = [
          sendRemoteMessage('peer-1', makeTestMessage('first')),
          sendRemoteMessage('peer-1', makeTestMessage('second')),
        ];
        await Promise.allSettled(sends);

        const error = restart ? /Remote peer restarted/u : 'Handshake failed';
        for (const send of sends) {
          await expect(send).rejects.toThrow(error);
        }
        const writtenMethods = mockChannel.msgStream.write.mock.calls.map(
          ([bytes]) =>
            JSON.parse(new TextDecoder().decode(bytes as Uint8Array)).method,
        );
        expect(writtenMethods).toStrictEqual(['handshake']);
        expect(mockChannel.msgStream.read).toHaveBeenCalledTimes(1);
        expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
          mockChannel,
          'peer-1',
        );
        expect(onIncarnationChange).toHaveBeenCalledTimes(restart ? 1 : 0);
      },
    );

    it('does not send handshake when no incarnationId provided', async () => {
      const mockChannel = createMockChannel('peer-1');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);
      // No handshake means no need to mock handshakeAck read
      mockChannel.msgStream.read.mockReturnValue(
        new Promise<Uint8Array | undefined>(() => {
          /* Never resolves */
        }),
      );

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        {},
        vi.fn(),
        undefined, // onRemoteGiveUp
        undefined, // no incarnationId
      );

      await sendRemoteMessage('peer-1', makeTestMessage('hello'));

      // Should only have the actual message, no handshake
      expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(1);
      const writeCall = new TextDecoder().decode(
        mockChannel.msgStream.write.mock.calls[0]?.[0] as Uint8Array,
      );
      const parsedMsg = JSON.parse(writeCall);
      expect(parsedMsg.method).not.toBe('handshake');
    });

    it('handles incoming handshake and replies with handshakeAck', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler: (channel: MockChannel) => void) => {
          inboundHandler = handler;
        },
      );

      const remoteMessageHandler = vi.fn().mockResolvedValue('');
      const localIncarnationId = 'local-incarnation';
      await initTransport(
        '0x1234',
        {},
        remoteMessageHandler,
        undefined,
        localIncarnationId,
      );

      // Create mock inbound channel - first read is handshake, then regular messages
      const mockInboundChannel = createMockChannel('remote-peer');
      const handshakeMessage = JSON.stringify({
        method: 'handshake',
        params: { incarnationId: 'remote-incarnation' },
      });
      const regularMessage = makeTestMessage('hello');
      mockInboundChannel.msgStream.read
        .mockResolvedValueOnce(new TextEncoder().encode(handshakeMessage))
        .mockResolvedValueOnce(new TextEncoder().encode(regularMessage))
        .mockReturnValue(
          new Promise<Uint8Array | undefined>(() => {
            /* Never resolves */
          }),
        );

      // Trigger inbound connection
      inboundHandler?.(mockInboundChannel);

      // Wait for handshake to be processed and ack to be sent
      await vi.waitFor(() => {
        expect(mockLogger.log).toHaveBeenCalledWith(
          expect.stringContaining('received handshake'),
        );
      });

      // Verify handshakeAck was sent
      await vi.waitFor(() => {
        expect(mockInboundChannel.msgStream.write).toHaveBeenCalled();
      });
      const ackWrite = new TextDecoder().decode(
        mockInboundChannel.msgStream.write.mock.calls[0]?.[0] as Uint8Array,
      );
      const ackMsg = JSON.parse(ackWrite);
      expect(ackMsg).toStrictEqual({
        method: 'handshakeAck',
        params: { incarnationId: localIncarnationId },
      });

      // Regular message after handshake should be passed to handler
      await vi.waitFor(() => {
        expect(remoteMessageHandler).toHaveBeenCalledWith(
          'remote-peer',
          regularMessage,
        );
      });
    });

    it('rejects inbound connection when handshake fails', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler: (channel: MockChannel) => void) => {
          inboundHandler = handler;
        },
      );

      const localIncarnationId = 'local-incarnation';
      await initTransport('0x1234', {}, vi.fn(), undefined, localIncarnationId);

      // Create mock inbound channel that sends wrong message type
      const mockInboundChannel = createMockChannel('remote-peer');
      const wrongMessage = JSON.stringify({
        method: 'handshakeAck', // Wrong! Should be handshake for inbound
        params: { incarnationId: 'remote-incarnation' },
      });
      mockInboundChannel.msgStream.read.mockResolvedValueOnce(
        new TextEncoder().encode(wrongMessage),
      );

      // Trigger inbound connection
      inboundHandler?.(mockInboundChannel);

      // Wait for the channel to be closed: handshake failure + rejected
      // restart both close the channel without registering it.
      await vi.waitFor(() => {
        expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
          mockInboundChannel,
          'remote-peer',
        );
      });
    });

    it('reports the observed incarnation to onIncarnationChange after every handshake', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler: (channel: MockChannel) => void) => {
          inboundHandler = handler;
        },
      );

      const onIncarnationChange = vi.fn();
      const localIncarnationId = 'local-incarnation';
      await initTransport(
        '0x1234',
        {},
        vi.fn().mockResolvedValue(''),
        undefined, // onRemoteGiveUp
        localIncarnationId,
        onIncarnationChange,
      );

      // First handshake from remote peer
      const mockInboundChannel1 = createMockChannel('remote-peer');
      const handshakeMessage1 = JSON.stringify({
        method: 'handshake',
        params: { incarnationId: 'incarnation-1' },
      });
      mockInboundChannel1.msgStream.read
        .mockResolvedValueOnce(new TextEncoder().encode(handshakeMessage1))
        .mockReturnValue(
          new Promise<Uint8Array | undefined>(() => {
            /* Never resolves */
          }),
        );

      inboundHandler?.(mockInboundChannel1);

      // Fires on every successful handshake — the kernel layer is the
      // authoritative comparator against persisted state.
      await vi.waitFor(() => {
        expect(onIncarnationChange).toHaveBeenCalledWith(
          'remote-peer',
          'incarnation-1',
        );
      });
      expect(onIncarnationChange).toHaveBeenCalledTimes(1);

      // Second handshake with different incarnation (simulating peer restart)
      const mockInboundChannel2 = createMockChannel('remote-peer');
      const handshakeMessage2 = JSON.stringify({
        method: 'handshake',
        params: { incarnationId: 'incarnation-2' },
      });
      mockInboundChannel2.msgStream.read
        .mockResolvedValueOnce(new TextEncoder().encode(handshakeMessage2))
        .mockReturnValue(
          new Promise<Uint8Array | undefined>(() => {
            /* Never resolves */
          }),
        );

      inboundHandler?.(mockInboundChannel2);

      await vi.waitFor(() => {
        expect(onIncarnationChange).toHaveBeenCalledWith(
          'remote-peer',
          'incarnation-2',
        );
      });
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('incarnation changed'),
      );
    });

    it('closes the dialed channel and throws PeerRestartedError when outbound handshake reports kernel-detected restart', async () => {
      const localIncarnationId = 'local-incarnation';
      // Kernel verdict says "yes, restart" — overrides PSM's first-contact
      // verdict and must trigger the close-without-register path.
      const onIncarnationChange = vi.fn().mockResolvedValue(true);

      const mockChannel = createMockChannel('remote-peer');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);
      const handshakeAck = JSON.stringify({
        method: 'handshakeAck',
        params: { incarnationId: 'remote-incarnation' },
      });
      mockChannel.msgStream.read.mockResolvedValueOnce(
        new TextEncoder().encode(handshakeAck),
      );

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        {},
        vi.fn().mockResolvedValue(''),
        undefined,
        localIncarnationId,
        onIncarnationChange,
      );

      await expect(
        sendRemoteMessage('remote-peer', makeTestMessage('hi')),
      ).rejects.toThrow(/Remote peer restarted/u);

      // The throw must happen AFTER closeChannel and the channel must
      // never be registered (no readChannel started).
      expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
        mockChannel,
        'remote-peer',
      );
      // Without registration the readChannel side never starts; verify by
      // confirming no further reads were attempted on the channel.
      expect(mockChannel.msgStream.read).toHaveBeenCalledTimes(1);
    });

    it('does not trigger reconnection when PeerRestartedError aborts the outbound send', async () => {
      // PeerRestartedError means the peer is reachable but its incarnation
      // changed; handleConnectionLoss would clobber an inbound channel a
      // concurrent handshake just registered, so the catch path must skip it.
      const localIncarnationId = 'local-incarnation';
      const onIncarnationChange = vi.fn().mockResolvedValue(true);

      const mockChannel = createMockChannel('remote-peer');
      mockConnectionFactory.dialIdempotent.mockResolvedValue(mockChannel);
      const handshakeAck = JSON.stringify({
        method: 'handshakeAck',
        params: { incarnationId: 'remote-incarnation' },
      });
      mockChannel.msgStream.read.mockResolvedValueOnce(
        new TextEncoder().encode(handshakeAck),
      );

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        {},
        vi.fn().mockResolvedValue(''),
        undefined,
        localIncarnationId,
        onIncarnationChange,
      );

      await expect(
        sendRemoteMessage('remote-peer', makeTestMessage('hi')),
      ).rejects.toThrow(/Remote peer restarted/u);

      // Drain microtasks so any reconnection scheduling would have fired.
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      // No reconnect attempt: dialIdempotent is only the original dial.
      expect(mockConnectionFactory.dialIdempotent).toHaveBeenCalledTimes(1);
    });

    it('spends no reconnection attempt on a restart the kernel reports again', async () => {
      let reconnecting = false;
      mockReconnectionManager.isReconnecting.mockImplementation(
        () => reconnecting,
      );
      mockReconnectionManager.startReconnection.mockImplementation(() => {
        reconnecting = true;
        return true;
      });
      mockReconnectionManager.stopReconnection.mockImplementation(() => {
        reconnecting = false;
      });
      mockReconnectionManager.calculateBackoff.mockReturnValue(0);
      const { abortableDelay } = await import('@metamask/kernel-utils');
      (abortableDelay as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const handshakeAck = new TextEncoder().encode(
        JSON.stringify({
          method: 'handshakeAck',
          params: { incarnationId: 'remote-incarnation' },
        }),
      );
      const makeAckingChannel = (): MockChannel => {
        const channel = createMockChannel('remote-peer');
        channel.msgStream.read.mockResolvedValueOnce(handshakeAck);
        return channel;
      };
      const firstChannel = makeAckingChannel();
      firstChannel.msgStream.write
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
        );
      mockConnectionFactory.dialIdempotent
        .mockResolvedValueOnce(firstChannel)
        .mockResolvedValueOnce(makeAckingChannel())
        .mockResolvedValueOnce(makeAckingChannel())
        .mockResolvedValueOnce(makeAckingChannel());
      // The kernel reports a restart on every handshake until its crank
      // records it.
      const onIncarnationChange = vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false);

      const { sendRemoteMessage } = await initTransport(
        '0x1234',
        { maxRetryAttempts: 3 },
        vi.fn().mockResolvedValue(''),
        undefined,
        'local-incarnation',
        onIncarnationChange,
      );

      await expect(
        sendRemoteMessage('remote-peer', makeTestMessage('lost')),
      ).rejects.toThrow('Connection lost');

      await vi.waitFor(() => {
        expect(mockReconnectionManager.stopReconnection).toHaveBeenCalledWith(
          'remote-peer',
        );
      });
      expect(onIncarnationChange).toHaveBeenCalledTimes(4);
      expect(
        mockReconnectionManager.shouldRetry.mock.calls.map(
          ([, budget]) => budget,
        ),
      ).toStrictEqual([3, 3, 4]);
    });

    it('rejects the inbound channel when kernel detects a restart on inbound handshake', async () => {
      // Symmetric with the outbound PeerRestartedError path: when the
      // receiver's persisted incarnation differs from the observed one,
      // the channel must NOT be registered — otherwise concurrent in-flight
      // outbound sends could write pre-restart payloads on a fresh channel.
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler: (channel: MockChannel) => void) => {
          inboundHandler = handler;
        },
      );
      const onIncarnationChange = vi.fn().mockResolvedValue(true);
      const localIncarnationId = 'local-incarnation';
      await initTransport(
        '0x1234',
        {},
        vi.fn().mockResolvedValue(''),
        undefined,
        localIncarnationId,
        onIncarnationChange,
      );

      const inbound = createMockChannel('remote-peer');
      inbound.msgStream.read.mockResolvedValueOnce(
        new TextEncoder().encode(
          JSON.stringify({
            method: 'handshake',
            params: { incarnationId: 'fresh-incarnation' },
          }),
        ),
      );
      inboundHandler?.(inbound);

      await vi.waitFor(() => {
        expect(mockConnectionFactory.closeChannel).toHaveBeenCalledWith(
          inbound,
          'remote-peer',
        );
      });
      // No further reads on the channel — registerChannel never ran.
      expect(inbound.msgStream.read).toHaveBeenCalledTimes(1);
    });

    it('passes regular messages to remoteMessageHandler after handshake', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler: (channel: MockChannel) => void) => {
          inboundHandler = handler;
        },
      );

      const remoteMessageHandler = vi.fn().mockResolvedValue('');
      const localIncarnationId = 'local-incarnation';
      await initTransport(
        '0x1234',
        {},
        remoteMessageHandler,
        undefined,
        localIncarnationId,
      );

      // Create mock inbound channel - handshake first, then regular message
      const mockInboundChannel = createMockChannel('remote-peer');
      const handshakeMessage = JSON.stringify({
        method: 'handshake',
        params: { incarnationId: 'remote-incarnation' },
      });
      const regularMessage = makeTestMessage('hello');
      mockInboundChannel.msgStream.read
        .mockResolvedValueOnce(new TextEncoder().encode(handshakeMessage))
        .mockResolvedValueOnce(new TextEncoder().encode(regularMessage))
        .mockReturnValue(
          new Promise<Uint8Array | undefined>(() => {
            /* Never resolves */
          }),
        );

      inboundHandler?.(mockInboundChannel);

      // Wait for message to be processed
      await vi.waitFor(() => {
        expect(remoteMessageHandler).toHaveBeenCalledWith(
          'remote-peer',
          regularMessage,
        );
      });
    });

    it('skips handshake when no incarnationId and accepts inbound messages directly', async () => {
      let inboundHandler: ((channel: MockChannel) => void) | undefined;
      mockConnectionFactory.onInboundConnection.mockImplementation(
        (handler: (channel: MockChannel) => void) => {
          inboundHandler = handler;
        },
      );

      const remoteMessageHandler = vi.fn().mockResolvedValue('');
      // No incarnationId - handshake should be skipped
      await initTransport(
        '0x1234',
        {},
        remoteMessageHandler,
        undefined,
        undefined, // no incarnationId
      );

      // Create mock inbound channel with regular message directly (no handshake)
      const mockInboundChannel = createMockChannel('remote-peer');
      const regularMessage = makeTestMessage('hello');
      mockInboundChannel.msgStream.read
        .mockResolvedValueOnce(new TextEncoder().encode(regularMessage))
        .mockReturnValue(
          new Promise<Uint8Array | undefined>(() => {
            /* Never resolves */
          }),
        );

      inboundHandler?.(mockInboundChannel);

      // Wait for message to be processed directly
      await vi.waitFor(() => {
        expect(remoteMessageHandler).toHaveBeenCalledWith(
          'remote-peer',
          regularMessage,
        );
      });

      // No handshakeAck should be sent
      expect(mockInboundChannel.msgStream.write).not.toHaveBeenCalled();
    });
  });
});
