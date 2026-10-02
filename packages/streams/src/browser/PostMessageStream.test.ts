import { delay } from '@metamask/kernel-utils';
import { makeMockMessageTarget } from '@ocap/repo-tools/test-utils';
import { describe, it, expect, vi } from 'vitest';

import {
  PostMessageDuplexStream,
  PostMessageReader,
  PostMessageWriter,
} from './PostMessageStream.ts';
import type { PostMessageTarget } from './PostMessageStream.ts';
import type { PostMessage } from './utils.ts';
import { makeAck } from '../BaseDuplexStream.ts';
import type { ValidateInput } from '../BaseStream.ts';
import {
  makeDoneResult,
  makePendingResult,
  makeStreamDoneSignal,
  makeStreamErrorSignal,
} from '../utils.ts';

describe('PostMessageReader', () => {
  it('constructs a PostMessageReader', () => {
    const reader = new PostMessageReader({
      messageTarget: makeMockMessageTarget(),
    });
    expect(reader).toBeInstanceOf(PostMessageReader);
  });

  it('emits messages received from postMessage', async () => {
    const messageTarget = makeMockMessageTarget();
    const reader = new PostMessageReader({
      messageTarget,
    });

    const message = { foo: 'bar' };

    messageTarget.postMessage(message);
    expect(await reader.next()).toStrictEqual(makePendingResult(message));
  });

  it('can yield MessageEvents directly', async () => {
    const messageTarget = makeMockMessageTarget();
    const reader = new PostMessageReader<MessageEvent>({
      messageTarget,
      messageEventMode: 'event',
    });

    const message = new MessageEvent('message', { data: 'bar' });

    messageTarget.postMessage(message);
    expect(await reader.next()).toStrictEqual(makePendingResult(message));
  });

  it('handles stream done signals normally when yielding MessageEvents', async () => {
    const messageTarget = makeMockMessageTarget();
    const reader = new PostMessageReader<MessageEvent>({
      messageTarget,
      messageEventMode: 'event',
    });

    messageTarget.postMessage(
      new MessageEvent('message', { data: makeStreamDoneSignal() }),
    );
    expect(await reader.next()).toStrictEqual(makeDoneResult());
  });

  it('handles stream error signals normally when yielding MessageEvents', async () => {
    const messageTarget = makeMockMessageTarget();
    const reader = new PostMessageReader<MessageEvent>({
      messageTarget,
      messageEventMode: 'event',
    });

    const nextP = reader.next();

    messageTarget.postMessage(
      new MessageEvent('message', {
        data: makeStreamErrorSignal(new Error('foo')),
      }),
    );
    await expect(nextP).rejects.toThrow('foo');
  });

  it('calls validateInput with received input if specified', async () => {
    const validateInput = vi
      .fn()
      .mockReturnValue(true) as unknown as ValidateInput<number>;
    const messageTarget = makeMockMessageTarget();
    const reader = new PostMessageReader({
      messageTarget,
      validateInput,
    });

    const message = { foo: 'bar' };
    messageTarget.postMessage(message);
    expect(await reader.next()).toStrictEqual(makePendingResult(message));
    expect(validateInput).toHaveBeenCalledWith(message);
  });

  it('throws if validateInput throws', async () => {
    const messageTarget = makeMockMessageTarget();
    const validateInput = (() => {
      throw new Error('foo');
    }) as unknown as ValidateInput<number>;
    const reader = new PostMessageReader({
      messageTarget,
      validateInput,
    });

    messageTarget.postMessage(42);
    await expect(reader.next()).rejects.toThrow('foo');
    expect(await reader.next()).toStrictEqual(makeDoneResult());
  });

  it('removes its listener when it ends', async () => {
    const messageTarget = makeMockMessageTarget();
    const reader = new PostMessageReader({
      messageTarget,
    });
    expect(messageTarget.listeners).toHaveLength(1);

    const message = makeStreamDoneSignal();
    messageTarget.postMessage(message);

    expect(await reader.next()).toStrictEqual(makeDoneResult());
    expect(messageTarget.removeEventListener).toHaveBeenCalled();
    expect(messageTarget.listeners).toHaveLength(0);
  });

  it('calls onEnd once when ending', async () => {
    const messageTarget = makeMockMessageTarget();
    const onEnd = vi.fn();
    const reader = new PostMessageReader({
      messageTarget,
      onEnd,
    });

    messageTarget.postMessage(makeStreamDoneSignal());

    expect(await reader.next()).toStrictEqual(makeDoneResult());
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(await reader.next()).toStrictEqual(makeDoneResult());
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('PostMessageWriter', () => {
  it('constructs a PostMessageWriter', () => {
    const writer = new PostMessageWriter(makeMockMessageTarget());
    expect(writer).toBeInstanceOf(PostMessageWriter);
  });

  it('writes messages to postMessage', async () => {
    const messageTarget = makeMockMessageTarget();
    const writer = new PostMessageWriter(messageTarget);
    const message = { foo: 'bar' };
    await writer.next({ payload: message, transfer: [] });
    expect(messageTarget.postMessage).toHaveBeenCalledWith(message, []);
  });

  it('calls onEnd once when ending', async () => {
    const messageTarget = makeMockMessageTarget();
    const onEnd = vi.fn();
    const writer = new PostMessageWriter(messageTarget, { onEnd });

    expect(await writer.return()).toStrictEqual(makeDoneResult());
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(await writer.return()).toStrictEqual(makeDoneResult());
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('PostMessageDuplexStream', () => {
  const makeDuplexStream = async <Read, Write>({
    messageTarget = makeMockMessageTarget(),
    postRemoteMessage = vi.fn(),
    validateInput,
    onEnd,
  }: {
    messageTarget?: PostMessageTarget;
    postRemoteMessage?: PostMessage;
    validateInput?: ValidateInput<Read>;
    onEnd?: () => Promise<void>;
  } = {}) => {
    const postLocalMessage = messageTarget.postMessage;
    // @ts-expect-error In reality you have to be explicit about `messageEventMode`
    const duplexStreamP = PostMessageDuplexStream.make<Read, Write>({
      messageTarget: { ...messageTarget, postMessage: postRemoteMessage },
      validateInput,
      onEnd,
    });
    postLocalMessage(makeAck());
    await delay(10);

    return {
      duplexStream: await duplexStreamP,
      messageTarget,
      postLocalMessage,
    };
  };

  it('constructs a PostMessageDuplexStream', async () => {
    const { duplexStream } = await makeDuplexStream();

    expect(duplexStream).toBeInstanceOf(PostMessageDuplexStream);
    expect(duplexStream[Symbol.asyncIterator]()).toBe(duplexStream);
  });

  it('calls validateInput with received input if specified', async () => {
    const validateInput = vi
      .fn()
      .mockReturnValue(true) as unknown as ValidateInput<number>;
    const mockMessageTarget = makeMockMessageTarget();
    const { duplexStream } = await makeDuplexStream({
      messageTarget: mockMessageTarget,
      postRemoteMessage: vi.fn(),
      validateInput,
    });

    mockMessageTarget.postMessage(42);
    expect(await duplexStream.next()).toStrictEqual(makePendingResult(42));
    expect(validateInput).toHaveBeenCalledWith(42);
  });

  it('calls onEnd when ending if specified', async () => {
    const onEnd = vi.fn();
    const { duplexStream } = await makeDuplexStream({
      messageTarget: makeMockMessageTarget(),
      postRemoteMessage: vi.fn(),
      onEnd,
    });

    await duplexStream.return();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('calls onEnd once when the remote ends', async () => {
    const onEnd = vi.fn();
    const { duplexStream, postLocalMessage } = await makeDuplexStream({
      onEnd,
    });

    postLocalMessage(makeStreamDoneSignal());
    await delay(10);
    expect(await duplexStream.next()).toStrictEqual(makeDoneResult());
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('ends both sides when onEnd closes a BroadcastChannel', async () => {
    const name = `test-channel-${Math.random()}`;
    const channelA = new BroadcastChannel(name);
    const channelB = new BroadcastChannel(name);
    const makeTarget = (channel: BroadcastChannel): PostMessageTarget => ({
      addEventListener: (_type, listener) =>
        channel.addEventListener('message', listener),
      removeEventListener: (_type, listener) =>
        channel.removeEventListener('message', listener),
      postMessage: (message) => channel.postMessage(message),
    });
    const onEndA = vi.fn(() => channelA.close());
    const onEndB = vi.fn(() => channelB.close());

    const [streamA, streamB] = await Promise.all([
      PostMessageDuplexStream.make({
        messageTarget: makeTarget(channelA),
        onEnd: onEndA,
      }),
      PostMessageDuplexStream.make({
        messageTarget: makeTarget(channelB),
        onEnd: onEndB,
      }),
    ]);

    await streamA.return();
    await delay(50);

    expect(onEndA).toHaveBeenCalledOnce();
    expect(onEndB).toHaveBeenCalledOnce();
    expect(await streamB.write({ x: 1 })).toStrictEqual(makeDoneResult());
    expect(await streamB.next()).toStrictEqual(makeDoneResult());
  });

  it('ends the reader when the writer ends', async () => {
    const postRemoteMessage = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('foo');
      });
    const { duplexStream } = await makeDuplexStream({
      postRemoteMessage,
    });

    await expect(
      duplexStream.write({ payload: 42, transfer: [] }),
    ).rejects.toThrow('PostMessageDuplexStream experienced a dispatch failure');
    expect(await duplexStream.next()).toStrictEqual(makeDoneResult());
  });

  it('ends the writer when the reader ends', async () => {
    const { duplexStream, postLocalMessage } = await makeDuplexStream();

    const readP = duplexStream.next();
    postLocalMessage(makeStreamDoneSignal());
    await delay(10);
    expect(
      await duplexStream.write({ payload: 42, transfer: [] }),
    ).toStrictEqual(makeDoneResult());
    expect(await readP).toStrictEqual(makeDoneResult());
  });
});
