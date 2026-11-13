import { delay, stringify } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { VatId, VatConfig } from '@metamask/ocap-kernel';
import { rpcErrors } from '@metamask/rpc-errors';
import type { JsonRpcResponse } from '@metamask/utils';
import { makeMockMessageTarget } from '@ocap/repo-tools/test-utils';
import { TestDuplexStream } from '@ocap/repo-tools/test-utils/streams';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { PlatformServicesClientStream } from './PlatformServicesClient.ts';
import { PlatformServicesClient } from './PlatformServicesClient.ts';

vi.mock('@metamask/streams/browser', async (importOriginal) => {
  // oxlint-disable-next-line typescript/no-shadow
  const { TestDuplexStream } =
    await import('@ocap/repo-tools/test-utils/streams');

  class MockStream extends TestDuplexStream {
    constructor() {
      super(() => undefined);
    }
  }

  return {
    ...(await importOriginal()),
    MessagePortDuplexStream: MockStream,
  };
});

type MessageEventWithPayload = MessageEvent & {
  payload:
    | {
        id: string;
        error: unknown;
      }
    | undefined;
};

const makeVatConfig = (sourceSpec: string = 'bogus.js'): VatConfig => ({
  sourceSpec,
});

const makeMessageEvent = <Response extends Partial<JsonRpcResponse>>(
  messageId: `m${number}`,
  payload: Response,
  port?: MessagePort,
): MessageEvent<Response> =>
  new MessageEvent('message', {
    data: { ...payload, id: messageId, jsonrpc: '2.0' },
    ports: port ? [port] : [],
  });

const makeLaunchReply = (messageId: `m${number}`): MessageEvent =>
  makeMessageEvent(
    messageId,
    {
      result: null,
    },
    new MessageChannel().port1,
  );

const makeNullReply = (messageId: `m${number}`): MessageEvent =>
  makeMessageEvent(messageId, {
    result: null,
  });

