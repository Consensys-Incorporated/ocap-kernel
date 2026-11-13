import { MuxerClosedError } from '@libp2p/interface';
import { AbortError } from '@metamask/kernel-errors';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { Channel } from '../types.ts';

// Mock heavy/libp2p related deps with minimal shims we can assert against.

// Track state shared between mocks and tests
type MockConnection = {
  remotePeer: { toString: () => string };
  direct: boolean;
};

const libp2pState: {
  handler?:
    | ((stream: object, connection: MockConnection) => void | Promise<void>)
    | undefined;
  dials: {
    addr: string;
    protocol: string;
    options: { signal: AbortSignal };
    stream: object;
  }[];
  stopCalled: boolean;
  startCalled: boolean;
  eventListeners: Record<string, ((evt: { detail: unknown }) => void)[]>;
} = { dials: [], stopCalled: false, startCalled: false, eventListeners: {} };

vi.mock('@chainsafe/libp2p-noise', () => ({ noise: () => ({}) }));
vi.mock('@chainsafe/libp2p-yamux', () => ({ yamux: () => ({}) }));
vi.mock('@libp2p/bootstrap', () => ({ bootstrap: () => ({}) }));
vi.mock('@libp2p/circuit-relay-v2', () => ({
  circuitRelayTransport: () => ({}),
}));
vi.mock('@libp2p/identify', () => ({ identify: () => ({}) }));
vi.mock('@libp2p/webrtc', () => ({ webRTC: () => ({}) }));
vi.mock('@libp2p/websockets', () => ({ webSockets: () => ({}) }));
vi.mock('@libp2p/webtransport', () => ({ webTransport: () => ({}) }));
vi.mock('@libp2p/ping', () => ({ ping: () => ({}) }));

const generateKeyPairFromSeed = vi.fn(async () => ({/* private key */}));
vi.mock('@libp2p/crypto/keys', () => ({
  generateKeyPairFromSeed,
}));

type CalculateReconnectionBackoffOptions = Readonly<{
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}>;

function calculateReconnectionBackoff(
  attempt: number,
  opts?: CalculateReconnectionBackoffOptions,
): number {
  const base = Math.max(1, opts?.baseDelayMs ?? 500);
  const cap = Math.max(base, opts?.maxDelayMs ?? 10_000);
  const pow = Math.max(0, attempt - 1);
  const raw = Math.min(cap, base * Math.pow(2, pow));
  const useJitter = opts?.jitter !== false;
  if (useJitter) {
    // In production this uses Math.random(), but under SES lockdown Math.random
    // may be non-configurable, making it hard to mock in tests. Use a stable
    // deterministic value within the expected jitter range instead.
    return Math.floor(raw / 2);
  }
  return raw;
}

vi.mock('@metamask/kernel-utils', () => ({
  fromHex: (_hex: string) => new Uint8Array(_hex.length / 2),
  calculateReconnectionBackoff,
  retryWithBackoff: async <OperationResult>(
    operation: () => Promise<OperationResult>,
    options?: {
      jitter?: boolean;
      shouldRetry?: (error: unknown) => boolean;
      onRetry?: (info: {
        attempt: number;
        maxAttempts?: number;
        delayMs: number;
      }) => void;
      signal?: AbortSignal;
    },
  ) => {
    // Simple implementation that tries once, then calls onRetry and tries again
    try {
      return await operation();
    } catch (error) {
      if (options?.shouldRetry?.(error)) {
        options?.onRetry?.({ attempt: 1, maxAttempts: 3, delayMs: 100 });
        return await operation();
      }
      throw error;
    }
  },
}));

vi.mock('@metamask/kernel-errors', () => ({
  AbortError: class MockAbortError extends Error {
    constructor() {
      super('Operation aborted');
      this.name = 'AbortError';
    }
  },
  isRetryableNetworkError: (error: unknown) => {
    const networkError = error as Error & { code?: string };
    return (
      networkError.code === 'ECONNRESET' || networkError.code === 'ETIMEDOUT'
    );
  },
}));

const mockLoggerLog = vi.fn();
const mockLoggerError = vi.fn();

const mockLoggerWarn = vi.fn();

vi.mock('@metamask/logger', () => ({
  Logger: class {
    log = mockLoggerLog;

    warn = mockLoggerWarn;

    error = mockLoggerError;
  },
}));

/** Protocol codes matching @multiformats/multiaddr v13 */
const PROTO_CODES: Record<string, number> = {
  ip4: 4,
  ip6: 41,
  tcp: 6,
  udp: 273,
  dns4: 54,
  dns6: 55,
  dnsaddr: 56,
  ws: 477,
  wss: 478,
  tls: 448,
  p2p: 421,
  'p2p-circuit': 290,
  webrtc: 281,
  'quic-v1': 461,
  webtransport: 465,
};

vi.mock('@multiformats/multiaddr', () => ({
  CODE_P2P: 421,
  CODE_IP4: 4,
  CODE_IP6: 41,
  CODE_DNS4: 54,
  CODE_DNS6: 55,
  CODE_DNSADDR: 56,
  multiaddr: (addr: string) => {
    // Real multiaddr() throws on malformed addresses
    if (!addr.startsWith('/')) {
      throw new Error(`invalid multiaddr "${addr}"`);
    }
    // Parse segments into components
    const segments = addr.split('/').filter(Boolean);
    const components: { code: number; name: string; value?: string }[] = [];
    const valuedProtos = new Set([
      'ip4',
      'ip6',
      'tcp',
      'udp',
      'dns4',
      'dns6',
      'dnsaddr',
      'p2p',
    ]);
    let idx = 0;
    while (idx < segments.length) {
      const name = segments[idx]!;
      const code = PROTO_CODES[name];
      if (code === undefined) {
        idx += 1;
        continue;
      }
      if (valuedProtos.has(name) && idx + 1 < segments.length) {
        components.push({ code, name, value: segments[idx + 1]! });
        idx += 2;
      } else {
        components.push({ code, name });
        idx += 1;
      }
    }
    return {
      toString: () => addr,
      getComponents: () => components,
    };
  },
}));

/**
 * Build a minimal Multiaddr-like object for connectionGater tests.
 *
 * @param protoNames - The protocol names in the multiaddr.
 * @param host - The host component.
 * @returns A minimal Multiaddr-shaped object.
 */
function makeTestMultiaddr(protoNames: string[], host: string) {
  // Build components: first component is the host (ip4/ip6/dns4/dns6)
  const hostProto = protoNames.find((proto) =>
    ['ip4', 'ip6', 'dns4', 'dns6', 'dnsaddr'].includes(proto),
  );
  const components = protoNames.map((name) => {
    const code = PROTO_CODES[name] ?? 0;
    if (name === hostProto) {
      return { code, name, value: host };
    }
    return { code, name };
  });
  return {
    getComponents: () => components,
  };
}

// Simple LengthPrefixedStream mock
type MockByteStream = {
  write: (chunk: Uint8Array) => Promise<void>;
  read: () => Promise<Uint8Array | undefined>;
  writes: Uint8Array[];
};

