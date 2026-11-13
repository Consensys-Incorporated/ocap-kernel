import { delay } from '@metamask/kernel-utils';
import { makeMockMessageTarget } from '@ocap/repo-tools/test-utils';
import { describe, it, expect, vi } from 'vitest';

import { PostMessageDuplexStream } from './PostMessageStream.ts';
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

describe('PostMessageDuplexStream', () => {
  const makeDuplexStream = async <Read, Write>({
    messageTarget = makeMockMessageTarget(),
    postRemoteMessage = vi.fn(),
    validateInput,
    onEnd,
    messageEventMode,
  }: {
    messageTarget?: ReturnType<typeof makeMockMessageTarget>;
    postRemoteMessage?: PostMessage;
    validateInput?: ValidateInput<Read>;
    onEnd?: () => Promise<void>;
    messageEventMode?: 'data' | 'event';
  } = {}) => {
    const postLocalMessage = messageTarget.postMessage;
    // @ts-expect-error In reality you have to be explicit about `messageEventMode`
    const duplexStreamP = PostMessageDuplexStream.make<Read, Write>({
      messageTarget: { ...messageTarget, postMessage: postRemoteMessage },
      validateInput,
      onEnd,
      messageEventMode,
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

  it('can yield MessageEvents directly', async () => {
    const { duplexStream, postLocalMessage } = await makeDuplexStream<
      MessageEvent,
      unknown
    >({ messageEventMode: 'event' });

    const message = new MessageEvent('message', { data: 'bar' });
    postLocalMessage(message);
    expect(await duplexStream.next()).toStrictEqual(makePendingResult(message));
  });

  it('reads done signals as data when yielding MessageEvents', async () => {
    const { duplexStream, postLocalMessage } = await makeDuplexStream<
      MessageEvent,
      unknown
    >({ messageEventMode: 'event' });

    postLocalMessage(makeStreamDoneSignal());
    expect(await duplexStream.next()).toStrictEqual(makeDoneResult());
  });

  it('reads error signals as data when yielding MessageEvents', async () => {
    const { duplexStream, postLocalMessage } = await makeDuplexStream<
      MessageEvent,
      unknown
    >({ messageEventMode: 'event' });

    const nextP = duplexStream.next();
    postLocalMessage(makeStreamErrorSignal(new Error('foo')));
    await expect(nextP).rejects.toThrow('foo');
  });

  it('removes its listener when it ends', async () => {
    const { duplexStream, messageTarget } = await makeDuplexStream();
    expect(messageTarget.listeners).toHaveLength(1);

    await duplexStream.return();
    expect(messageTarget.listeners).toHaveLength(0);
  });

  it('ends with an error if validateInput throws', async () => {
    const validateInput = (() => {
      throw new Error('foo');
    }) as unknown as ValidateInput<number>;
    const { duplexStream, postLocalMessage } = await makeDuplexStream({
      validateInput,
    });

    postLocalMessage(42);
    await expect(duplexStream.next()).rejects.toThrow('foo');
    expect(await duplexStream.next()).toStrictEqual(makeDoneResult());
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