describe('PlatformServicesClient', () => {
  it('constructs with default logger', async () => {
    const stream = await TestDuplexStream.make(() => undefined);
    await stream.synchronize();
    const client = new PlatformServicesClient(
      stream as unknown as PlatformServicesClientStream,
    );
    expect(client).toBeDefined();
  });

  it('constructs using static factory method', async () => {
    const client = await PlatformServicesClient.make(makeMockMessageTarget());
    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(PlatformServicesClient);
  });

  describe('message handling', () => {
    let stream: TestDuplexStream;
    let clientLogger: Logger;
    let client: PlatformServicesClient;

    beforeEach(async () => {
      stream = await TestDuplexStream.make(() => undefined);
      await stream.synchronize();
      clientLogger = new Logger('test-client');
      client = new PlatformServicesClient(
        stream as unknown as PlatformServicesClientStream,
        clientLogger,
      );
    });

    it('rejects pending promises for error replies', async () => {
      const resultP = client.launch('v0' as VatId, makeVatConfig());

      await stream.receiveInput(
        makeMessageEvent('m1', {
          error: rpcErrors.internal('foo'),
        }),
      );

      await expect(resultP).rejects.toThrow('foo');
    });

    it('calls logger.error when receiving response with non-string id', async () => {
      const errorSpy = vi.spyOn(clientLogger, 'error');
      const unexpectedReply = new MessageEvent('message', {
        data: {
          id: 123,
          result: null,
          jsonrpc: '2.0',
        },
      });

      await stream.receiveInput(unexpectedReply);
      await delay(10);

      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenLastCalledWith(
        'Received response with unexpected id:',
        expect.any(String),
      );
    });

    it('calls logger.error when receiving message with unexpected port', async () => {
      const errorSpy = vi.spyOn(clientLogger, 'error');
      const unexpectedPortReply = makeMessageEvent(
        'm9',
        { result: null },
        new MessageChannel().port1,
      );

      await stream.receiveInput(unexpectedPortReply);
      await delay(10);

      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenLastCalledWith(
        'Received message with unexpected port:',
        expect.any(String),
      );
    });

    it('handles request with unknown method by sending error response', async () => {
      const outputs: MessageEventWithPayload[] = [];
      const newStream = await TestDuplexStream.make((message) => {
        outputs.push(message as unknown as MessageEventWithPayload);
      });
      // oxlint-disable-next-line no-new -- test setup
      new PlatformServicesClient(
        newStream as unknown as PlatformServicesClientStream,
      );

      await newStream.receiveInput(
        new MessageEvent('message', {
          data: {
            id: 'm1',
            jsonrpc: '2.0',
            method: 'unknownMethod',
            params: {},
          },
        }),
      );
      await delay(10);

      const errorResponse = outputs.find(
        (message) => message.payload?.id === 'm1' && 'error' in message.payload,
      );
      expect(errorResponse).toBeDefined();
    });

    describe('launch', () => {
      it('resolves with a duplex stream when receiving a launch reply', async () => {
        const vatId = 'v0' as VatId;
        const vatConfig = makeVatConfig();
        const result = client.launch(vatId, vatConfig);

        await delay(10);
        await stream.receiveInput(makeLaunchReply('m1'));

        // @metamask/streams is mocked
        expect(await result).toBeInstanceOf(TestDuplexStream);
      });

      it('throws an error when receiving reply without a port', async () => {
        const vatId = 'v0' as VatId;
        const vatConfig = makeVatConfig();
        const launchP = client.launch(vatId, vatConfig);
        const reply = makeNullReply('m1');

        await stream.receiveInput(reply);
        await expect(launchP).rejects.toThrow(
          `No port found for launch of: ${stringify({ vatId, vatConfig })}`,
        );
      });

      it('can be called before client is started', async () => {
        const newStream = await TestDuplexStream.make(() => undefined);
        await newStream.synchronize();
        const newClient = new PlatformServicesClient(
          newStream as unknown as PlatformServicesClientStream,
        );

        // Call launch before starting the client
        const launchPromise = newClient.launch('v0' as VatId, makeVatConfig());

        // Now send the launch reply
        await delay(10);
        await newStream.receiveInput(makeLaunchReply('m1'));

        // Launch should resolve successfully
        expect(await launchPromise).toBeInstanceOf(TestDuplexStream);
      });
    });

    describe('terminate', () => {
      it('resolves when receiving a terminate reply', async () => {
        const result = client.terminate('v0' as VatId);
        await stream.receiveInput(makeNullReply('m1'));
        await delay(10);

        expect(await result).toBeUndefined();
      });
    });

    describe('terminateAll', () => {
      it('resolves when receiving a terminateAll reply', async () => {
        const result = client.terminateAll();
        await stream.receiveInput(makeNullReply('m1'));
        await delay(10);

        expect(await result).toBeUndefined();
      });
    });

    describe('remote communications', () => {
      describe('initializeRemoteComms', () => {
        it('sends initializeRemoteComms request and resolves', async () => {
          const remoteHandler = vi.fn(async () => 'response');
          const result = client.initializeRemoteComms(
            '0xabcd',
            { relays: ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'] },
            remoteHandler,
          );
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });

        it('sends initializeRemoteComms with all options and resolves', async () => {
          const remoteHandler = vi.fn(async () => 'response');
          const result = client.initializeRemoteComms(
            '0xabcd',
            {
              relays: ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'],
              maxRetryAttempts: 5,
              maxQueue: 100,
            },
            remoteHandler,
          );
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });

        it('sends initializeRemoteComms with onRemoteGiveUp callback', async () => {
          const remoteHandler = vi.fn(async () => 'response');
          const giveUpHandler = vi.fn();
          const result = client.initializeRemoteComms(
            '0xabcd',
            { relays: ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'] },
            remoteHandler,
            giveUpHandler,
          );
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });

        it('filters undefined values from options', async () => {
          const remoteHandler = vi.fn(async () => 'response');
          const result = client.initializeRemoteComms(
            '0xabcd',
            {
              relays: ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'],
              maxRetryAttempts: undefined,
              maxQueue: undefined,
            },
            remoteHandler,
          );
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });
      });

      describe('sendRemoteMessage', () => {
        it('sends message to remote peer via RPC', async () => {
          const result = client.sendRemoteMessage('peer-456', 'hello');
          await delay(10);
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });
      });

      describe('stopRemoteComms', () => {
        it('sends stopRemoteComms request and resolves', async () => {
          const result = client.stopRemoteComms();
          await delay(10);
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });
      });

      describe('closeConnection', () => {
        it('sends closeConnection request and resolves', async () => {
          const result = client.closeConnection('peer-123');
          await delay(10);
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });
      });

      describe('registerLocationHints', () => {
        it('sends registerLocationHints request and resolves', async () => {
          const result = client.registerLocationHints('peer-123', [
            'hint1',
            'hint2',
          ]);
          await delay(10);
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });
      });

      describe('reconnectPeer', () => {
        it('sends reconnectPeer request with hints and resolves', async () => {
          const result = client.reconnectPeer('peer-456', [
            '/dns4/relay.example/tcp/443/wss/p2p/relayPeer',
          ]);
          await delay(10);
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });

        it('sends reconnectPeer request with empty hints and resolves', async () => {
          const result = client.reconnectPeer('peer-789');
          await delay(10);
          await stream.receiveInput(makeNullReply('m1'));
          expect(await result).toBeUndefined();
        });
      });

      describe('remoteDeliver', () => {
        it('throws error when handler not set', async () => {
          // Client without initialized remote comms
          const outputs: MessageEventWithPayload[] = [];
          const newStream = await TestDuplexStream.make((message) => {
            outputs.push(message as unknown as MessageEventWithPayload);
          });
          // oxlint-disable-next-line no-new -- test setup
          new PlatformServicesClient(
            newStream as unknown as PlatformServicesClientStream,
          );
          // Simulate remoteDeliver request
          await newStream.receiveInput(
            new MessageEvent('message', {
              data: {
                id: 'm1',
                jsonrpc: '2.0',
                method: 'remoteDeliver',
                params: { from: 'peer-999', message: 'test' },
              },
            }),
          );
          await delay(10);
          // Should have sent error response
          const errorResponse = outputs.find(
            (message) =>
              message.payload?.id === 'm1' && 'error' in message.payload,
          );
          expect(errorResponse).toBeDefined();
        });

        it('calls handler and returns response when handler is set', async () => {
          const outputs: MessageEventWithPayload[] = [];
          const testStream = await TestDuplexStream.make((message) => {
            outputs.push(message as unknown as MessageEventWithPayload);
          });
          const testClient = new PlatformServicesClient(
            testStream as unknown as PlatformServicesClientStream,
            clientLogger,
          );
          // Wait for client to be ready
          await delay(10);

          const remoteHandler = vi.fn(async () => 'response-message');
          const initP = testClient.initializeRemoteComms(
            '0xabcd',
            {},
            remoteHandler,
          );
          await testStream.receiveInput(makeNullReply('m1'));
          await initP;

          await testStream.receiveInput(
            new MessageEvent('message', {
              data: {
                id: 'm2',
                jsonrpc: '2.0',
                method: 'remoteDeliver',
                params: {
                  from: 'peer-123',
                  message: 'test-message',
                },
              },
            }),
          );
          await delay(50);

          expect(remoteHandler).toHaveBeenCalledExactlyOnceWith(
            'peer-123',
            'test-message',
          );

          const successResponse = outputs.find(
            (message) =>
              message.payload?.id === 'm2' &&
              'result' in message.payload &&
              message.payload.result === 'response-message',
          );
          expect(successResponse).toBeDefined();
        });
      });

      describe('remoteGiveUp', () => {
        it('calls handler when handler is set', async () => {
          const outputs: MessageEventWithPayload[] = [];
          const testStream = await TestDuplexStream.make((message) => {
            outputs.push(message as unknown as MessageEventWithPayload);
          });
          const testClient = new PlatformServicesClient(
            testStream as unknown as PlatformServicesClientStream,
            clientLogger,
          );
          // Wait for client to be ready
          await delay(10);

          const remoteHandler = vi.fn(async () => 'response');
          const giveUpHandler = vi.fn();
          const initP = testClient.initializeRemoteComms(
            '0xabcd',
            {},
            remoteHandler,
            giveUpHandler,
          );
          await testStream.receiveInput(makeNullReply('m1'));
          await initP;

          await testStream.receiveInput(
            new MessageEvent('message', {
              data: {
                id: 'm2',
                jsonrpc: '2.0',
                method: 'remoteGiveUp',
                params: { peerId: 'peer-456' },
              },
            }),
          );
          await delay(50);

          expect(giveUpHandler).toHaveBeenCalledExactlyOnceWith('peer-456');

          const successResponse = outputs.find(
            (message) =>
              message.payload?.id === 'm2' &&
              'result' in message.payload &&
              message.payload.result === null,
          );
          expect(successResponse).toBeDefined();
        });

        it('does not throw when handler is not set', async () => {
          const outputs: MessageEventWithPayload[] = [];
          const newStream = await TestDuplexStream.make((message) => {
            outputs.push(message as unknown as MessageEventWithPayload);
          });
          // oxlint-disable-next-line no-new -- test setup
          new PlatformServicesClient(
            newStream as unknown as PlatformServicesClientStream,
          );

          await newStream.receiveInput(
            new MessageEvent('message', {
              data: {
                id: 'm1',
                jsonrpc: '2.0',
                method: 'remoteGiveUp',
                params: { peerId: 'peer-789' },
              },
            }),
          );
          await delay(10);

          // Should have sent success response with null result
          const successResponse = outputs.find(
            (message) =>
              message.payload?.id === 'm1' &&
              'result' in message.payload &&
              message.payload.result === null,
          );
          expect(successResponse).toBeDefined();
        });
      });

      describe('remoteIncarnationChange', () => {
        it('forwards args to handler and returns its boolean verdict', async () => {
          const outputs: MessageEventWithPayload[] = [];
          const testStream = await TestDuplexStream.make((message) => {
            outputs.push(message as unknown as MessageEventWithPayload);
          });
          const testClient = new PlatformServicesClient(
            testStream as unknown as PlatformServicesClientStream,
            clientLogger,
          );
          await delay(10);

          const remoteHandler = vi.fn(async () => 'response');
          const giveUpHandler = vi.fn();
          const incarnationHandler = vi.fn(async () => true);
          const initP = testClient.initializeRemoteComms(
            '0xabcd',
            {},
            remoteHandler,
            giveUpHandler,
            'local-incarnation',
            incarnationHandler,
          );
          await testStream.receiveInput(makeNullReply('m1'));
          await initP;

          await testStream.receiveInput(
            new MessageEvent('message', {
              data: {
                id: 'm2',
                jsonrpc: '2.0',
                method: 'remoteIncarnationChange',
                params: {
                  peerId: 'peer-456',
                  observedIncarnation: 'incarnation-X',
                },
              },
            }),
          );
          await delay(50);

          expect(incarnationHandler).toHaveBeenCalledExactlyOnceWith(
            'peer-456',
            'incarnation-X',
          );
          const successResponse = outputs.find(
            (message) =>
              message.payload?.id === 'm2' &&
              'result' in message.payload &&
              message.payload.result === true,
          );
          expect(successResponse).toBeDefined();
        });

        it('returns false when no handler is registered', async () => {
          const outputs: MessageEventWithPayload[] = [];
          const newStream = await TestDuplexStream.make((message) => {
            outputs.push(message as unknown as MessageEventWithPayload);
          });
          // oxlint-disable-next-line no-new -- test setup
          new PlatformServicesClient(
            newStream as unknown as PlatformServicesClientStream,
          );

          await newStream.receiveInput(
            new MessageEvent('message', {
              data: {
                id: 'm1',
                jsonrpc: '2.0',
                method: 'remoteIncarnationChange',
                params: {
                  peerId: 'peer-789',
                  observedIncarnation: 'incarnation-Y',
                },
              },
            }),
          );
          await delay(10);

          const response = outputs.find(
            (message) =>
              message.payload?.id === 'm1' &&
              'result' in message.payload &&
              message.payload.result === false,
          );
          expect(response).toBeDefined();
        });

        it('coerces non-boolean handler return to true (fail closed)', async () => {
          const outputs: MessageEventWithPayload[] = [];
          const testStream = await TestDuplexStream.make((message) => {
            outputs.push(message as unknown as MessageEventWithPayload);
          });
          const testClient = new PlatformServicesClient(
            testStream as unknown as PlatformServicesClientStream,
            clientLogger,
          );
          await delay(10);

          const remoteHandler = vi.fn(async () => 'response');
          // Handler returns a non-boolean truthy value (a buggy caller).
          const incarnationHandler = vi.fn(
            async () => 'oops' as unknown as boolean,
          );
          const initP = testClient.initializeRemoteComms(
            '0xabcd',
            {},
            remoteHandler,
            undefined,
            'local-incarnation',
            incarnationHandler,
          );
          await testStream.receiveInput(makeNullReply('m1'));
          await initP;

          await testStream.receiveInput(
            new MessageEvent('message', {
              data: {
                id: 'm2',
                jsonrpc: '2.0',
                method: 'remoteIncarnationChange',
                params: {
                  peerId: 'peer-789',
                  observedIncarnation: 'incarnation-Z',
                },
              },
            }),
          );
          await delay(50);

          // Fail closed → resolve to true so the transport drops the outbound.
          const response = outputs.find(
            (message) =>
              message.payload?.id === 'm2' &&
              'result' in message.payload &&
              message.payload.result === true,
          );
          expect(response).toBeDefined();
        });

        it('coerces a throwing handler to true (fail closed)', async () => {
          const outputs: MessageEventWithPayload[] = [];
          const testStream = await TestDuplexStream.make((message) => {
            outputs.push(message as unknown as MessageEventWithPayload);
          });
          const testClient = new PlatformServicesClient(
            testStream as unknown as PlatformServicesClientStream,
            clientLogger,
          );
          await delay(10);

          const remoteHandler = vi.fn(async () => 'response');
          const incarnationHandler = vi.fn(async () => {
            throw new Error('handler exploded');
          });
          const initP = testClient.initializeRemoteComms(
            '0xabcd',
            {},
            remoteHandler,
            undefined,
            'local-incarnation',
            incarnationHandler,
          );
          await testStream.receiveInput(makeNullReply('m1'));
          await initP;

          await testStream.receiveInput(
            new MessageEvent('message', {
              data: {
                id: 'm2',
                jsonrpc: '2.0',
                method: 'remoteIncarnationChange',
                params: {
                  peerId: 'peer-789',
                  observedIncarnation: 'incarnation-Z',
                },
              },
            }),
          );
          await delay(50);

          const response = outputs.find(
            (message) =>
              message.payload?.id === 'm2' &&
              'result' in message.payload &&
              message.payload.result === true,
          );
          expect(response).toBeDefined();
        });
      });
    });
  });
});
