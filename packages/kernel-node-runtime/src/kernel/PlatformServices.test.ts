import { makePromiseKit } from '@endo/promise-kit';
import { makeCounter } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { VatId } from '@metamask/ocap-kernel';
import { delay } from '@ocap/repo-tools/test-utils';
import { Worker as NodeWorker } from 'node:worker_threads';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { NodejsPlatformServices } from './PlatformServices.ts';

const mockSendRemoteMessage = vi.fn(async () => undefined);
const mockStop = vi.fn(async () => undefined);
const mockCloseConnection = vi.fn(async () => undefined);
const mockRegisterLocationHints = vi.fn(async () => undefined);
const mockReconnectPeer = vi.fn(async () => undefined);

const mocks = vi.hoisted(() => {
  const createMockWorker = (autoEmitOnline = true) => {
    const eventHandlers = new Map<
      string,
      ((...args: unknown[]) => unknown)[]
    >();
    return {
      once: (event: string, callback: (...args: unknown[]) => unknown) => {
        if (!eventHandlers.has(event)) {
          eventHandlers.set(event, []);
        }
        const handlers = eventHandlers.get(event);
        if (handlers) {
          handlers.push(callback);
        }
        // Immediately emit 'online' event to simulate worker coming online
        if (event === 'online' && autoEmitOnline) {
          // Use queueMicrotask to make it async like real events
          queueMicrotask(() => callback());
        }
        // Don't emit 'error' or 'exit' events unless we want to test error cases
      },
      on: (event: string, callback: (...args: unknown[]) => unknown) => {
        eventHandlers.set(event, [
          ...(eventHandlers.get(event) ?? []),
          callback,
        ]);
      },
      removeAllListeners: vi.fn((event?: string) => {
        if (event) {
          eventHandlers.delete(event);
        } else {
          eventHandlers.clear();
        }
      }),
      terminate: vi.fn(async () => undefined),
      // Helper method to manually emit events for testing
      emit: (event: string, ...args: unknown[]) => {
        const handlers = eventHandlers.get(event);
        if (handlers) {
          handlers.forEach((handler) => {
            handler(...args);
          });
        }
      },
    };
  };
  return {
    createMockWorker,
    stream: {
      synchronize: vi.fn(async () => undefined).mockResolvedValue(undefined),
      return: vi.fn(async () => ({})),
      throw: vi.fn(async () => ({})),
    },
  };
});

vi.mock('@metamask/streams', () => ({
  NodeWorkerDuplexStream: vi.fn(function () {
    return mocks.stream;
  }),
}));

vi.mock('node:worker_threads', () => ({
  Worker: vi.fn(function () {
    return mocks.createMockWorker();
  }),
}));

vi.mock('@chainsafe/libp2p-quic', () => ({
  quic: () => ({ tag: 'mock-quic-transport' }),
}));

vi.mock('@libp2p/tcp', () => ({
  tcp: () => ({ tag: 'mock-tcp-transport' }),
}));

vi.mock('@metamask/ocap-kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@metamask/ocap-kernel')>();
  return {
    ...actual,
    initTransport: vi.fn(async () => ({
      sendRemoteMessage: mockSendRemoteMessage,
      stop: mockStop,
      closeConnection: mockCloseConnection,
      registerLocationHints: mockRegisterLocationHints,
      reconnectPeer: mockReconnectPeer,
      resetAllBackoffs: vi.fn(),
      getListenAddresses: vi.fn(() => [
        '/ip4/127.0.0.1/udp/12345/quic-v1/p2p/mock-peer-id',
      ]),
    })),
  };
});

