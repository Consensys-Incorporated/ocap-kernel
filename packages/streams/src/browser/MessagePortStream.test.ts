import { delay } from '@metamask/kernel-utils';
import { describe, expect, it, vi } from 'vitest';

import { MessagePortDuplexStream } from './MessagePortStream.ts';
import { makeAck } from '../BaseDuplexStream.ts';
import type { ValidateInput } from '../BaseStream.ts';
import {
  makeDoneResult,
  makePendingResult,
  makeStreamDoneSignal,
} from '../utils.ts';

describe('MessagePortDuplexStream', () => {
  const makeDuplexStream = async (
    channel: MessageChannel = new MessageChannel(),
    validateInput?: ValidateInput<number>,
  ): Promise<MessagePortDuplexStream<number>> => {
    const duplexStreamP = MessagePortDuplexStream.make<number>(
      channel.port1,
      validateInput,
    );
    channel.port2.postMessage(makeAck());
    await delay(10);

    return await duplexStreamP;
  };

  it('constructs a MessagePortDuplexStream', async () => {
    const duplexStream = await makeDuplexStream();

    expect(duplexStream).toBeInstanceOf(MessagePortDuplexStream);
    expect(duplexStream[Symbol.asyncIterator]()).toBe(duplexStream);
  });

  it('reads messages from and writes messages to the port', async () => {
    const channel = new MessageChannel();
    const duplexStream = await makeDuplexStream(channel);

    const messageP = new Promise((resolve) => {
      // The port's queue also holds the SYN sent during synchronization.
      channel.port2.onmessage = ({ data }): void =>
        data === 43 ? resolve(data) : undefined;
    });
    channel.port2.postMessage(42);

    expect(await duplexStream.next()).toStrictEqual(makePendingResult(42));
    expect(await duplexStream.write(43)).toStrictEqual(
      makePendingResult(undefined),
    );
    expect(await messageP).toBe(43);
  });

  it('calls validateInput with received input if specified', async () => {
    const validateInput = vi
      .fn()
      .mockReturnValue(true) as unknown as ValidateInput<number>;
    const channel = new MessageChannel();
    const duplexStream = await makeDuplexStream(channel, validateInput);

    channel.port2.postMessage(42);

    expect(await duplexStream.next()).toStrictEqual(makePendingResult(42));
    expect(validateInput).toHaveBeenCalledWith(42);
  });

  it('ignores messages with ports', async () => {
    const channel = new MessageChannel();
    const duplexStream = await makeDuplexStream(channel);
    const { port1: otherPort } = new MessageChannel();

    channel.port2.postMessage(1, [otherPort]);
    channel.port2.postMessage(2);

    expect(await duplexStream.next()).toStrictEqual(makePendingResult(2));
  });

  it('ends the reader when the writer ends', async () => {
    const { port1, port2 } = new MessageChannel();
    vi.spyOn(port1, 'postMessage')
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('foo');
      });
    const duplexStream = await makeDuplexStream({ port1, port2 });

    await expect(duplexStream.write(42)).rejects.toThrow(
      'MessagePortDuplexStream experienced a dispatch failure',
    );
    expect(await duplexStream.next()).toStrictEqual(makeDoneResult());
  });

  it('ends the writer and closes the port when the reader ends', async () => {
    const { port1, port2 } = new MessageChannel();
    const closeSpy = vi.spyOn(port1, 'close');
    const removeListenerSpy = vi.spyOn(port1, 'removeEventListener');
    const duplexStream = await makeDuplexStream({ port1, port2 });

    const readP = duplexStream.next();
    port2.postMessage(makeStreamDoneSignal());
    await delay(10);
    expect(await duplexStream.write(42)).toStrictEqual(makeDoneResult());
    expect(await readP).toStrictEqual(makeDoneResult());
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(removeListenerSpy).toHaveBeenCalledOnce();
  });
});
