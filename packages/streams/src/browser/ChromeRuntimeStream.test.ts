import { delay, stringify } from '@metamask/kernel-utils';
import { describe, expect, it, vi } from 'vitest';

import type { ChromeRuntime } from './chrome.d.ts';
import type {
  MessageEnvelope,
  ChromeRuntimeTarget,
} from './ChromeRuntimeStream.ts';
import { ChromeRuntimeDuplexStream } from './ChromeRuntimeStream.ts';
import { makeAck } from '../BaseDuplexStream.ts';
import type { ValidateInput } from '../BaseStream.ts';
import {
  makeDoneResult,
  makePendingResult,
  makeStreamDoneSignal,
} from '../utils.ts';

const makeEnvelope = (
  value: unknown,
  target: ChromeRuntimeTarget,
  source: ChromeRuntimeTarget,
): MessageEnvelope<unknown> => ({
  target,
  source,
  payload: value,
});

const EXTENSION_ID = 'test-extension-id';

const makeRuntime = (extensionId: string = EXTENSION_ID) => {
  const listeners: ((...args: unknown[]) => void)[] = [];
  const dispatchRuntimeMessage = (
    message: unknown,
    target: ChromeRuntimeTarget = 'background',
    source: ChromeRuntimeTarget = 'offscreen',
    senderId: string = extensionId,
  ): void => {
    listeners.forEach((listener) =>
      listener(makeEnvelope(message, target, source), { id: senderId }),
    );
  };

  const runtime = {
    id: extensionId,
    onMessage: {
      addListener: vi.fn((listener) => {
        listeners.push(listener);
      }),
      removeListener: vi.fn((listener) => {
        listeners.splice(listeners.indexOf(listener), 1);
      }),
    },
    sendMessage: vi.fn(),
  };

  return { runtime, listeners, dispatchRuntimeMessage };
};

const asChromeRuntime = (
  runtime: ReturnType<typeof makeRuntime>['runtime'],
): ChromeRuntime => runtime as unknown as ChromeRuntime;

describe.concurrent('ChromeRuntimeDuplexStream', () => {
  const makeDuplexStream = async (validateInput?: ValidateInput<number>) => {
    const { runtime, dispatchRuntimeMessage, listeners } = makeRuntime();
    const duplexStreamP = ChromeRuntimeDuplexStream.make(
      asChromeRuntime(runtime),
      'background',
      'offscreen',
      validateInput,
    );
    dispatchRuntimeMessage(makeAck());

    return [
      await duplexStreamP,
      { runtime, dispatchRuntimeMessage, listeners },
    ] as const;
  };

  it('throws an error when localTarget and remoteTarget are the same', async () => {
    const { runtime } = makeRuntime();

    await expect(
      ChromeRuntimeDuplexStream.make(
        asChromeRuntime(runtime),
        'background',
        'background',
      ),
    ).rejects.toThrow('localTarget and remoteTarget must be different');
  });

  it('constructs a ChromeRuntimeDuplexStream', async () => {
    const [duplexStream] = await makeDuplexStream();

    expect(duplexStream).toBeInstanceOf(ChromeRuntimeDuplexStream);
    expect(duplexStream[Symbol.asyncIterator]()).toBe(duplexStream);
  });

  it('calls validateInput with received input if specified', async () => {
    const validateInput = vi
      .fn()
      .mockReturnValue(true) as unknown as ValidateInput<number>;
    const [duplexStream, { dispatchRuntimeMessage }] =
      await makeDuplexStream(validateInput);

    const message = { foo: 'bar' };
    dispatchRuntimeMessage(message);

    expect(await duplexStream.next()).toStrictEqual(makePendingResult(message));
    expect(validateInput).toHaveBeenCalledWith(message);
  });

  it('writes enveloped messages to runtime.sendMessage', async () => {
    const [duplexStream, { runtime }] = await makeDuplexStream();

    expect(await duplexStream.write(42)).toStrictEqual(
      makePendingResult(undefined),
    );
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      makeEnvelope(42, 'offscreen', 'background'),
    );
  });

  it('ignores messages from other extensions and for other targets', async () => {
    const [duplexStream, { dispatchRuntimeMessage }] = await makeDuplexStream();

    const nextP = duplexStream.next();
    dispatchRuntimeMessage(1, 'background', 'offscreen', 'other-extension-id');
    // @ts-expect-error Intentional destructive testing
    dispatchRuntimeMessage(2, 'foo', 'offscreen');
    dispatchRuntimeMessage(3);

    expect(await nextP).toStrictEqual(makePendingResult(3));
  });

  it('ignores messages that are not valid envelopes', async () => {
    const [duplexStream, { dispatchRuntimeMessage, listeners }] =
      await makeDuplexStream();
    const nextP = duplexStream.next();

    vi.spyOn(console, 'debug');
    listeners[0]?.({ not: 'an envelope' }, { id: EXTENSION_ID });

    expect(console.debug).toHaveBeenCalledWith(
      `ChromeRuntimeDuplexStream received unexpected message: ${stringify({
        not: 'an envelope',
      })}`,
    );

    dispatchRuntimeMessage(42);
    expect(await nextP).toStrictEqual(makePendingResult(42));
  });

  it('removes its runtime.onMessage listener when it ends', async () => {
    const [duplexStream, { listeners }] = await makeDuplexStream();
    expect(listeners).toHaveLength(1);

    await duplexStream.return();
    expect(listeners).toHaveLength(0);
  });

  it('ends the reader when the writer ends', async () => {
    const [duplexStream, { runtime }] = await makeDuplexStream();
    runtime.sendMessage.mockImplementationOnce(() => {
      throw new Error('foo');
    });

    await expect(duplexStream.write(42)).rejects.toThrow(
      'ChromeRuntimeDuplexStream experienced a dispatch failure',
    );
    expect(await duplexStream.next()).toStrictEqual(makeDoneResult());
  });

  it('ends the writer when the reader ends', async () => {
    const [duplexStream, { dispatchRuntimeMessage }] = await makeDuplexStream();

    const readP = duplexStream.next();
    dispatchRuntimeMessage(makeStreamDoneSignal());
    await delay(10);
    expect(await duplexStream.write(42)).toStrictEqual(makeDoneResult());
    expect(await readP).toStrictEqual(makeDoneResult());
  });
});
