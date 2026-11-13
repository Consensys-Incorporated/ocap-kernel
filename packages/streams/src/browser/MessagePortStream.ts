/**
 * This module provides a duplex stream over a
 * [MessagePort](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort).
 * The stream is a naive passthrough mechanism for data that assumes exclusive access
 * to its port. The lifetime of the underlying message port is expected to be
 * coextensive with "the other side".
 *
 * At the time of writing, there is no ergonomic way to detect the closure of a port. For
 * this reason, streams have to be ended manually via `.return()` or `.throw()`. Ending a
 * stream ends the stream on the remote port and closes the entangled ports.
 *
 * Regarding limitations around detecting `MessagePort` closure, see:
 * - https://github.com/fergald/explainer-messageport-close
 * - https://github.com/whatwg/html/issues/10201
 *
 * @module MessagePort streams
 */

import type { OnMessage } from './utils.ts';
import { BaseDuplexStream } from '../BaseDuplexStream.ts';
import type { ValidateInput } from '../BaseStream.ts';

/**
 * A duplex stream over a {@link MessagePort}. Ignores message events that
 * transfer ports.
 */
export class MessagePortDuplexStream<
  Read,
  Write = Read,
> extends BaseDuplexStream<Read, Write> {
  /**
   * Constructs a new {@link MessagePortDuplexStream}.
   *
   * @param port - The message port to use for bidirectional communication.
   * @param validateInput - A function that validates input from the transport.
   */
  constructor(port: MessagePort, validateInput?: ValidateInput<Read>) {
    super({
      name: 'MessagePortDuplexStream',
      validateInput,
      listen: (receiveInput) => {
        const onMessage: OnMessage = (messageEvent) => {
          if (messageEvent.ports.length === 0) {
            receiveInput(messageEvent.data);
          }
        };
        port.addEventListener('message', onMessage);
        port.start();
        return () => port.removeEventListener('message', onMessage);
      },
      onDispatch: (value) => port.postMessage(value),
      onEnd: () => port.close(),
    });
  }

  /**
   * Creates and synchronizes a new {@link MessagePortDuplexStream}.
   *
   * @param port - The message port to use for bidirectional communication.
   * @param validateInput - A function that validates input from the transport.
   * @returns A synchronized duplex stream.
   */
  static async make<Read, Write = Read>(
    port: MessagePort,
    validateInput?: ValidateInput<Read>,
  ): Promise<MessagePortDuplexStream<Read, Write>> {
    const stream = new MessagePortDuplexStream<Read, Write>(
      port,
      validateInput,
    );
    await stream.synchronize();
    return stream;
  }
}
harden(MessagePortDuplexStream);
