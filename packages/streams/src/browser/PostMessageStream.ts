/**
 * This module provides a duplex stream over a
 * [postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
 * function.
 *
 * @module PostMessage streams
 */

import { isObject } from '@metamask/utils';

import type { OnMessage, PostMessage } from './utils.ts';
import { BaseDuplexStream, isDuplexStreamSignal } from '../BaseDuplexStream.ts';
import type { OnEnd, ValidateInput } from '../BaseStream.ts';
import { isSignalLike } from '../utils.ts';

export type PostMessageTarget = {
  addEventListener: (type: 'message', listener: OnMessage) => void;
  removeEventListener: (type: 'message', listener: OnMessage) => void;
  postMessage: PostMessage;
};

type PostMessageDuplexStreamArgs<Read> = {
  messageTarget: PostMessageTarget;
  validateInput?: ValidateInput<Read> | undefined;
  onEnd?: OnEnd | undefined;
} & (Read extends MessageEvent
  ? {
      messageEventMode: 'event';
    }
  : {
      messageEventMode?: 'data' | undefined;
    });

export type PostMessageEnvelope<Write> = {
  payload: Write;
  transfer: Transferable[];
};

/**
 * Checks if the value is a post message envelope with a payload and transfer array.
 *
 * @param value - The value to check.
 * @returns True if the value is a post message envelope.
 */
const isPostMessageEnvelope = <Write>(
  value: unknown,
): value is PostMessageEnvelope<Write> =>
  isObject(value) &&
  typeof value.payload !== 'undefined' &&
  Array.isArray(value.transfer);

/**
 * A duplex stream over a {@link PostMessage} function. Writes of a
 * {@link PostMessageEnvelope} post its payload with its transfer list.
 */
export class PostMessageDuplexStream<
  Read,
  Write = Read,
> extends BaseDuplexStream<Read, Write> {
  /**
   * Constructs a new {@link PostMessageDuplexStream}.
   *
   * @param options - Options bag for configuring the duplex stream.
   * @param options.messageTarget - The target for sending and receiving messages.
   * @param options.validateInput - A function that validates input from the transport.
   * @param options.onEnd - A function that is called once when the stream ends.
   * @param options.messageEventMode - Whether to read whole message events or just their data.
   */
  constructor({
    messageTarget,
    validateInput,
    onEnd,
    messageEventMode = 'data',
  }: PostMessageDuplexStreamArgs<Read>) {
    super({
      name: 'PostMessageDuplexStream',
      validateInput,
      onEnd,
      listen: (receiveInput) => {
        const onMessage: OnMessage = (messageEvent) =>
          receiveInput(
            messageEventMode === 'data' ||
              isSignalLike(messageEvent.data) ||
              isDuplexStreamSignal(messageEvent.data)
              ? messageEvent.data
              : messageEvent,
          );
        messageTarget.addEventListener('message', onMessage);
        return () => messageTarget.removeEventListener('message', onMessage);
      },
      onDispatch: (value) =>
        isPostMessageEnvelope(value)
          ? messageTarget.postMessage(value.payload, value.transfer)
          : messageTarget.postMessage(value),
    });
  }

  /**
   * Creates and synchronizes a new {@link PostMessageDuplexStream}.
   *
   * @param args - The options for configuring the duplex stream.
   * @returns A synchronized duplex stream.
   */
  static async make<Read, Write = Read>(
    args: PostMessageDuplexStreamArgs<Read>,
  ): Promise<PostMessageDuplexStream<Read, Write>> {
    const stream = new PostMessageDuplexStream<Read, Write>(args);
    await stream.synchronize();
    return stream;
  }
}
harden(PostMessageDuplexStream);