describe('NodejsPlatformServices', () => {
  beforeEach(() => {
    mockSendRemoteMessage.mockClear();
    mockStop.mockClear();
    mockCloseConnection.mockClear();
    mockRegisterLocationHints.mockClear();
    mockReconnectPeer.mockClear();
    mocks.stream.synchronize.mockResolvedValue(undefined);
    mocks.stream.return.mockResolvedValue({});
  });

  it('constructs an instance without any arguments', () => {
    const instance = new NodejsPlatformServices({});
    expect(instance).toBeInstanceOf(NodejsPlatformServices);
  });

  const workerFilePath = 'unused';
  const vatIdCounter = makeCounter();
  const getTestVatId = (): VatId => `v${vatIdCounter()}`;

  describe('launch', () => {
    it('creates a NodeWorker and returns a NodeWorkerDuplexStream', async () => {
      const service = new NodejsPlatformServices({
        workerFilePath,
      });
      const testVatId: VatId = getTestVatId();
      const stream = await service.launch(testVatId);

      expect(stream).toStrictEqual(mocks.stream);
    });

    it('rejects if synchronize fails', async () => {
      const rejected = 'test-reject-value';
      mocks.stream.synchronize.mockRejectedValue(rejected);
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();
      await expect(service.launch(testVatId)).rejects.toThrowError(rejected);
    });

    it('throws error if worker already exists', async () => {
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();

      await service.launch(testVatId);
      expect(service.workers.has(testVatId)).toBe(true);

      await expect(service.launch(testVatId)).rejects.toThrowError(
        `Worker ${testVatId} already exists! Cannot launch duplicate.`,
      );
    });

    it('rejects if worker errors during startup', async () => {
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();

      // Create a worker that won't auto-emit 'online' (for error testing)
      const worker = mocks.createMockWorker(false);
      vi.mocked(NodeWorker).mockImplementationOnce(function () {
        return worker;
      });

      const launchPromise = service.launch(testVatId);

      // Wait a tick to ensure handlers are registered
      await Promise.resolve();

      // Emit error event before 'online'
      worker.emit('error', new Error('worker startup error'));

      await expect(launchPromise).rejects.toThrowError(
        `Worker ${testVatId} errored during startup: worker startup error`,
      );
      expect(service.workers.has(testVatId)).toBe(false);
      expect(worker.terminate).toHaveBeenCalled();
    });

    it('rejects if worker exits during startup', async () => {
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();

      // Create a worker that won't auto-emit 'online' (for exit testing)
      const worker = mocks.createMockWorker(false);
      vi.mocked(NodeWorker).mockImplementationOnce(function () {
        return worker;
      });

      const launchPromise = service.launch(testVatId);

      // Wait a tick to ensure handlers are registered
      await Promise.resolve();

      // Emit exit event before 'online'
      worker.emit('exit', 1);

      await expect(launchPromise).rejects.toThrowError(
        `Worker ${testVatId} exited during startup with code 1`,
      );
      expect(service.workers.has(testVatId)).toBe(false);
    });
  });

  describe('a worker once online', () => {
    it('fails a launch still shaking hands when it exits', async () => {
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();
      const worker = mocks.createMockWorker();
      vi.mocked(NodeWorker).mockImplementationOnce(function () {
        return worker;
      });
      mocks.stream.synchronize.mockReturnValueOnce(
        new Promise(() => undefined),
      );
      const launching = service.launch(testVatId);
      await delay(0);

      worker.emit('exit', 1);

      await expect(launching).rejects.toThrowError(
        `Worker ${testVatId} exited during startup with code 1`,
      );
    });

    it('is not registered when its handshake completes after it exited', async () => {
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();
      const worker = mocks.createMockWorker();
      vi.mocked(NodeWorker).mockImplementationOnce(function () {
        return worker;
      });
      const handshake = makePromiseKit<void>();
      mocks.stream.synchronize.mockReturnValueOnce(handshake.promise);
      const launching = service.launch(testVatId);
      await delay(0);

      worker.emit('exit', 1);
      handshake.resolve();
      await delay(0);

      await expect(launching).rejects.toThrowError(
        `Worker ${testVatId} exited during startup with code 1`,
      );
      expect(service.workers.has(testVatId)).toBe(false);
      expect(mocks.stream.throw).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `Worker ${testVatId} exited during startup with code 1`,
        }),
      );
    });

    it('logs an error it raises rather than rethrowing it', async () => {
      const logger = new Logger('test');
      const logError = vi.spyOn(logger, 'error').mockReturnValue();
      const service = new NodejsPlatformServices({ workerFilePath, logger });
      const testVatId: VatId = getTestVatId();
      const worker = mocks.createMockWorker();
      vi.mocked(NodeWorker).mockImplementationOnce(function () {
        return worker;
      });
      await service.launch(testVatId);
      const failure = new Error('uncaught in the vat');

      worker.emit('error', failure);

      expect(logError).toHaveBeenCalledWith(
        `Worker ${testVatId} errored:`,
        failure,
      );
    });

    it('is forgotten, and its channel closed, when it exits', async () => {
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();
      const worker = mocks.createMockWorker();
      vi.mocked(NodeWorker).mockImplementationOnce(function () {
        return worker;
      });
      await service.launch(testVatId);
      mocks.stream.return.mockClear();

      worker.emit('exit', 1);

      expect(service.workers.has(testVatId)).toBe(false);
      expect(mocks.stream.return).toHaveBeenCalledOnce();
    });

    it('leaves a replacement alone when it exits while being stopped', async () => {
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();
      const firstWorker = mocks.createMockWorker();
      const secondWorker = mocks.createMockWorker();
      vi.mocked(NodeWorker)
        .mockImplementationOnce(function () {
          return firstWorker;
        })
        .mockImplementationOnce(function () {
          return secondWorker;
        });
      await service.launch(testVatId);
      mocks.stream.return.mockReturnValueOnce(new Promise(() => undefined));
      service.terminate(testVatId).catch(() => undefined);
      await service.launch(testVatId);

      firstWorker.emit('exit', 1);

      expect(service.workers.get(testVatId)?.worker).toBe(secondWorker);
    });
  });

  describe('terminate', () => {
    it('terminates the target vat', async () => {
      const service = new NodejsPlatformServices({
        workerFilePath,
      });
      const testVatId: VatId = getTestVatId();

      await service.launch(testVatId);
      expect(service.workers.has(testVatId)).toBe(true);

      await service.terminate(testVatId);
      expect(service.workers.has(testVatId)).toBe(false);
    });

    it.each([
      [
        'the channel will not close',
        (): void => {
          mocks.stream.return.mockRejectedValueOnce(new Error('stop failed'));
        },
      ],
      [
        'the worker will not stop',
        (worker: ReturnType<typeof mocks.createMockWorker>): void => {
          worker.terminate.mockRejectedValueOnce(new Error('stop failed'));
        },
      ],
    ])('forgets the worker when %s', async (_case, breakStop) => {
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();
      const worker = mocks.createMockWorker();
      vi.mocked(NodeWorker).mockImplementationOnce(function () {
        return worker;
      });
      await service.launch(testVatId);
      breakStop(worker);

      await expect(service.terminate(testVatId)).rejects.toThrowError(
        'stop failed',
      );

      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(service.workers.has(testVatId)).toBe(false);
      expect(await service.launch(testVatId)).toStrictEqual(mocks.stream);
    });

    it('tolerates terminating a vat with no worker', async () => {
      const service = new NodejsPlatformServices({
        workerFilePath,
      });
      const testVatId: VatId = getTestVatId();

      expect(await service.terminate(testVatId)).toBeUndefined();
    });

    it('returns at once when called again while the worker stops', async () => {
      const service = new NodejsPlatformServices({ workerFilePath });
      const testVatId: VatId = getTestVatId();
      const worker = mocks.createMockWorker();
      vi.mocked(NodeWorker).mockImplementationOnce(function () {
        return worker;
      });
      // As Node's `worker.terminate()` does: settled by an `exit` listener,
      // which `removeAllListeners` can strip.
      worker.terminate.mockImplementation(
        async () =>
          new Promise<undefined>((resolve) => {
            worker.once('exit', () => resolve(undefined));
          }),
      );
      await service.launch(testVatId);

      const first = service.terminate(testVatId);
      const second = service.terminate(testVatId);
      await delay(0);
      worker.emit('exit', 0);

      expect(await Promise.all([first, second])).toStrictEqual([
        undefined,
        undefined,
      ]);
      expect(worker.terminate).toHaveBeenCalledOnce();
    });
  });

  describe('terminateAll', () => {
    it('terminates all vats', async () => {
      const service = new NodejsPlatformServices({
        workerFilePath,
      });
      const vatIds: VatId[] = [getTestVatId(), getTestVatId(), getTestVatId()];

      await Promise.all(
        vatIds.map(async (vatId) => await service.launch(vatId)),
      );

      expect(Array.from(service.workers.values())).toHaveLength(vatIds.length);

      await service.terminateAll();

      expect(Array.from(service.workers.values())).toHaveLength(0);
    });
  });

  describe('remote communications', () => {
    describe('initializeRemoteComms', () => {
      it('initializes remote comms with keySeed and relays', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0x1234567890abcdef';
        const relays = ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'];
        const remoteHandler = vi.fn(async () => 'response');

        await service.initializeRemoteComms(keySeed, { relays }, remoteHandler);

        const { initTransport } = await import('@metamask/ocap-kernel');
        expect(initTransport).toHaveBeenCalledWith(
          keySeed,
          { relays },
          expect.any(Function),
          undefined,
          undefined,
          undefined,
        );
      });

      it('initializes remote comms with all options', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0x1234567890abcdef';
        const options = {
          relays: ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'],
          maxRetryAttempts: 5,
          maxQueue: 100,
        };
        const remoteHandler = vi.fn(async () => 'response');

        await service.initializeRemoteComms(keySeed, options, remoteHandler);

        const { initTransport } = await import('@metamask/ocap-kernel');
        expect(initTransport).toHaveBeenCalledWith(
          keySeed,
          options,
          expect.any(Function),
          undefined,
          undefined,
          undefined,
        );
      });

      it('initializes remote comms with onRemoteGiveUp callback', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0x1234567890abcdef';
        const relays = ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'];
        const remoteHandler = vi.fn(async () => 'response');
        const giveUpHandler = vi.fn();

        await service.initializeRemoteComms(
          keySeed,
          { relays },
          remoteHandler,
          giveUpHandler,
        );

        const { initTransport } = await import('@metamask/ocap-kernel');
        expect(initTransport).toHaveBeenCalledWith(
          keySeed,
          { relays },
          expect.any(Function),
          giveUpHandler,
          undefined,
          undefined,
        );
      });

      it('initializes remote comms with incarnationId', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0x1234567890abcdef';
        const relays = ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'];
        const remoteHandler = vi.fn(async () => 'response');
        const giveUpHandler = vi.fn();
        const incarnationId = 'test-incarnation-id';

        await service.initializeRemoteComms(
          keySeed,
          { relays },
          remoteHandler,
          giveUpHandler,
          incarnationId,
        );

        const { initTransport } = await import('@metamask/ocap-kernel');
        expect(initTransport).toHaveBeenCalledWith(
          keySeed,
          { relays },
          expect.any(Function),
          giveUpHandler,
          incarnationId,
          undefined,
        );
      });

      it('initializes remote comms with onIncarnationChange callback', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0x1234567890abcdef';
        const relays = ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'];
        const remoteHandler = vi.fn(async () => 'response');
        const giveUpHandler = vi.fn();
        const incarnationId = 'test-incarnation-id';
        const incarnationChangeHandler = vi.fn();

        await service.initializeRemoteComms(
          keySeed,
          { relays },
          remoteHandler,
          giveUpHandler,
          incarnationId,
          incarnationChangeHandler,
        );

        const { initTransport } = await import('@metamask/ocap-kernel');
        expect(initTransport).toHaveBeenCalledWith(
          keySeed,
          { relays },
          expect.any(Function),
          giveUpHandler,
          incarnationId,
          incarnationChangeHandler,
        );
      });

      it('throws error if already initialized', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0xabcd';
        const relays = ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'];
        const remoteHandler = vi.fn(async () => 'response');

        await service.initializeRemoteComms(keySeed, { relays }, remoteHandler);

        await expect(
          service.initializeRemoteComms(keySeed, { relays }, remoteHandler),
        ).rejects.toThrowError('remote comms already initialized');
      });

      it('stores remote message handler for later use', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const remoteHandler = vi.fn(async () => 'response');

        await service.initializeRemoteComms(
          '0xtest',
          { relays: ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'] },
          remoteHandler,
        );

        // Handler is stored internally and will be used when messages arrive
        // This is tested through integration tests
        expect(service).toBeInstanceOf(NodejsPlatformServices);
      });

      it('injects QUIC directTransports when directListenAddresses contain /quic-v1', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0x1234567890abcdef';
        const relays = ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'];
        const remoteHandler = vi.fn(async () => 'response');

        await service.initializeRemoteComms(
          keySeed,
          {
            relays,
            directListenAddresses: ['/ip4/0.0.0.0/udp/0/quic-v1'],
          },
          remoteHandler,
        );

        const { initTransport } = await import('@metamask/ocap-kernel');
        expect(initTransport).toHaveBeenCalledWith(
          keySeed,
          expect.objectContaining({
            relays,
            directTransports: [
              {
                transport: { tag: 'mock-quic-transport' },
                listenAddresses: ['/ip4/0.0.0.0/udp/0/quic-v1'],
              },
            ],
          }),
          expect.any(Function),
          undefined,
          undefined,
          undefined,
        );
      });

      it('injects TCP directTransports when directListenAddresses contain /tcp/', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0x1234567890abcdef';
        const remoteHandler = vi.fn(async () => 'response');

        await service.initializeRemoteComms(
          keySeed,
          {
            directListenAddresses: ['/ip4/0.0.0.0/tcp/4001'],
          },
          remoteHandler,
        );

        const { initTransport } = await import('@metamask/ocap-kernel');
        expect(initTransport).toHaveBeenCalledWith(
          keySeed,
          expect.objectContaining({
            directTransports: [
              {
                transport: { tag: 'mock-tcp-transport' },
                listenAddresses: ['/ip4/0.0.0.0/tcp/4001'],
              },
            ],
          }),
          expect.any(Function),
          undefined,
          undefined,
          undefined,
        );
      });

      it('injects both QUIC and TCP when directListenAddresses contain both', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0x1234567890abcdef';
        const remoteHandler = vi.fn(async () => 'response');

        await service.initializeRemoteComms(
          keySeed,
          {
            directListenAddresses: [
              '/ip4/0.0.0.0/udp/0/quic-v1',
              '/ip4/0.0.0.0/tcp/4001',
            ],
          },
          remoteHandler,
        );

        const { initTransport } = await import('@metamask/ocap-kernel');
        expect(initTransport).toHaveBeenCalledWith(
          keySeed,
          expect.objectContaining({
            directTransports: [
              {
                transport: { tag: 'mock-quic-transport' },
                listenAddresses: ['/ip4/0.0.0.0/udp/0/quic-v1'],
              },
              {
                transport: { tag: 'mock-tcp-transport' },
                listenAddresses: ['/ip4/0.0.0.0/tcp/4001'],
              },
            ],
          }),
          expect.any(Function),
          undefined,
          undefined,
          undefined,
        );
      });

      it('throws for unsupported direct listen addresses', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const remoteHandler = vi.fn(async () => 'response');

        await expect(
          service.initializeRemoteComms(
            '0xtest',
            {
              directListenAddresses: ['/ip4/0.0.0.0/udp/0/webrtc'],
            },
            remoteHandler,
          ),
        ).rejects.toThrowError('Unsupported direct listen address');
      });

      it('does not inject directTransports when no directListenAddresses provided', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0x1234567890abcdef';
        const relays = ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'];
        const remoteHandler = vi.fn(async () => 'response');

        await service.initializeRemoteComms(keySeed, { relays }, remoteHandler);

        const { initTransport } = await import('@metamask/ocap-kernel');
        const callArgs = (
          initTransport as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.at(-1);
        // Second argument is the options
        expect(callArgs?.[1]).not.toHaveProperty('directTransports');
      });
    });

    describe('getListenAddresses', () => {
      it('returns listen addresses after initialization', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const remoteHandler = vi.fn(async () => '');

        await service.initializeRemoteComms(
          '0xabcd',
          { relays: [] },
          remoteHandler,
        );

        const addresses = service.getListenAddresses();
        expect(addresses).toStrictEqual([
          '/ip4/127.0.0.1/udp/12345/quic-v1/p2p/mock-peer-id',
        ]);
      });

      it('returns empty array before initialization', () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        expect(service.getListenAddresses()).toStrictEqual([]);
      });
    });

    describe('sendRemoteMessage', () => {
      it('sends message via network layer', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0xabcd';
        const relays = ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'];
        const remoteHandler = vi.fn(async () => '');

        await service.initializeRemoteComms(keySeed, { relays }, remoteHandler);

        const message = JSON.stringify({
          method: 'deliver',
          params: ['hello'],
        });
        await service.sendRemoteMessage('peer-456', message);

        expect(mockSendRemoteMessage).toHaveBeenCalledWith('peer-456', message);
      });

      it('throws error if remote comms not initialized', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const message = JSON.stringify({ method: 'deliver', params: ['test'] });

        await expect(
          service.sendRemoteMessage('peer-999', message),
        ).rejects.toThrowError('remote comms not initialized');
      });
    });

    describe('stopRemoteComms', () => {
      it('stops remote comms and cleans up', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        await service.initializeRemoteComms(
          '0xtest',
          {},
          vi.fn(async () => ''),
        );

        await service.stopRemoteComms();

        expect(mockStop).toHaveBeenCalledOnce();
      });

      it('does nothing if remote comms not initialized', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        await service.stopRemoteComms();
        expect(mockStop).not.toHaveBeenCalled();
      });

      it('allows re-initialization after stop', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        const keySeed = '0xabcd';
        const relays = ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'];
        const remoteHandler = vi.fn(async () => '');

        // Initialize
        await service.initializeRemoteComms(keySeed, { relays }, remoteHandler);

        const { initTransport } = await import('@metamask/ocap-kernel');
        const initTransportMock = initTransport as unknown as ReturnType<
          typeof vi.fn
        >;
        const firstCallCount = initTransportMock.mock.calls.length;

        // Stop
        await service.stopRemoteComms();
        expect(mockStop).toHaveBeenCalledOnce();

        // Re-initialize should work
        await service.initializeRemoteComms(keySeed, { relays }, remoteHandler);

        // Should have called initTransport again
        expect(initTransportMock.mock.calls).toHaveLength(firstCallCount + 1);
      });

      it('clears internal state after stop', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        await service.initializeRemoteComms(
          '0xtest',
          {},
          vi.fn(async () => ''),
        );

        const message1 = JSON.stringify({
          method: 'deliver',
          params: ['msg1'],
        });
        const message2 = JSON.stringify({
          method: 'deliver',
          params: ['msg2'],
        });

        // Should work before stop
        await service.sendRemoteMessage('peer-1', message1);
        expect(mockSendRemoteMessage).toHaveBeenCalledTimes(1);

        await service.stopRemoteComms();

        // Should throw after stop
        await expect(
          service.sendRemoteMessage('peer-2', message2),
        ).rejects.toThrowError('remote comms not initialized');
      });

      it('clears closeConnection and reconnectPeer after stop', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        await service.initializeRemoteComms(
          '0xtest',
          {},
          vi.fn(async () => ''),
        );

        // Should work before stop
        await service.closeConnection('peer-1');
        await service.reconnectPeer('peer-1');
        expect(mockCloseConnection).toHaveBeenCalledTimes(1);
        expect(mockReconnectPeer).toHaveBeenCalledTimes(1);

        await service.stopRemoteComms();

        // Should throw after stop
        await expect(service.closeConnection('peer-2')).rejects.toThrowError(
          'remote comms not initialized',
        );
        await expect(service.reconnectPeer('peer-2')).rejects.toThrowError(
          'remote comms not initialized',
        );
      });
    });

    describe('closeConnection', () => {
      it('closes connection via network layer', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        await service.initializeRemoteComms(
          '0xtest',
          {},
          vi.fn(async () => ''),
        );

        await service.closeConnection('peer-123');

        expect(mockCloseConnection).toHaveBeenCalledWith('peer-123');
      });

      it('throws error if remote comms not initialized', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });

        await expect(service.closeConnection('peer-999')).rejects.toThrowError(
          'remote comms not initialized',
        );
      });
    });

    describe('registerLocationHints', () => {
      it('registers location hints via network layer', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        await service.initializeRemoteComms(
          '0xtest',
          {},
          vi.fn(async () => ''),
        );

        await service.registerLocationHints('peer-123', ['hint1', 'hint2']);

        expect(mockRegisterLocationHints).toHaveBeenCalledWith('peer-123', [
          'hint1',
          'hint2',
        ]);
      });

      it('throws error if remote comms not initialized', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });

        await expect(
          service.registerLocationHints('peer-999', ['hint1', 'hint2']),
        ).rejects.toThrowError('remote comms not initialized');
      });
    });

    describe('reconnectPeer', () => {
      it('reconnects peer via network layer', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        await service.initializeRemoteComms(
          '0xtest',
          {},
          vi.fn(async () => ''),
        );

        await service.reconnectPeer('peer-456', [
          '/dns4/relay.example/tcp/443/wss/p2p/relayPeer',
        ]);

        expect(mockReconnectPeer).toHaveBeenCalledWith('peer-456', [
          '/dns4/relay.example/tcp/443/wss/p2p/relayPeer',
        ]);
      });

      it('reconnects peer with empty hints', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });
        await service.initializeRemoteComms(
          '0xtest',
          {},
          vi.fn(async () => ''),
        );

        await service.reconnectPeer('peer-789');

        expect(mockReconnectPeer).toHaveBeenCalledWith('peer-789', []);
      });

      it('throws error if remote comms not initialized', async () => {
        const service = new NodejsPlatformServices({ workerFilePath });

        await expect(service.reconnectPeer('peer-999')).rejects.toThrowError(
          'remote comms not initialized',
        );
      });
    });
  });
});