const streamMap = new WeakMap<object, MockByteStream>();
vi.mock('@libp2p/utils', () => ({
  lpStream: (stream: object) => {
    const bs: MockByteStream = {
      writes: [],
      async write(chunk: Uint8Array) {
        bs.writes.push(chunk);
      },
      async read() {
        return undefined;
      },
    };
    streamMap.set(stream, bs);
    return bs;
  },
  getByteStreamFor: (stream: object) => streamMap.get(stream),
  InvalidDataLengthError: class InvalidDataLengthError extends Error {},
  InvalidDataLengthLengthError: class InvalidDataLengthLengthError extends Error {},
  UnexpectedEOFError: class UnexpectedEOFError extends Error {},
}));

const createLibp2p = vi.fn();
vi.mock('libp2p', () => ({
  createLibp2p,
}));

describe('ConnectionFactory', () => {
  let factory: Awaited<
    ReturnType<typeof import('./connection-factory.ts').ConnectionFactory.make>
  >;
  const keySeed = '0x1234567890abcdef';
  const knownRelays = [
    '/dns4/relay1.example/tcp/443/wss/p2p/relay1',
    '/dns4/relay2.example/tcp/443/wss/p2p/relay2',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    libp2pState.dials = [];
    libp2pState.handler = undefined;
    libp2pState.stopCalled = false;
    libp2pState.startCalled = false;
    libp2pState.eventListeners = {};
    mockLoggerLog.mockClear();
    mockLoggerError.mockClear();

    // Default mock implementation for createLibp2p
    createLibp2p.mockImplementation(async () => ({
      start: vi.fn(() => {
        libp2pState.startCalled = true;
      }),
      stop: vi.fn(() => {
        libp2pState.stopCalled = true;
      }),
      peerId: {
        toString: () => 'test-peer-id',
      },
      addEventListener: vi.fn(
        (event: string, handler: (evt: { detail: unknown }) => void) => {
          libp2pState.eventListeners[event] ??= [];
          libp2pState.eventListeners[event].push(handler);
        },
      ),
      dial: vi.fn(async () => ({})),
      getConnections: vi.fn(() => [
        { remotePeer: { toString: () => 'relay1' } },
        { remotePeer: { toString: () => 'relay2' } },
      ]),
      getMultiaddrs: vi.fn(() => [
        { toString: () => '/ip4/127.0.0.1/udp/12345/quic-v1/p2p/test-peer-id' },
        { toString: () => '/ip4/127.0.0.1/tcp/9001/ws/p2p/test-peer-id' },
      ]),
      dialProtocol: vi.fn(
        async (
          addr: string,
          protocol: string,
          options: { signal: AbortSignal },
        ) => {
          const stream = {};
          libp2pState.dials.push({ addr, protocol, options, stream });
          return stream;
        },
      ),
      handle: vi.fn(
        async (
          _protocol: string,
          handler?: (
            stream: object,
            connection: MockConnection,
          ) => void | Promise<void>,
        ) => {
          libp2pState.handler = handler;
        },
      ),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Create a new ConnectionFactory.
   *
   * @param options - Options for the factory.
   * @param options.signal - The signal to use for the ConnectionFactory.
   * @param options.maxRetryAttempts - Maximum number of retry attempts.
   * @param options.directTransports - Optional direct transports with listen addresses.
   * @param options.allowedWsHosts - Hostnames/IPs allowed for plain ws:// beyond private ranges.
   * @returns The ConnectionFactory.
   */
  async function createFactory(options?: {
    signal?: AbortSignal;
    maxRetryAttempts?: number;
    directTransports?: import('../types.ts').DirectTransport[];
    allowedWsHosts?: string[];
  }): Promise<
    Awaited<
      ReturnType<
        typeof import('./connection-factory.ts').ConnectionFactory.make
      >
    >
  > {
    const { ConnectionFactory } = await import('./connection-factory.ts');
    const { Logger } = await import('@metamask/logger');
    return ConnectionFactory.make({
      keySeed,
      knownRelays,
      logger: new Logger(),
      signal: options?.signal ?? new AbortController().signal,
      maxRetryAttempts: options?.maxRetryAttempts,
      directTransports: options?.directTransports,
      allowedWsHosts: options?.allowedWsHosts,
    });
  }

  describe('initialize', () => {
    it('creates and starts libp2p node', async () => {
      factory = await createFactory();

      expect(createLibp2p).toHaveBeenCalledOnce();
      expect(libp2pState.startCalled).toBe(true);
    });

    it('registers inbound handler', async () => {
      factory = await createFactory();

      expect(libp2pState.handler).toBeDefined();
      expect(typeof libp2pState.handler).toBe('function');
    });

    it('configures libp2p with correct transports', async () => {
      factory = await createFactory();

      const callArgs = createLibp2p.mock.calls[0]?.[0];
      expect(callArgs).toBeDefined();
      expect(callArgs.transports).toHaveLength(4); // webSockets, webTransport, webRTC, circuitRelay
    });

    it('uses provided key seed for key generation', async () => {
      factory = await createFactory();

      expect(generateKeyPairFromSeed).toHaveBeenCalledWith(
        'Ed25519',
        expect.any(Uint8Array),
      );
    });

    it('configures bootstrap with known relays', async () => {
      factory = await createFactory();

      const callArgs = createLibp2p.mock.calls[0]?.[0];
      expect(callArgs.peerDiscovery).toBeDefined();
    });

    it('omits bootstrap when no relays are provided', async () => {
      const { ConnectionFactory } = await import('./connection-factory.ts');
      factory = await ConnectionFactory.make({
        keySeed,
        knownRelays: [],
        logger: new (await import('@metamask/logger')).Logger(),
        signal: new AbortController().signal,
      });

      const callArgs = createLibp2p.mock.calls[0]?.[0];
      expect(callArgs.peerDiscovery).toBeUndefined();
    });

    it('accepts maxRetryAttempts parameter', async () => {
      const maxRetryAttempts = 5;
      factory = await createFactory({ maxRetryAttempts });

      expect(createLibp2p).toHaveBeenCalledOnce();
      expect(libp2pState.startCalled).toBe(true);
    });

    describe('connectionGater.denyDialMultiaddr', () => {
      it.each([
        {
          label: 'wss:// to public IP',
          protoNames: ['ip4', 'tcp', 'wss'],
          host: '8.8.8.8',
          allowedWsHosts: [],
          expected: false,
        },
        {
          label: 'ws:// to 127.0.0.1 (loopback)',
          protoNames: ['ip4', 'tcp', 'ws'],
          host: '127.0.0.1',
          allowedWsHosts: [],
          expected: false,
        },
        {
          label: 'ws:// to 10.0.0.1 (RFC 1918)',
          protoNames: ['ip4', 'tcp', 'ws'],
          host: '10.0.0.1',
          allowedWsHosts: [],
          expected: false,
        },
        {
          label: 'ws:// to 172.16.0.1 (RFC 1918)',
          protoNames: ['ip4', 'tcp', 'ws'],
          host: '172.16.0.1',
          allowedWsHosts: [],
          expected: false,
        },
        {
          label: 'ws:// to 192.168.1.1 (RFC 1918)',
          protoNames: ['ip4', 'tcp', 'ws'],
          host: '192.168.1.1',
          allowedWsHosts: [],
          expected: false,
        },
        {
          label: 'ws:// to public IP (denied)',
          protoNames: ['ip4', 'tcp', 'ws'],
          host: '8.8.8.8',
          allowedWsHosts: [],
          expected: true,
        },
        {
          label: 'ws:// to allowlisted hostname',
          protoNames: ['dns4', 'tcp', 'ws'],
          host: 'relay.internal',
          allowedWsHosts: ['relay.internal'],
          expected: false,
        },
        {
          label: 'ws:// to non-allowlisted hostname (denied)',
          protoNames: ['dns4', 'tcp', 'ws'],
          host: 'relay.example',
          allowedWsHosts: [],
          expected: true,
        },
        {
          label: 'ws:// to hostname starting with fc (denied, not IPv6)',
          protoNames: ['dns4', 'tcp', 'ws'],
          host: 'fcevil.attacker.com',
          allowedWsHosts: [],
          expected: true,
        },
        {
          label:
            'ws:// to all-hex hostname starting with fd (denied, not IPv6)',
          protoNames: ['dns4', 'tcp', 'ws'],
          host: 'fdcafe',
          allowedWsHosts: [],
          expected: true,
        },
        {
          label: 'non-WebSocket multiaddr (/webrtc)',
          protoNames: ['ip4', 'udp', 'webrtc'],
          host: '8.8.8.8',
          allowedWsHosts: [],
          expected: false,
        },
      ])(
        '$label → $expected',
        async ({ protoNames, host, allowedWsHosts, expected }) => {
          factory = await createFactory({ allowedWsHosts });

          const callArgs = createLibp2p.mock.calls[0]?.[0];
          expect(callArgs.connectionGater.denyDialMultiaddr).toBeDefined();

          const ma = makeTestMultiaddr(protoNames, host);
          const result = await callArgs.connectionGater.denyDialMultiaddr(ma);
          expect(result).toBe(expected);
        },
      );
    });

    it('auto-allows ws:// relay hosts in connectionGater', async () => {
      const { ConnectionFactory } = await import('./connection-factory.ts');
      const { Logger } = await import('@metamask/logger');
      factory = await ConnectionFactory.make({
        keySeed,
        knownRelays: [
          '/dns4/relay.public.com/tcp/9001/ws/p2p/relay1',
          '/dns4/relay2.public.com/tcp/443/wss/p2p/relay2',
        ],
        logger: new Logger(),
        signal: new AbortController().signal,
      });

      const callArgs = createLibp2p.mock.calls[0]?.[0];
      const wsRelayAddr = makeTestMultiaddr(
        ['dns4', 'tcp', 'ws'],
        'relay.public.com',
      );
      const wssRelayAddr = makeTestMultiaddr(
        ['dns4', 'tcp', 'ws'],
        'relay2.public.com',
      );
      // Host from ws:// relay is auto-added to allowedWsHosts → plain ws:// dial allowed
      expect(
        await callArgs.connectionGater.denyDialMultiaddr(wsRelayAddr),
      ).toBe(false);
      // Host from wss:// relay is NOT auto-added (wss bypasses the gater) → plain ws:// dial denied
      expect(
        await callArgs.connectionGater.denyDialMultiaddr(wssRelayAddr),
      ).toBe(true);
    });

    it('registers peer update event listener', async () => {
      const mockAddEventListener = vi.fn();
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer-id' },
        addEventListener: mockAddEventListener,
        dialProtocol: vi.fn(),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      expect(mockAddEventListener).toHaveBeenCalledWith(
        'self:peer:update',
        expect.any(Function),
      );

      // Test that the event listener logs peer updates
      const eventHandler = mockAddEventListener.mock.calls[0]?.[1];
      const mockEvent = { detail: { peerId: 'test-peer', addresses: [] } };
      eventHandler(mockEvent);

      // Verify the logger was called with the peer update
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('Peer update:'),
      );
    });

    it('registers peer:disconnect event listener', async () => {
      const mockAddEventListener = vi.fn();
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer-id' },
        addEventListener: mockAddEventListener,
        dialProtocol: vi.fn(),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      expect(mockAddEventListener).toHaveBeenCalledWith(
        'peer:disconnect',
        expect.any(Function),
      );
    });

    it('calls disconnect handler on peer:disconnect event', async () => {
      factory = await createFactory();

      const disconnectHandler = vi.fn();
      factory.onPeerDisconnect(disconnectHandler);

      // Fire peer:disconnect event
      for (const listener of libp2pState.eventListeners['peer:disconnect'] ??
        []) {
        listener({ detail: { toString: () => 'disconnected-peer' } });
      }

      expect(disconnectHandler).toHaveBeenCalledWith('disconnected-peer');
      expect(mockLoggerLog).toHaveBeenCalledWith(
        'peer disconnected (all connections closed): disconnected-peer',
      );
    });

    it('does not call disconnect handler for relay peer IDs', async () => {
      factory = await createFactory();

      const disconnectHandler = vi.fn();
      factory.onPeerDisconnect(disconnectHandler);

      // Fire peer:disconnect for a relay peer (relay1 is in knownRelays)
      for (const listener of libp2pState.eventListeners['peer:disconnect'] ??
        []) {
        listener({ detail: { toString: () => 'relay1' } });
      }

      // Should log the disconnect but NOT call the handler
      expect(mockLoggerLog).toHaveBeenCalledWith(
        'peer disconnected (all connections closed): relay1',
      );
      expect(disconnectHandler).not.toHaveBeenCalled();
    });

    it('logs connection type as direct or relayed for inbound', async () => {
      factory = await createFactory();
      factory.onInboundConnection(vi.fn());

      const inboundStream = {};
      await libp2pState.handler?.(inboundStream, {
        remotePeer: { toString: () => 'direct-peer' },
        direct: true,
      });

      expect(mockLoggerLog).toHaveBeenCalledWith(
        'inbound direct connection from peerId:direct-peer',
      );
    });
  });

  describe('onInboundConnection', () => {
    it('sets inbound handler', async () => {
      factory = await createFactory();

      const handler = vi.fn();
      factory.onInboundConnection(handler);

      // Simulate inbound connection
      const inboundStream = {};
      await libp2pState.handler?.(inboundStream, {
        remotePeer: { toString: () => 'remote-peer' },
        direct: false,
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'remote-peer',
        }),
      );
    });

    it('creates channel with byte stream for inbound connections', async () => {
      factory = await createFactory();

      let capturedChannel: Channel | undefined;
      factory.onInboundConnection((channel: Channel) => {
        capturedChannel = channel;
      });

      const inboundStream = {};
      await libp2pState.handler?.(inboundStream, {
        remotePeer: { toString: () => 'inbound-peer' },
        direct: false,
      });

      expect(capturedChannel).toBeDefined();
      expect(capturedChannel?.msgStream).toBeDefined();
      expect(capturedChannel?.peerId).toBe('inbound-peer');
    });

    it('awaits async inbound handler for auto-abort on rejection', async () => {
      factory = await createFactory();

      const handlerError = new Error('handler setup failed');
      factory.onInboundConnection(async () => {
        throw handlerError;
      });

      const inboundStream = {};
      await expect(
        libp2pState.handler?.(inboundStream, {
          remotePeer: { toString: () => 'failing-peer' },
          direct: false,
        }),
      ).rejects.toThrow('handler setup failed');
    });

    it('handles sync inbound handler without rejection', async () => {
      factory = await createFactory();

      const handler = vi.fn();
      factory.onInboundConnection(handler);

      const inboundStream = {};
      const result = await libp2pState.handler?.(inboundStream, {
        remotePeer: { toString: () => 'sync-peer' },
        direct: false,
      });

      expect(result).toBeUndefined();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('candidateAddressStrings', () => {
    it('generates WebRTC and circuit addresses for each relay', async () => {
      factory = await createFactory();

      const addresses = factory.candidateAddressStrings('peer123', []);

      expect(addresses).toHaveLength(4); // 2 relays × 2 types
      expect(addresses[0]).toBe(
        `${knownRelays[0]}/p2p-circuit/webrtc/p2p/peer123`,
      );
      expect(addresses[1]).toBe(`${knownRelays[0]}/p2p-circuit/p2p/peer123`);
      expect(addresses[2]).toBe(
        `${knownRelays[1]}/p2p-circuit/webrtc/p2p/peer123`,
      );
      expect(addresses[3]).toBe(`${knownRelays[1]}/p2p-circuit/p2p/peer123`);
    });

    it('prioritizes hints over known relays', async () => {
      factory = await createFactory();

      const hints = ['/dns4/hint.example/tcp/443/wss/p2p/hint'];
      const addresses = factory.candidateAddressStrings('peer123', hints);

      // Hints should come first
      expect(addresses[0]).toContain('hint.example');
      expect(addresses[1]).toContain('hint.example');
      // Then known relays
      expect(addresses[2]).toContain('relay1.example');
    });

    it('does not duplicate relays that are also in hints', async () => {
      factory = await createFactory();

      // Use one of the known relays as a hint
      const hints = [knownRelays[0] as string];
      const addresses = factory.candidateAddressStrings('peer123', hints);

      // Should not have duplicates
      const relay1Addresses = addresses.filter((addr: string) =>
        addr.includes('relay1.example'),
      );
      expect(relay1Addresses).toHaveLength(2); // Just WebRTC and circuit
    });

    it('returns empty array when no relays and no hints', async () => {
      const { ConnectionFactory } = await import('./connection-factory.ts');
      factory = await ConnectionFactory.make({
        keySeed,
        knownRelays: [],
        logger: new (await import('@metamask/logger')).Logger(),
        signal: new AbortController().signal,
      });

      const addresses = factory.candidateAddressStrings('peer123', []);

      expect(addresses).toStrictEqual([]);
    });
  });

  describe('openChannelOnce', () => {
    it('dials and returns channel on success', async () => {
      factory = await createFactory();

      const channel = await factory.openChannelOnce('peer123');

      expect(channel).toBeDefined();
      expect(channel.peerId).toBe('peer123');
      expect(channel.msgStream).toBeDefined();
      expect(libp2pState.dials).toHaveLength(1);
    });

    it('tries multiple addresses until one succeeds', async () => {
      let attemptCount = 0;
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async (addr: string) => {
          attemptCount += 1;
          if (attemptCount < 3) {
            throw new Error('Connection failed');
          }
          const stream = {};
          libp2pState.dials.push({
            addr,
            protocol: 'whatever',
            options: { signal: AbortSignal.timeout(30_000) },
            stream,
          });
          return stream;
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      const channel = await factory.openChannelOnce('peer123');

      expect(channel).toBeDefined();
      expect(attemptCount).toBe(3);
    });

    it('throws AbortError if signal is aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      factory = await createFactory({ signal: controller.signal });

      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        AbortError,
      );
    });

    it('throws AbortError if signal is aborted after dial error', async () => {
      const controller = new AbortController();
      let dialAttempt = 0;

      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          dialAttempt += 1;
          if (dialAttempt === 1) {
            // First attempt: throw error
            throw new Error('Connection failed');
          } else {
            // After first error, abort the signal
            controller.abort();
            throw new Error('Connection failed again');
          }
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory({ signal: controller.signal });

      // The error is caught, then on retry signal.aborted is checked and AbortError is thrown
      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        AbortError,
      );
    });

    it('handles MuxerClosedError gracefully', async () => {
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          throw new MuxerClosedError('Muxer closed');
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        MuxerClosedError,
      );
      expect(libp2pState.dials).toHaveLength(0);
    });

    it('handles TooManyOutboundProtocolStreamsError gracefully', async () => {
      const { TooManyOutboundProtocolStreamsError: TooManyStreams } =
        await import('@libp2p/interface');
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          throw new TooManyStreams('Too many streams');
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        TooManyStreams,
      );
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('too many outbound streams via'),
      );
    });

    it('handles timeout errors', async () => {
      const abortedSignal = {
        aborted: true,
        reason: new Error('Timeout'),
      };

      vi.spyOn(AbortSignal, 'timeout').mockImplementation(
        () => abortedSignal as unknown as AbortSignal,
      );

      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async (_addr, _protocol, options) => {
          if (options.signal.aborted) {
            throw new Error('Operation timed out');
          }
          throw new Error('Should not reach here');
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        'Operation timed out',
      );
    });

    it('throws last error if all attempts fail', async () => {
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          throw new Error('Final connection error');
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        'Final connection error',
      );
    });

    it('throws generic error if all attempts fail without lastError', async () => {
      // This shouldn't happen in practice, but test the fallback
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          // Throw a non-Error value that gets caught but doesn't set lastError properly
          // oxlint-disable-next-line typescript/only-throw-error
          throw null;
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        'unable to open channel to peer123',
      );
    });

    it('logs connection attempts', async () => {
      factory = await createFactory();

      await factory.openChannelOnce('peer123');

      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('contacting peer123 via'),
      );
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('successfully connected to peer123 via'),
      );
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('opened channel to peer123'),
      );
    });

    it('throws fallback error when no relays and no hints', async () => {
      const { ConnectionFactory } = await import('./connection-factory.ts');
      factory = await ConnectionFactory.make({
        keySeed,
        knownRelays: [],
        logger: new (await import('@metamask/logger')).Logger(),
        signal: new AbortController().signal,
      });

      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        'unable to open channel to peer123',
      );
    });
  });

  describe('openChannelWithRetry', () => {
    it('retries on retryable errors', async () => {
      let attemptCount = 0;
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          attemptCount += 1;
          if (attemptCount === 1) {
            const error = new Error('Connection reset') as Error & {
              code: string;
            };
            error.code = 'ECONNRESET';
            throw error;
          }
          const stream = {};
          return stream;
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      const channel = await factory.openChannelWithRetry('peer123');

      expect(channel).toBeDefined();
      expect(attemptCount).toBe(2);
    });

    it('does not retry on non-retryable errors', async () => {
      let attemptCount = 0;
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          attemptCount += 1;
          throw new Error('Non-retryable error');
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await expect(factory.openChannelWithRetry('peer123')).rejects.toThrow(
        'Non-retryable error',
      );
      // Since it tries all 4 addresses (2 relays × 2 types) before giving up
      expect(attemptCount).toBe(4);
    });

    it('calls onRetry callback', async () => {
      let onRetryCallbackCalled = false;
      let attemptCount = 0;

      // Override the mock retryWithBackoff to track onRetry calls
      vi.doMock('@metamask/kernel-utils', () => ({
        fromHex: (_hex: string) => new Uint8Array(_hex.length / 2),
        calculateReconnectionBackoff,
        retryWithBackoff: async <OperationResult>(
          operation: () => Promise<OperationResult>,
          options?: {
            jitter?: boolean;
            shouldRetry?: (error: unknown) => boolean;
            onRetry?: (info: {
              attempt: number;
              maxAttempts?: number;
              delayMs: number;
            }) => void;
            signal?: AbortSignal;
          },
        ) => {
          try {
            return await operation();
          } catch (error) {
            if (options?.shouldRetry?.(error)) {
              onRetryCallbackCalled = true;
              options?.onRetry?.({ attempt: 1, maxAttempts: 3, delayMs: 100 });
              return await operation();
            }
            throw error;
          }
        },
      }));

      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          attemptCount += 1;
          if (attemptCount <= 4) {
            // Fail first 4 attempts (all addresses)
            const error = new Error('Timeout') as Error & { code: string };
            error.code = 'ETIMEDOUT';
            throw error;
          }
          return {};
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      // Re-import ConnectionFactory to use the new mock
      vi.resetModules();
      const { ConnectionFactory } = await import('./connection-factory.ts');
      const { Logger } = await import('@metamask/logger');
      factory = await ConnectionFactory.make({
        keySeed,
        knownRelays,
        logger: new Logger(),
        signal: new AbortController().signal,
      });

      await factory.openChannelWithRetry('peer123');

      expect(onRetryCallbackCalled).toBe(true);
    });

    it.each([
      {
        option: 'defaults',
        options: {},
        expected: { maxAttempts: 0 },
      },
      {
        option: 'maxRetryAttempts',
        options: { maxRetryAttempts: 2 },
        expected: { maxAttempts: 2 },
      },
      {
        option: 'the reconnection delays',
        options: { reconnectionBaseDelayMs: 10, reconnectionMaxDelayMs: 50 },
        expected: { maxAttempts: 0, baseDelayMs: 10, maxDelayMs: 50 },
      },
    ])('retries with $option', async ({ options, expected }) => {
      let capturedRetryOptions:
        | Parameters<
            typeof import('@metamask/kernel-utils').retryWithBackoff
          >[1]
        | undefined;

      // Override the mock retryWithBackoff to capture options
      vi.doMock('@metamask/kernel-utils', () => ({
        fromHex: (_hex: string) => new Uint8Array(_hex.length / 2),
        calculateReconnectionBackoff,
        retryWithBackoff: async <OperationResult>(
          operation: () => Promise<OperationResult>,
          retryOptions?: Parameters<
            typeof import('@metamask/kernel-utils').retryWithBackoff
          >[1],
        ) => {
          capturedRetryOptions = retryOptions;
          return await operation();
        },
      }));

      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          return {};
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      // Re-import ConnectionFactory to use the new mock
      vi.resetModules();
      const { ConnectionFactory } = await import('./connection-factory.ts');
      const { Logger } = await import('@metamask/logger');
      const { signal } = new AbortController();
      factory = await ConnectionFactory.make({
        keySeed,
        knownRelays,
        logger: new Logger(),
        signal,
        ...options,
      });

      await factory.openChannelWithRetry('peer123');

      expect(capturedRetryOptions).toStrictEqual({
        ...expected,
        jitter: true,
        shouldRetry: expect.any(Function),
        onRetry: expect.any(Function),
        signal,
      });
    });
  });

  describe('dialIdempotent', () => {
    it('only dials once for concurrent requests to same peer', async () => {
      let dialCount = 0;
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          dialCount += 1;
          // Add delay to simulate network latency
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {};
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      // Start two concurrent dials
      const [channel1, channel2] = await Promise.all([
        factory.dialIdempotent('peer123', [], false),
        factory.dialIdempotent('peer123', [], false),
      ]);

      expect(channel1).toBe(channel2);
      expect(dialCount).toBe(1);
    });

    it('allows new dial after previous completes', async () => {
      let dialCount = 0;
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          dialCount += 1;
          return {};
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      // First dial
      await factory.dialIdempotent('peer123', [], false);
      expect(dialCount).toBe(1);

      // Second dial (after first completes)
      await factory.dialIdempotent('peer123', [], false);
      expect(dialCount).toBe(2);
    });

    it('handles different peers independently', async () => {
      let dialCount = 0;
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          dialCount += 1;
          return {};
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await Promise.all([
        factory.dialIdempotent('peer1', [], false),
        factory.dialIdempotent('peer2', [], false),
        factory.dialIdempotent('peer3', [], false),
      ]);

      expect(dialCount).toBe(3);
    });

    it('uses retry when withRetry is true', async () => {
      let attemptCount = 0;
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          attemptCount += 1;
          if (attemptCount === 1) {
            const error = new Error('Retry me') as Error & { code: string };
            error.code = 'ECONNRESET';
            throw error;
          }
          return {};
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await factory.dialIdempotent('peer123', [], true);
      expect(attemptCount).toBe(2);
    });

    it('cleans up inflight dial on error', async () => {
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          throw new Error('Dial failed');
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await expect(
        factory.dialIdempotent('peer123', [], false),
      ).rejects.toThrow('Dial failed');

      // Should be able to retry after failure
      await expect(
        factory.dialIdempotent('peer123', [], false),
      ).rejects.toThrow('Dial failed');
    });
  });

  describe('outputError', () => {
    it('logs error message when problem is provided', async () => {
      // Use a custom dial that will trigger outputError with a problem
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          throw new Error('test error');
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();
      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        'test error',
      );
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('peer123:: error issue opening channel:'),
      );
    });

    it('logs error message without problem when problem is falsy', async () => {
      let dialCount = 0;
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(async () => {
          dialCount += 1;
          // Throw a falsy value to trigger the else branch in outputError
          // oxlint-disable-next-line typescript/only-throw-error
          throw null;
        }),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();
      await expect(factory.openChannelOnce('peer123')).rejects.toThrow(
        'unable to open channel to peer123',
      );
      expect(dialCount).toBe(4);
      expect(mockLoggerLog).toHaveBeenCalledWith(
        'peer123:: error issue opening channel',
      );
    });
  });

  describe('stop', () => {
    it('calls libp2p.stop() and clears inflight dials', async () => {
      const mockStop = vi.fn().mockImplementation(async () => {
        libp2pState.stopCalled = true;
      });
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: mockStop,
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await factory.stop();

      expect(mockStop).toHaveBeenCalledOnce();
      expect(libp2pState.stopCalled).toBe(true);
    });

    it('clears inflight dials', async () => {
      let resolveDial: (() => void) | undefined;
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(
          async () =>
            new Promise((resolve) => {
              resolveDial = () => resolve({});
            }),
        ),
        handle: vi.fn(),
        getConnections: vi.fn(() => []),
      }));

      factory = await createFactory();

      // Start a dial but don't wait for it
      const dialPromise = factory.dialIdempotent('peer123', [], false);

      // Stop should clear inflight dials
      await factory.stop();

      // Complete the dial
      resolveDial?.();

      // The dial should still resolve (but inflight map is cleared)
      expect(await dialPromise).toBeDefined();
    });

    it('handles libp2p.stop() errors gracefully', async () => {
      const mockStop = vi
        .fn()
        .mockRejectedValue(new Error('libp2p.stop() failed'));
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: mockStop,
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
      }));

      factory = await createFactory();

      await factory.stop();

      // Verify libp2p.stop() was called
      expect(mockStop).toHaveBeenCalledOnce();
      // Verify error was logged
      expect(mockLoggerError).toHaveBeenCalledWith(
        'libp2p.stop() failed or timed out:',
        expect.any(Error),
      );
      // Should not throw - continues anyway
    });

    it('handles empty connections list', async () => {
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(),
        dial: vi.fn().mockResolvedValue({}),
        handle: vi.fn(),
        getConnections: vi.fn(() => []),
      }));

      factory = await createFactory();

      // Should not throw with no connections
      expect(await factory.stop()).toBeUndefined();
    });

    it('stop is asynchronous', async () => {
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer' },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(),
        dial: vi.fn().mockResolvedValue({}),
        handle: vi.fn(),
        getConnections: vi.fn(() => []),
      }));

      factory = await createFactory();

      // stop() returns a Promise
      const result = factory.stop();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  describe('closeChannel', () => {
    it('closes stream gracefully', async () => {
      factory = await createFactory();
      const close = vi.fn().mockResolvedValue(undefined);
      const channel = {
        peerId: 'peer-close',
        stream: { close, abort: vi.fn() },
        msgStream: {},
      } as unknown as Channel;
      await factory.closeChannel(channel, channel.peerId);
      expect(close).toHaveBeenCalled();
      expect(mockLoggerLog).toHaveBeenCalledWith(
        `${channel.peerId}:: closed channel stream`,
      );
    });

    it('aborts stream when graceful close fails', async () => {
      factory = await createFactory();
      const closeError = new Error('close failed');
      const close = vi.fn().mockRejectedValue(closeError);
      const abort = vi.fn();
      const channel = {
        peerId: 'peer-abort',
        stream: { close, abort },
        msgStream: {},
      } as unknown as Channel;
      await factory.closeChannel(channel, channel.peerId);
      // close() must be attempted before falling back to abort()
      expect(close).toHaveBeenCalled();
      expect(abort).toHaveBeenCalledWith(closeError);
      expect(mockLoggerLog).toHaveBeenCalledWith(
        `${channel.peerId}:: aborted channel stream`,
      );
    });

    it('logs error when abort also throws', async () => {
      factory = await createFactory();
      const close = vi.fn().mockRejectedValue(new Error('close failed'));
      const abort = vi.fn().mockImplementation(() => {
        throw new Error('abort failed');
      });
      const channel = {
        peerId: 'peer-double-fail',
        stream: { close, abort },
        msgStream: {},
      } as unknown as Channel;
      await factory.closeChannel(channel, channel.peerId);
      expect(abort).toHaveBeenCalled();
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('closing channel stream'),
      );
    });
  });

  describe('relay reconnection', () => {
    // vi.useFakeTimers() is incompatible with SES lockdown (Date is frozen),
    // so we manually spy on setTimeout/clearTimeout.
    type PendingTimer = {
      callback: (...args: never[]) => Promise<void> | void;
      delay: number;
      id: number;
    };

    let pendingTimers: PendingTimer[];
    let nextTimerId: number;
    let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
    let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      pendingTimers = [];
      nextTimerId = 1;
      setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: (...args: never[]) => void,
        delay?: number,
      ) => {
        const id = nextTimerId;
        nextTimerId += 1;
        pendingTimers.push({ callback, delay: delay ?? 0, id });
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout);
      clearTimeoutSpy = vi
        .spyOn(globalThis, 'clearTimeout')
        .mockImplementation(((id: unknown) => {
          pendingTimers = pendingTimers.filter((timer) => timer.id !== id);
        }) as unknown as typeof clearTimeout);
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    });

    /**
     * Run the first pending timer callback and await its completion.
     */
    async function runNextTimer(): Promise<void> {
      const timer = pendingTimers.shift();
      if (timer) {
        await timer.callback();
      }
    }

    /**
     * Run all pending timers until none remain, up to a safety limit.
     */
    async function runAllTimers(): Promise<void> {
      const limit = 100;
      let iterations = 0;
      while (pendingTimers.length > 0 && iterations < limit) {
        await runNextTimer();
        iterations += 1;
      }
    }

    function fireConnectionClose(remotePeerId: string) {
      for (const listener of libp2pState.eventListeners['connection:close'] ??
        []) {
        listener({
          detail: { remotePeer: { toString: () => remotePeerId } },
        });
      }
    }

    /**
     * Create a libp2p mock that captures event listeners and exposes a dial spy.
     *
     * @param mockDial - The dial mock to use.
     * @param getConnections - Mock for getConnections; defaults to returning both relays as connected.
     */
    function setupRelayMock(
      mockDial: ReturnType<typeof vi.fn>,
      getConnections: ReturnType<typeof vi.fn> = vi.fn(() => [
        { remotePeer: { toString: () => 'relay1' } },
        { remotePeer: { toString: () => 'relay2' } },
      ]),
    ) {
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(),
        peerId: { toString: () => 'test-peer-id' },
        addEventListener: vi.fn(
          (event: string, handler: (evt: { detail: unknown }) => void) => {
            libp2pState.eventListeners[event] ??= [];
            libp2pState.eventListeners[event].push(handler);
          },
        ),
        getMultiaddrs: vi.fn(() => []),
        dialProtocol: vi.fn(async () => ({})),
        handle: vi.fn(),
        dial: mockDial,
        getConnections,
      }));
    }

    it('re-dials relay when connection closes', async () => {
      const mockDial = vi.fn().mockResolvedValue({});
      setupRelayMock(mockDial);

      factory = await createFactory();
      fireConnectionClose('relay1');

      expect(pendingTimers).toHaveLength(1);
      // With full jitter and Math.random=0.5, attempt 1 (raw 5000) => 2500
      expect(pendingTimers[0]?.delay).toBe(2_500);

      await runNextTimer();

      expect(mockDial).toHaveBeenCalledTimes(1);
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('relay relay1 reconnected'),
      );
    });

    it('does not re-dial for non-relay peer', async () => {
      const mockDial = vi.fn().mockResolvedValue({});
      setupRelayMock(mockDial);

      factory = await createFactory();
      fireConnectionClose('random-peer');

      expect(pendingTimers).toHaveLength(0);
      expect(mockDial).not.toHaveBeenCalled();
    });

    it('applies exponential backoff on consecutive failures', async () => {
      const mockDial = vi.fn().mockRejectedValue(new Error('dial failed'));
      setupRelayMock(mockDial);

      factory = await createFactory();
      fireConnectionClose('relay1');

      // Full jitter with Math.random=0.5 yields half of the raw backoff (floored).
      // Attempt 1 raw=5000 => 2500
      expect(pendingTimers[0]?.delay).toBe(2_500);
      await runNextTimer();
      expect(mockDial).toHaveBeenCalledTimes(1);

      // Attempt 2 raw=10000 => 5000
      expect(pendingTimers[0]?.delay).toBe(5_000);
      await runNextTimer();
      expect(mockDial).toHaveBeenCalledTimes(2);

      // Attempt 3 raw=20000 => 10000
      expect(pendingTimers[0]?.delay).toBe(10_000);
      await runNextTimer();
      expect(mockDial).toHaveBeenCalledTimes(3);

      // Attempt 4 raw=40000 => 20000
      expect(pendingTimers[0]?.delay).toBe(20_000);

      // Attempt 5 raw=80000 capped to 60000 => 30000
      await runNextTimer();
      expect(pendingTimers[0]?.delay).toBe(30_000);
    });

    it('stops retrying after max attempts', async () => {
      const mockDial = vi.fn().mockRejectedValue(new Error('dial failed'));
      setupRelayMock(mockDial);

      factory = await createFactory();
      fireConnectionClose('relay1');

      await runAllTimers();

      expect(mockDial).toHaveBeenCalledTimes(10);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('reconnect exhausted after 10 attempts'),
      );
    });

    it('clears pending reconnects on stop', async () => {
      const mockDial = vi.fn().mockRejectedValue(new Error('dial failed'));
      setupRelayMock(mockDial);

      factory = await createFactory();
      fireConnectionClose('relay1');

      expect(pendingTimers).toHaveLength(1);

      await factory.stop();

      expect(pendingTimers).toHaveLength(0);
      expect(mockDial).not.toHaveBeenCalled();
    });

    it('does not schedule reconnects for connection:close events during stop', async () => {
      const mockDial = vi.fn().mockResolvedValue({});
      // Mock libp2p.stop() to fire connection:close for relay peers
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(),
        stop: vi.fn(() => {
          // Simulate libp2p tearing down relay connections during stop
          fireConnectionClose('relay1');
        }),
        peerId: { toString: () => 'test-peer-id' },
        addEventListener: vi.fn(
          (event: string, handler: (evt: { detail: unknown }) => void) => {
            libp2pState.eventListeners[event] ??= [];
            libp2pState.eventListeners[event].push(handler);
          },
        ),
        getMultiaddrs: vi.fn(() => []),
        dialProtocol: vi.fn(async () => ({})),
        getConnections: vi.fn(() => [
          { remotePeer: { toString: () => 'relay1' } },
          { remotePeer: { toString: () => 'relay2' } },
        ]),
        handle: vi.fn(),
        dial: mockDial,
      }));

      factory = await createFactory();

      await factory.stop();

      // No reconnect timers should have been scheduled
      expect(pendingTimers).toHaveLength(0);
      expect(mockDial).not.toHaveBeenCalled();
    });

    it('stops retrying after a successful reconnect', async () => {
      let dialCount = 0;
      const mockDial = vi.fn(async () => {
        dialCount += 1;
        if (dialCount < 3) {
          throw new Error('dial failed');
        }
        return {};
      });
      setupRelayMock(mockDial);

      factory = await createFactory();
      fireConnectionClose('relay1');

      await runAllTimers();

      expect(mockDial).toHaveBeenCalledTimes(3);
      expect(pendingTimers).toHaveLength(0);
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('relay relay1 reconnected'),
      );
    });

    it('does not schedule duplicate reconnects for the same relay', async () => {
      const mockDial = vi.fn().mockRejectedValue(new Error('dial failed'));
      setupRelayMock(mockDial);

      factory = await createFactory();
      fireConnectionClose('relay1');
      fireConnectionClose('relay1');

      expect(pendingTimers).toHaveLength(1);
    });

    it('does not schedule reconnect when signal is already aborted', async () => {
      const mockDial = vi.fn().mockResolvedValue({});
      setupRelayMock(mockDial);

      const controller = new AbortController();
      factory = await createFactory({ signal: controller.signal });
      controller.abort();
      fireConnectionClose('relay1');

      expect(pendingTimers).toHaveLength(0);
    });

    it('cleans up pending reconnect entry when outer catch fires', async () => {
      const mockDial = vi.fn().mockResolvedValue({});
      setupRelayMock(mockDial);

      factory = await createFactory();

      // Make logger.log throw when the "attempting relay reconnect" message is
      // logged — this triggers the outer .catch() handler.
      mockLoggerLog.mockImplementation((message: string) => {
        if (
          typeof message === 'string' &&
          message.includes('attempting relay')
        ) {
          throw new Error('logger blew up');
        }
      });

      fireConnectionClose('relay1');
      await runNextTimer();

      expect(mockLoggerError).toHaveBeenCalledWith(
        'reconnection failed unexpectedly:',
        expect.any(Error),
      );

      // The pending entry must be removed so future reconnects are not blocked.
      mockLoggerLog.mockReset();
      fireConnectionClose('relay1');
      expect(pendingTimers).toHaveLength(1);
    });

    it('schedules reconnect for relay not connected on startup', async () => {
      const mockDial = vi.fn().mockResolvedValue({});
      // relay2 is connected, relay1 is not
      setupRelayMock(
        mockDial,
        vi.fn(() => [{ remotePeer: { toString: () => 'relay2' } }]),
      );

      factory = await createFactory();

      expect(pendingTimers).toHaveLength(1);
      expect(mockLoggerLog).toHaveBeenCalledWith(
        'relay relay1 not connected after startup, scheduling reconnect',
      );
    });

    it('schedules reconnect for all relays when none are connected on startup', async () => {
      const mockDial = vi.fn().mockResolvedValue({});
      setupRelayMock(
        mockDial,
        vi.fn(() => []),
      );

      factory = await createFactory();

      expect(pendingTimers).toHaveLength(2);
    });

    it('recovers relay that was down on startup once it comes back up', async () => {
      const mockDial = vi.fn().mockResolvedValue({});
      setupRelayMock(
        mockDial,
        vi.fn(() => []),
      );

      factory = await createFactory();

      // Two startup reconnect timers (relay1 and relay2)
      expect(pendingTimers).toHaveLength(2);

      await runAllTimers();

      expect(mockDial).toHaveBeenCalledTimes(2);
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('relay relay1 reconnected'),
      );
      expect(mockLoggerLog).toHaveBeenCalledWith(
        expect.stringContaining('relay relay2 reconnected'),
      );
    });

    it('does not schedule duplicate startup reconnect when relay also fires connection:close', async () => {
      const mockDial = vi.fn().mockResolvedValue({});
      // relay1 not connected on startup
      setupRelayMock(
        mockDial,
        vi.fn(() => [{ remotePeer: { toString: () => 'relay2' } }]),
      );

      factory = await createFactory();

      // 1 timer from startup reconnect for relay1
      expect(pendingTimers).toHaveLength(1);

      // connection:close for relay1 fires while startup reconnect is pending
      fireConnectionClose('relay1');

      // Still just 1 timer — #scheduleRelayReconnect deduplicates
      expect(pendingTimers).toHaveLength(1);
    });

    it('does not leak timer when stop() runs during in-flight dial', async () => {
      // Dial rejects after stop() has already completed both cleanup passes.
      // The catch block's recursive #reconnectRelay call must not schedule a
      // new timer.
      let dialReject: (reason: Error) => void;
      const mockDial = vi.fn(
        async () =>
          new Promise<object>((_resolve, reject) => {
            dialReject = reject;
          }),
      );
      setupRelayMock(mockDial);

      factory = await createFactory();
      fireConnectionClose('relay1');

      // Fire the first reconnect timer — starts the in-flight dial
      expect(pendingTimers).toHaveLength(1);
      const timerCallback = pendingTimers.shift()!;
      const callbackDone = timerCallback.callback();

      // stop() runs and completes both cleanup passes while dial is in-flight
      await factory.stop();
      expect(pendingTimers).toHaveLength(0);

      // Now the dial rejects — the catch handler calls #reconnectRelay
      dialReject!(new Error('dial failed'));
      await callbackDone;

      // No new timer should have been scheduled
      expect(pendingTimers).toHaveLength(0);
    });
  });

  describe('integration scenarios', () => {
    it('handles complete connection lifecycle', async () => {
      createLibp2p.mockImplementation(async () => ({
        start: vi.fn(() => {
          libp2pState.startCalled = true;
        }),
        stop: vi.fn(async () => {
          libp2pState.stopCalled = true;
        }),
        peerId: {
          toString: () => 'test-peer-id',
        },
        addEventListener: vi.fn(),
        dialProtocol: vi.fn(
          async (
            addr: string,
            protocol: string,
            options: { signal: AbortSignal },
          ) => {
            const stream = {};
            libp2pState.dials.push({ addr, protocol, options, stream });
            return stream;
          },
        ),
        handle: vi.fn(
          async (
            _protocol: string,
            handler?: (
              stream: object,
              connection: { remotePeer: { toString: () => string } },
            ) => void | Promise<void>,
          ) => {
            libp2pState.handler = handler;
          },
        ),
        getConnections: vi.fn(() => []),
      }));

      factory = await createFactory();

      // Open channel
      const channel = await factory.openChannelOnce('peer123', [
        '/dns4/hint.example/tcp/443/wss/p2p/hint',
      ]);
      expect(channel.peerId).toBe('peer123');

      // Verify dial was made
      expect(libp2pState.dials).toHaveLength(1);
      expect(libp2pState.dials[0]?.addr.toString()).toContain('hint.example');

      // Clean up
      await factory.stop();
      expect(libp2pState.stopCalled).toBe(true);
    });

    it('handles inbound and outbound connections', async () => {
      factory = await createFactory();

      const receivedChannels: Channel[] = [];
      factory.onInboundConnection((channel: Channel) => {
        receivedChannels.push(channel);
      });

      // Simulate inbound connection
      const inboundStream = {};
      await libp2pState.handler?.(inboundStream, {
        remotePeer: { toString: () => 'inbound-peer' },
        direct: false,
      });

      // Make outbound connection
      const outboundChannel = await factory.openChannelOnce('outbound-peer');

      expect(receivedChannels).toHaveLength(1);
      expect(receivedChannels[0]?.peerId).toBe('inbound-peer');
      expect(outboundChannel.peerId).toBe('outbound-peer');
    });
  });

  describe('directTransports', () => {
    it('includes a single direct transport in libp2p config', async () => {
      const mockTransport = { tag: 'quic-transport' };
      factory = await createFactory({
        directTransports: [
          {
            transport: mockTransport,
            listenAddresses: ['/ip4/0.0.0.0/udp/0/quic-v1'],
          },
        ],
      });

      const callArgs = createLibp2p.mock.calls[0]?.[0];
      expect(callArgs.transports).toHaveLength(5); // 4 default + 1 direct
      expect(callArgs.transports[4]).toBe(mockTransport);
    });

    it('includes multiple direct transports in libp2p config', async () => {
      const mockQuic = { tag: 'quic-transport' };
      const mockTcp = { tag: 'tcp-transport' };
      factory = await createFactory({
        directTransports: [
          {
            transport: mockQuic,
            listenAddresses: ['/ip4/0.0.0.0/udp/0/quic-v1'],
          },
          {
            transport: mockTcp,
            listenAddresses: ['/ip4/0.0.0.0/tcp/4001'],
          },
        ],
      });

      const callArgs = createLibp2p.mock.calls[0]?.[0];
      expect(callArgs.transports).toHaveLength(6); // 4 default + 2 direct
      expect(callArgs.transports[4]).toBe(mockQuic);
      expect(callArgs.transports[5]).toBe(mockTcp);
    });

    it('merges direct listen addresses with default addresses', async () => {
      factory = await createFactory({
        directTransports: [
          {
            transport: {},
            listenAddresses: ['/ip4/0.0.0.0/udp/0/quic-v1'],
          },
        ],
      });

      const callArgs = createLibp2p.mock.calls[0]?.[0];
      expect(callArgs.addresses.listen).toStrictEqual([
        '/webrtc',
        '/p2p-circuit',
        '/ip4/0.0.0.0/udp/0/quic-v1',
      ]);
    });

    it('merges multiple transport listen addresses', async () => {
      factory = await createFactory({
        directTransports: [
          {
            transport: {},
            listenAddresses: ['/ip4/0.0.0.0/udp/0/quic-v1'],
          },
          {
            transport: {},
            listenAddresses: ['/ip4/0.0.0.0/tcp/4001'],
          },
        ],
      });

      const callArgs = createLibp2p.mock.calls[0]?.[0];
      expect(callArgs.addresses.listen).toStrictEqual([
        '/webrtc',
        '/p2p-circuit',
        '/ip4/0.0.0.0/udp/0/quic-v1',
        '/ip4/0.0.0.0/tcp/4001',
      ]);
    });

    it('does not add direct transports when not provided', async () => {
      factory = await createFactory();

      const callArgs = createLibp2p.mock.calls[0]?.[0];
      expect(callArgs.transports).toHaveLength(4);
      expect(callArgs.addresses.listen).toStrictEqual([
        '/webrtc',
        '/p2p-circuit',
      ]);
    });
  });

  describe('getListenAddresses', () => {
    it('returns multiaddr strings from libp2p', async () => {
      factory = await createFactory();

      const addresses = factory.getListenAddresses();

      expect(addresses).toStrictEqual([
        '/ip4/127.0.0.1/udp/12345/quic-v1/p2p/test-peer-id',
        '/ip4/127.0.0.1/tcp/9001/ws/p2p/test-peer-id',
      ]);
    });

    it('returns empty array after stop', async () => {
      factory = await createFactory();
      await factory.stop();

      const addresses = factory.getListenAddresses();

      expect(addresses).toStrictEqual([]);
    });
  });

  describe('candidateAddressStrings with direct addresses', () => {
    it('places direct address hints first', async () => {
      factory = await createFactory();

      const directHint = '/ip4/192.168.1.1/udp/4001/quic-v1/p2p/peer123';
      const addresses = factory.candidateAddressStrings('peer123', [
        directHint,
      ]);

      expect(addresses[0]).toBe(directHint);
      // Relay addresses follow
      expect(addresses[1]).toContain('/p2p-circuit/');
    });

    it('does not wrap direct address hints in relay pattern', async () => {
      factory = await createFactory();

      const directHint = '/ip4/192.168.1.1/udp/4001/quic-v1/p2p/peer123';
      const addresses = factory.candidateAddressStrings('peer123', [
        directHint,
      ]);

      // The direct address should appear exactly as provided
      expect(addresses).toContain(directHint);
      // It should NOT be wrapped in a relay circuit
      const wrappedDirectAddresses = addresses.filter(
        (addr: string) =>
          addr.includes('/p2p-circuit/') && addr.includes('quic-v1'),
      );
      expect(wrappedDirectAddresses).toHaveLength(0);
    });

    it('handles mix of direct and relay hints', async () => {
      factory = await createFactory();

      const directHint = '/ip4/192.168.1.1/udp/4001/quic-v1/p2p/peer123';
      const relayHint = '/dns4/hint.example/tcp/443/wss/p2p/hint';
      const addresses = factory.candidateAddressStrings('peer123', [
        directHint,
        relayHint,
      ]);

      // Direct addresses come first
      expect(addresses[0]).toBe(directHint);
      // Relay hint addresses follow
      expect(addresses[1]).toContain('hint.example');
      expect(addresses[1]).toContain('/p2p-circuit/');
    });

    it('skips malformed hints and still generates relay addresses', async () => {
      factory = await createFactory();

      const addresses = factory.candidateAddressStrings('peer123', [
        'not-a-valid-multiaddr',
      ]);

      // Malformed hint is skipped, relay addresses still generated
      expect(addresses).not.toContain('not-a-valid-multiaddr');
      expect(addresses.length).toBeGreaterThan(0);
      expect(addresses.every((a) => a.includes('/p2p-circuit/'))).toBe(true);
    });
  });
});
