import { delay } from '@metamask/kernel-utils';
import {
  vi,
  describe,
  it,
  beforeEach,
  afterEach,
  beforeAll,
  expect,
} from 'vitest';

import {
  initializeMessageChannel,
  MessageType,
  receiveMessagePort,
} from './message-channel.ts';

/**
 * Construct a mock Window with mock message post and listen capabilities.
 *
 * @returns A mock window which can postMessage and addEventListener.
 */
const createWindow = (): {
  postMessage: typeof Window.prototype.postMessage;
  addEventListener: typeof Window.prototype.addEventListener;
} => ({
  postMessage: vi.fn(),
  addEventListener: vi.fn(),
});

describe('initializeMessageChannel', () => {
  it('calls postMessage parameter', async () => {
    const targetWindow = createWindow();
    const postMessageSpy = vi.spyOn(targetWindow, 'postMessage');

    // We intentionally let this one go. It will never settle.
    // oxlint-disable-next-line typescript/no-floating-promises
    initializeMessageChannel((message, transfer) =>
      targetWindow.postMessage(message, '*', transfer),
    );

    expect(postMessageSpy).toHaveBeenCalledExactlyOnceWith(
      {
        type: MessageType.Initialize,
      },
      '*',
      [expect.any(MessagePort)],
    );
  });

  it('resolves a port and removes event listeneronce sent acknowledgment via message channel', async () => {
    const { port1, port2 } = new MessageChannel();
    const removeEventListenerSpy = vi.spyOn(port1, 'removeEventListener');

    vi.spyOn(globalThis, 'MessageChannel').mockImplementationOnce(function () {
      return { port1, port2 };
    });
    const messageChannelP = initializeMessageChannel(vi.fn());

    port2.postMessage({ type: MessageType.Acknowledge });

    const resolvedValue = await messageChannelP;
    expect(resolvedValue).toBeInstanceOf(MessagePort);
    expect(removeEventListenerSpy).toHaveBeenCalledOnce();
  });

  it('has called portHandler with the local port by the time the promise resolves', async () => {
    const targetWindow = createWindow();
    const portHandler = vi.fn();
    const postMessageSpy = vi.spyOn(targetWindow, 'postMessage');
    const messageChannelP = initializeMessageChannel(
      (message, transfer) => targetWindow.postMessage(message, '*', transfer),
      portHandler,
    );

    // @ts-expect-error Wrong types for window.postMessage()
    const remotePort: MessagePort = postMessageSpy.mock.lastCall[2][0];
    remotePort.postMessage({ type: MessageType.Acknowledge });

    await messageChannelP;

    expect(portHandler).toHaveBeenCalledExactlyOnceWith(
      expect.any(MessagePort),
    );
    expect(portHandler.mock.lastCall?.[0] === remotePort).toBe(false);
  });

  it('resolves with the value returned by portHandler', async () => {
    const targetWindow = createWindow();
    const portHandler = vi.fn(() => 'foo');
    const postMessageSpy = vi.spyOn(targetWindow, 'postMessage');
    const messageChannelP = initializeMessageChannel(
      (message, transfer) => targetWindow.postMessage(message, '*', transfer),
      portHandler,
    );

    // @ts-expect-error Wrong types for window.postMessage()
    const remotePort: MessagePort = postMessageSpy.mock.lastCall[2][0];
    remotePort.postMessage({ type: MessageType.Acknowledge });

    expect(await messageChannelP).toBe('foo');
  });

  it.each([
    { type: MessageType.Initialize },
    { type: 'foo' },
    { foo: 'bar' },
    {},
    [],
    'foo',
    400,
    null,
    undefined,
  ])(
    'rejects if sent unexpected message via message channel: %j',
    async (unexpectedMessage) => {
      const targetWindow = createWindow();
      const postMessageSpy = vi.spyOn(targetWindow, 'postMessage');
      const messageChannelP = initializeMessageChannel((message, transfer) =>
        targetWindow.postMessage(message, '*', transfer),
      );

      // @ts-expect-error Wrong types for window.postMessage()
      const remotePort: MessagePort = postMessageSpy.mock.lastCall[2][0];
      remotePort.postMessage(unexpectedMessage);

      await expect(messageChannelP).rejects.toThrowError(
        /^Received unexpected message via message port/u,
      );
    },
  );
});
describe('receiveMessagePort', () => {
  let messageEventListeners: [string, EventListenerOrEventListenerObject][] =
    [];
  let originalAddEventListener: typeof window.addEventListener;

  beforeAll(() => {
    originalAddEventListener = window.addEventListener;
  });

  beforeEach(() => {
    // JSDOM apparently affords no way to clear all event listeners between test runs,
    // so we have to do it manually.
    window.addEventListener = (
      ...args: Parameters<typeof window.addEventListener>
    ): void => {
      messageEventListeners.push([args[0], args[1]]);
      originalAddEventListener.call(window, ...args);
    };
  });

  afterEach(() => {
    messageEventListeners.forEach(([messageType, listener]) => {
      window.removeEventListener(messageType, listener);
    });
    messageEventListeners = [];
    window.addEventListener = originalAddEventListener;
  });

  it('receives and acknowledges a message port', async () => {
    const messagePortP = receiveMessagePort(
      (listener) => addEventListener('message', listener),
      (listener) => removeEventListener('message', listener),
    );

    const { port2 } = new MessageChannel();
    const portPostMessageSpy = vi.spyOn(port2, 'postMessage');

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: MessageType.Initialize },
        ports: [port2],
      }),
    );

    expect(await messagePortP).toBe(port2);
    expect(portPostMessageSpy).toHaveBeenCalledExactlyOnceWith({
      type: MessageType.Acknowledge,
    });
  });

  it('calls portHandler with the received port', async () => {
    const portHandler = vi.fn();
    const messagePortP = receiveMessagePort(
      (listener) => addEventListener('message', listener),
      (listener) => removeEventListener('message', listener),
      portHandler,
    );

    const { port2 } = new MessageChannel();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: MessageType.Initialize },
        ports: [port2],
      }),
    );

    await messagePortP;

    expect(portHandler).toHaveBeenCalledExactlyOnceWith(port2);
  });

  it('resolves with the value returned by portHandler', async () => {
    const portHandler = vi.fn(() => 'foo');
    const messagePortP = receiveMessagePort(
      (listener) => addEventListener('message', listener),
      (listener) => removeEventListener('message', listener),
      portHandler,
    );

    const { port2 } = new MessageChannel();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: MessageType.Initialize },
        ports: [port2],
      }),
    );
    expect(await messagePortP).toBe('foo');
  });

  it('cleans up event listeners', async () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

    const messagePortP = receiveMessagePort(
      (listener) => addEventListener('message', listener),
      (listener) => removeEventListener('message', listener),
    );

    const { port2 } = new MessageChannel();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: MessageType.Initialize },
        ports: [port2],
      }),
    );

    await messagePortP;

    expect(addEventListenerSpy).toHaveBeenCalledExactlyOnceWith(
      'message',
      expect.any(Function),
    );
    expect(removeEventListenerSpy).toHaveBeenCalledExactlyOnceWith(
      'message',
      expect.any(Function),
    );
  });

  it.each([
    { type: MessageType.Acknowledge },
    { type: 'foo' },
    { foo: 'bar' },
    {},
    [],
    'foo',
    400,
    null,
    undefined,
  ])(
    'ignores message events with unexpected data: %j',
    async (unexpectedMessage) => {
      const messagePortP = receiveMessagePort(
        (listener) => addEventListener('message', listener),
        (listener) => removeEventListener('message', listener),
      );

      const { port2 } = new MessageChannel();
      const portPostMessageSpy = vi.spyOn(port2, 'postMessage');

      const fulfillmentDetector = vi.fn();
      messagePortP.then(fulfillmentDetector).catch(fulfillmentDetector);

      window.dispatchEvent(
        new MessageEvent('message', {
          data: unexpectedMessage,
        }),
      );

      await delay();

      expect(fulfillmentDetector).not.toHaveBeenCalled();
      expect(portPostMessageSpy).not.toHaveBeenCalled();
    },
  );

  const mockMessageChannel = new MessageChannel();
  const mockPorts = [mockMessageChannel.port1, mockMessageChannel.port2];

  it.each([{}, { ports: [] }, { ports: mockPorts }])(
    'ignores message events with unexpected ports: %#',
    async (unexpectedPorts) => {
      const messagePortP = receiveMessagePort(
        (listener) => addEventListener('message', listener),
        (listener) => removeEventListener('message', listener),
      );

      const { port2 } = new MessageChannel();
      const portPostMessageSpy = vi.spyOn(port2, 'postMessage');

      const fulfillmentDetector = vi.fn();
      messagePortP.then(fulfillmentDetector).catch(fulfillmentDetector);

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: MessageType.Initialize },
          ...unexpectedPorts,
        }),
      );

      await delay();

      expect(fulfillmentDetector).not.toHaveBeenCalled();
      expect(portPostMessageSpy).not.toHaveBeenCalled();
    },
  );
});
