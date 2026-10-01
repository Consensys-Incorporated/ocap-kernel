/**
 * This module provides a pair of classes for creating readable and writable streams
 * over a [postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage).
 * function.
 *
 * @module PostMessage streams
 */

import { isObject } from '@metamask/utils';

import type { OnMessage, PostMessage } from './utils.ts';
import {
  BaseDuplexStream,
  isDuplexStreamSignal,
  makeDuplexStreamInputValidator,
} from '../BaseDuplexStream.ts';
import type { BaseReaderArgs, BaseWriterArgs } from '../BaseStream.ts';
import { BaseReader, BaseWriter } from '../BaseStream.ts';
import { isSignalLike } from '../utils.ts';
import type { Dispatchable } from '../utils.ts';

export type PostMessageTarget = {
  addEventListener: (type: 'message', listener: OnMessage) => void;
  removeEventListener: (type: 'message', listener: OnMessage) => void;
  postMessage: PostMessage;
};

type PostMessageReaderArgs<Read> = BaseReaderArgs<Read> & {
  messageTarget: PostMessageTarget;
} & (Read extends MessageEvent
    ? {
        messageEventMode: 'event';
      }
    : {
        messageEventMode?: 'data' | undefined;
      });

/**
 * A readable stream over a {@link PostMessage} function.
 *
 * Ignores message events dispatched on its port that contain ports, but otherwise
 * expects {@link Dispatchable} values to be posted to its port.
 *
 * @see {@link PostMessageWriter} for the corresponding writable stream.
 */
export class PostMessageReader<Read> extends BaseReader<Read> {
  /**
   * Constructs a new {@link PostMessageReader}.
   *
   * @param options - Options bag for configuring the reader.
   * @param options.messageTarget - The target to listen for messages on.
   * @param options.validateInput - A function that validates input from the transport.
   * @param options.onEnd - A function that is called when the stream ends.
   * @param options.messageEventMode - Whether to pass the message event or just the data to the stream.
   */
  constructor({
    validateInput,
    onEnd,
    messageTarget,
    messageEventMode = 'data',
  }: PostMessageReaderArgs<Read>) {
    // eslint-disable-next-line prefer-const
    let onMessage: OnMessage;

    super({
      validateInput,
      onEnd: async (error) => {
        messageTarget.removeEventListener('message', onMessage);
        await onEnd?.(error);
      },
    });

    const receiveInput = super.getReceiveInput();
    onMessage = (messageEvent) => {
      const value =
        messageEventMode === 'data' ||
        isSignalLike(messageEvent.data) ||
        isDuplexStreamSignal(messageEvent.data)
          ? messageEvent.data
          : messageEvent;
      receiveInput(value).catch(async (error) => this.throw(error));
    };
    messageTarget.addEventListener('message', onMessage);

    harden(this);
  }
}
harden(PostMessageReader);

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
 * A writable stream over a {@link PostMessage} function.
 *
 * @see {@link PostMessageReader} for the corresponding readable stream.
 */
export class PostMessageWriter<Write> extends BaseWriter<Write> {
  /**
   * Constructs a new {@link PostMessageWriter}.
   *
   * @param messageTarget - The target to post messages to.
   * @param options - Options bag for configuring the writer.
   * @param options.name - The name of the stream, for logging purposes.
   * @param options.onEnd - A function that is called when the stream ends.
   */
  constructor(
    messageTarget: PostMessageTarget,
    { name, onEnd }: Omit<BaseWriterArgs<Write>, 'onDispatch'> = {},
  ) {
    super({
      name,
      onDispatch: (value: Dispatchable<Write>) => {
        return isPostMessageEnvelope(value)
          ? messageTarget.postMessage(value.payload, value.transfer)
          : messageTarget.postMessage(value);
      },
      onEnd: async (error) => {
        await onEnd?.(error);
      },
    });
    harden(this);
  }
}
harden(PostMessageWriter);

type PostMessageDuplexStreamArgs<Read> = PostMessageReaderArgs<Read>;

/**
 * A duplex stream over a {@link PostMessage} function.
 *
 * @see {@link PostMessageReader} for the corresponding readable stream.
 * @see {@link PostMessageWriter} for the corresponding writable stream.
 */
export class PostMessageDuplexStream<
  Read,
  Write = Read,
> extends BaseDuplexStream<
  Read,
  PostMessageReader<Read>,
  Write,
  PostMessageWriter<Write>
> {
  /**
   * Constructs a new {@link PostMessageDuplexStream}.
   *
   * @param options - Options bag for configuring the duplex stream.
   * @param options.messageTarget - The target for sending and receiving messages.
   * @param options.validateInput - A function that validates input from the transport.
   * @param options.onEnd - A function that is called when the stream ends.
   */
  constructor({
    messageTarget,
    validateInput,
    onEnd,
    ...args
  }: PostMessageDuplexStreamArgs<Read>) {
    let didCallOnEnd = false;
    const callOnEndOnce = async (): Promise<void> => {
      if (!didCallOnEnd) {
        didCallOnEnd = true;
        await onEnd?.();
      }
    };

    let writer: PostMessageWriter<Write>; // eslint-disable-line prefer-const
    const reader = new PostMessageReader<Read>({
      ...args,
      messageTarget,
      validateInput: makeDuplexStreamInputValidator(validateInput),
      // End the writer first, since onEnd may close the transport.
      onEnd: async () => {
        await writer.return();
        await callOnEndOnce();
      },
    } as PostMessageReaderArgs<Read>);
    writer = new PostMessageWriter<Write>(messageTarget, {
      name: 'PostMessageDuplexStream',
      onEnd: async () => {
        await reader.return();
        await callOnEndOnce();
      },
    });
    super(reader, writer);
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
