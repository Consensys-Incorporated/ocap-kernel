import type { JsonRpcCall } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { PostMessageTarget } from '@metamask/streams/browser';
import { PostMessageDuplexStream } from '@metamask/streams/browser';
import type { JsonRpcResponse } from '@metamask/utils';
import { delay } from '@ocap/repo-tools/test-utils';
import { TestDuplexStream } from '@ocap/repo-tools/test-utils/streams';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  connectToKernel,
  receiveInternalConnections,
  COMMS_CONTROL_CHANNEL_NAME,
} from './internal-connections.ts';

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-id'),
}));

vi.mock('@metamask/streams/browser', async () => {
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const { TestDuplexStream } = await import(
    '@ocap/repo-tools/test-utils/streams'
  );

  type MockPostMessageTarget = PostMessageTarget & {
    onmessage: (event: MessageEvent) => void;
  };

  type MockStreamOptions = {
    onEnd: () => void;
    messageTarget: MockPostMessageTarget;
  };

  // @ts-expect-error: We're overriding the static make() method
  class MockStream extends TestDuplexStream {
    static instances: MockStream[] = [];

    messageTarget: MockPostMessageTarget;

    constructor({ onEnd, messageTarget }: MockStreamOptions) {
      super(() => undefined, { onEnd });
      MockStream.instances.push(this);
      this.messageTarget = messageTarget;
      this.messageTarget.onmessage = (event) => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.receiveInput(event.data);
      };
    }

    static async make(options: MockStreamOptions): Promise<MockStream> {
      const stream = new MockStream(options);
      await stream.completeSynchronization();
      return stream;
    }
  }

  return {
    PostMessageDuplexStream: MockStream,
  };
});

const makeClusterConfig = () => ({
  vats: {
    alice: {},
  },
});

// Mock BroadcastChannel
class MockBroadcastChannel {
  static channels: Map<string, MockBroadcastChannel> = new Map();

  static closedChannels: Map<string, MockBroadcastChannel> = new Map();

  static reset(): void {
    MockBroadcastChannel.channels.clear();
    MockBroadcastChannel.closedChannels.clear();
  }

  onmessage: ((event: MessageEvent) => void) | null = null;

  onmessageerror: ((event: MessageEvent) => void) | null = null;

  name: string;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.channels.set(name, this);
  }

  postMessage: (message: unknown) => void = vi.fn((message: unknown): void => {
    // Simulate broadcasting to other channels with the same name
    MockBroadcastChannel.channels.forEach((channel) => {
      if (channel !== this && channel.name === this.name && channel.onmessage) {
        channel.onmessage(new MessageEvent('message', { data: message }));
      }
    });
  });

  close(): void {
    MockBroadcastChannel.channels.delete(this.name);
    MockBroadcastChannel.closedChannels.set(this.name, this);
  }
}

vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

const makeMockLogger = () =>
  ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }) as unknown as Logger;

