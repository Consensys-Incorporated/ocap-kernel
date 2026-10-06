/**
 * This module provides a duplex stream over the Chrome Extension Runtime messaging API.
 *
 * The stream uses `chrome.runtime.sendMessage` for sending data and
 * `chrome.runtime.onMessage.addListener` for receiving data. This allows for
 * communication between different parts of a Chrome extension (e.g., background scripts,
 * content scripts, and popup pages).
 *
 * Note that unlike e.g. the `MessagePort` API, the Chrome Extension Runtime messaging API
 * doesn't have a built-in way to close the connection. The stream will continue to operate
 * as long as the extension is running, unless manually ended.
 *
 * @module ChromeRuntime streams
 */

import { stringify } from '@metamask/kernel-utils';
import type { Json } from '@metamask/utils';

import type { ChromeRuntime, ChromeMessageSender } from './chrome.d.ts';
import { BaseDuplexStream } from '../BaseDuplexStream.ts';
import type { ValidateInput } from '../BaseStream.ts';

export type ChromeRuntimeTarget = 'background' | 'offscreen' | 'popup';

export type MessageEnvelope<Payload> = {
  target: ChromeRuntimeTarget;
  source: ChromeRuntimeTarget;
  payload: Payload;
};

const isMessageEnvelope = (
  message: unknown,
): message is MessageEnvelope<unknown> =>
  typeof message === 'object' &&
  message !== null &&
  'target' in message &&
  'source' in message &&
  'payload' in message;

/**
 * A duplex stream over the Chrome Extension Runtime messaging API. Reads only
 * enveloped messages from this extension that are addressed from `remoteTarget`
 * to `localTarget`.
 */
export class ChromeRuntimeDuplexStream<
  Read extends Json,
  Write extends Json = Read,
> extends BaseDuplexStream<Read, Write> {
  /**
   * Constructs a new {@link ChromeRuntimeDuplexStream}.
   *
   * @param runtime - The Chrome runtime API object.
   * @param localTarget - The local target context for this stream.
   * @param remoteTarget - The remote target context to communicate with.
   * @param validateInput - A function that validates input from the transport.
   */
  constructor(
    runtime: ChromeRuntime,
    localTarget: ChromeRuntimeTarget,
    remoteTarget: ChromeRuntimeTarget,
    validateInput?: ValidateInput<Read>,
  ) {
    if (localTarget === remoteTarget) {
      throw new Error('localTarget and remoteTarget must be different');
    }

    super({
      name: 'ChromeRuntimeDuplexStream',
      validateInput,
      listen: (receiveInput) => {
        const onMessage = (
          message: unknown,
          sender: ChromeMessageSender,
        ): void => {
          if (sender.id !== runtime.id) {
            return;
          }
          if (
            isMessageEnvelope(message) &&
            message.target === localTarget &&
            message.source === remoteTarget
          ) {
            receiveInput(message.payload);
            return;
          }
          // TODO(#562): Use logger instead.
          // eslint-disable-next-line no-console
          console.debug(
            `ChromeRuntimeDuplexStream received unexpected message: ${stringify(message)}`,
          );
        };
        runtime.onMessage.addListener(onMessage);
        return () => runtime.onMessage.removeListener(onMessage);
      },
      onDispatch: async (payload) => {
        await runtime.sendMessage({
          target: remoteTarget,
          source: localTarget,
          payload,
        });
      },
    });
  }

  /**
   * Creates and synchronizes a new {@link ChromeRuntimeDuplexStream}.
   *
   * @param runtime - The Chrome runtime API object.
   * @param localTarget - The local target context for this stream.
   * @param remoteTarget - The remote target context to communicate with.
   * @param validateInput - A function that validates input from the transport.
   * @returns A synchronized duplex stream.
   */
  static async make<Read extends Json, Write extends Json = Read>(
    runtime: ChromeRuntime,
    localTarget: ChromeRuntimeTarget,
    remoteTarget: ChromeRuntimeTarget,
    validateInput?: ValidateInput<Read>,
  ): Promise<ChromeRuntimeDuplexStream<Read, Write>> {
    const stream = new ChromeRuntimeDuplexStream<Read, Write>(
      runtime,
      localTarget,
      remoteTarget,
      validateInput,
    );
    await stream.synchronize();
    return stream;
  }
}
harden(ChromeRuntimeDuplexStream);