describe('internal-connections', () => {
  const streamInstances: PostMessageDuplexStream<unknown, unknown>[] =
    // @ts-expect-error: This class is mocked
    PostMessageDuplexStream.instances;

  beforeEach(() => {
    MockBroadcastChannel.reset();
    streamInstances.length = 0;
  });

  describe('connectToKernel', () => {
    it('should establish a connection and return a stream', async () => {
      const logger = makeMockLogger();
      const connectionPromise = connectToKernel({
        label: 'internal-process',
        logger,
      });

      // Verify that the control channel receives the init message
      const controlChannel = MockBroadcastChannel.closedChannels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      )!;
      expect(controlChannel).toBeDefined();
      expect(controlChannel.postMessage).toHaveBeenCalledWith({
        method: 'init',
        params: { channelName: 'internal-process-test-id' },
      });

      const stream = await connectionPromise;
      expect(stream).toBeInstanceOf(TestDuplexStream);
    });

    it('should handle comms channel message errors', async () => {
      const logger = makeMockLogger();
      await connectToKernel({ label: 'internal-process', logger });
      expect(MockBroadcastChannel.channels.size).toBe(1);
      expect(MockBroadcastChannel.closedChannels.size).toBe(1);

      const commsChannel = MockBroadcastChannel.channels.get(
        'internal-process-test-id',
      );
      expect(commsChannel).toBeDefined();

      // Trigger message error
      const errorEvent = new MessageEvent('messageerror', {
        data: new Error('Test error'),
      });
      commsChannel?.onmessageerror?.(errorEvent);

      // Verify comms channel is closed
      expect(MockBroadcastChannel.channels.size).toBe(0);
      expect(MockBroadcastChannel.closedChannels.size).toBe(2);
    });
  });

  describe('receiveInternalConnections', () => {
    const logger = makeMockLogger();

    const mockHandleMessage = vi.fn(
      async (request: JsonRpcCall): Promise<JsonRpcResponse | undefined> =>
        'id' in request
          ? {
              id: 1,
              jsonrpc: '2.0' as const,
              result: { vats: [], clusterConfig: makeClusterConfig() },
            }
          : undefined,
    );

    it('should handle new internal process connections', async () => {
      receiveInternalConnections({
        handler: mockHandleMessage,
        logger,
      });

      // Simulate a new internal process connecting
      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );
      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel' },
          },
        }),
      );

      expect(MockBroadcastChannel.channels.size).toBe(2);
      expect(logger.debug).toHaveBeenCalledWith(
        'Connecting to internal process "internal-process-channel"',
      );
    });

    it('should handle valid message', async () => {
      receiveInternalConnections({
        handler: mockHandleMessage,
        logger,
      });

      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );
      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel' },
          },
        }),
      );

      await delay();
      const commsStream = streamInstances[0]!;
      expect(commsStream).toBeDefined();
      const commsStreamWriteSpy = vi.spyOn(commsStream, 'write');

      const commsChannel = MockBroadcastChannel.channels.get(
        'internal-process-channel',
      )!;
      commsChannel.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'getStatus',
            params: null,
            id: 1,
          },
        }),
      );
      await delay();

      expect(mockHandleMessage).toHaveBeenCalledWith({
        method: 'getStatus',
        params: null,
        id: 1,
      });
      expect(commsStreamWriteSpy).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        id: 1,
        result: { vats: [], clusterConfig: makeClusterConfig() },
      });
    });

    it('should handle JSON-RPC notifications', async () => {
      receiveInternalConnections({
        handler: mockHandleMessage,
        logger,
      });

      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );
      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel' },
          },
        }),
      );

      await delay();
      const commsStream = streamInstances[0]!;
      expect(commsStream).toBeDefined();
      const commsStreamWriteSpy = vi.spyOn(commsStream, 'write');

      const commsChannel = MockBroadcastChannel.channels.get(
        'internal-process-channel',
      )!;
      commsChannel.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'notification',
          },
        }),
      );

      await delay();

      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
      expect(mockHandleMessage).toHaveBeenCalledWith({
        method: 'notification',
      });
      expect(commsStreamWriteSpy).not.toHaveBeenCalled();
    });

    it('should handle multiple simultaneous connections', async () => {
      receiveInternalConnections({
        handler: mockHandleMessage,
        logger,
      });

      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );
      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel-1' },
          },
        }),
      );
      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel-2' },
          },
        }),
      );

      expect(MockBroadcastChannel.channels.size).toBe(3);
      expect(logger.debug).toHaveBeenCalledWith(
        'Connecting to internal process "internal-process-channel-1"',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        'Connecting to internal process "internal-process-channel-2"',
      );
    });

    it('should forget ids of closed channels', async () => {
      receiveInternalConnections({
        handler: mockHandleMessage,
        logger,
      });
      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );

      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel' },
          },
        }),
      );
      await delay();
      expect(MockBroadcastChannel.channels.size).toBe(2);

      const commsChannel = MockBroadcastChannel.channels.get(
        'internal-process-channel',
      );
      commsChannel?.onmessageerror?.(
        new MessageEvent('messageerror', { data: new Error('Test error') }),
      );
      await delay();
      expect(MockBroadcastChannel.channels.size).toBe(1);

      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel' },
          },
        }),
      );
      await delay();
      expect(MockBroadcastChannel.channels.size).toBe(2);
    });

    it('should reject duplicate connections', () => {
      receiveInternalConnections({
        handler: mockHandleMessage,
        logger,
      });
      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );

      // Connect twice with the same channel name
      const duplicateMessage = new MessageEvent('message', {
        data: {
          method: 'init',
          params: { channelName: 'duplicate-channel' },
        },
      });

      controlChannel?.onmessage?.(duplicateMessage);
      controlChannel?.onmessage?.(duplicateMessage);

      expect(logger.error).toHaveBeenCalledWith(
        'Already connected to internal process "duplicate-channel"',
      );
    });

    it('should reject invalid control commands', () => {
      receiveInternalConnections({
        handler: mockHandleMessage,
        logger,
      });
      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );

      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            invalid: 'command',
          },
        }),
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Received invalid internal comms control message/u,
        ),
      );
    });

    it('should handle comms channel message errors', async () => {
      receiveInternalConnections({
        handler: mockHandleMessage,
        logger,
      });

      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );
      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel' },
          },
        }),
      );
      await delay();

      const commsChannel = MockBroadcastChannel.channels.get(
        'internal-process-channel',
      );
      commsChannel?.onmessageerror?.(
        new MessageEvent('messageerror', { data: new Error('Test error') }),
      );
      await delay();

      expect(logger.error).toHaveBeenCalledWith(
        'Error handling message from internal process "internal-process-channel":',
        expect.any(Error),
      );
    });

    it('should handle messages with handlerPromise after resolution', async () => {
      const handlerPromise = Promise.resolve(mockHandleMessage);

      receiveInternalConnections({
        handlerPromise,
        logger,
      });

      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );
      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel' },
          },
        }),
      );

      await delay();
      const commsStream = streamInstances[0]!;
      expect(commsStream).toBeDefined();
      const commsStreamWriteSpy = vi.spyOn(commsStream, 'write');

      const commsChannel = MockBroadcastChannel.channels.get(
        'internal-process-channel',
      )!;

      // Send first message
      commsChannel.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'getStatus',
            params: null,
            id: 1,
          },
        }),
      );
      await delay();

      expect(mockHandleMessage).toHaveBeenCalledWith({
        method: 'getStatus',
        params: null,
        id: 1,
      });
      expect(commsStreamWriteSpy).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        id: 1,
        result: { vats: [], clusterConfig: makeClusterConfig() },
      });

      // Send second message to verify caching (handler should be used directly)
      commsChannel.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'getStatus',
            params: null,
            id: 2,
          },
        }),
      );
      await delay();

      expect(mockHandleMessage).toHaveBeenCalledTimes(2);
      expect(commsStreamWriteSpy).toHaveBeenCalledTimes(2);
    });

    it('should queue messages until handlerPromise resolves', async () => {
      let resolveHandler: (handler: typeof mockHandleMessage) => void;
      const handlerPromise = new Promise<typeof mockHandleMessage>(
        (resolve) => {
          resolveHandler = resolve;
        },
      );

      receiveInternalConnections({
        handlerPromise,
        logger,
      });

      const controlChannel = MockBroadcastChannel.channels.get(
        COMMS_CONTROL_CHANNEL_NAME,
      );
      controlChannel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'init',
            params: { channelName: 'internal-process-channel' },
          },
        }),
      );

      await delay();
      const commsStream = streamInstances[0]!;
      expect(commsStream).toBeDefined();
      const commsStreamWriteSpy = vi.spyOn(commsStream, 'write');

      const commsChannel = MockBroadcastChannel.channels.get(
        'internal-process-channel',
      )!;

      // Send message before handler is ready
      commsChannel.onmessage?.(
        new MessageEvent('message', {
          data: {
            method: 'getStatus',
            params: null,
            id: 1,
          },
        }),
      );

      // Handler should not be called yet
      await delay();
      expect(mockHandleMessage).not.toHaveBeenCalled();
      expect(commsStreamWriteSpy).not.toHaveBeenCalled();

      // Now resolve the handler
      resolveHandler!(mockHandleMessage);
      await delay();

      // Now the message should be handled
      expect(mockHandleMessage).toHaveBeenCalledWith({
        method: 'getStatus',
        params: null,
        id: 1,
      });
      expect(commsStreamWriteSpy).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        id: 1,
        result: { vats: [], clusterConfig: makeClusterConfig() },
      });
    });
  });
});
