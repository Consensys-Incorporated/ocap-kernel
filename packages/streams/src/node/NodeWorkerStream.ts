/**
 * @module Node Worker streams
 */

import { BaseDuplexStream } from '../BaseDuplexStream.ts';
import type { ValidateInput } from '../BaseStream.ts';

export type OnMessage = (message: unknown) => void;

export type NodePort = {
  on: (event: 'message', listener: OnMessage) => void;
  off: (event: 'message', listener: OnMessage) => void;
  postMessage: (message: unknown) => void;
};

/**
 * A duplex stream over a Node worker port, i.e. a `Worker` or a
 * `worker_threads` `MessagePort`.
 */
export class NodeWorkerDuplexStream<
  Read,
  Write = Read,
> extends BaseDuplexStream<Read, Write> {
  /**
   * Constructs a new {@link NodeWorkerDuplexStream}.
   *
   * @param port - The node worker port for bidirectional communication.
   * @param validateInput - A function that validates input from the transport.
   */
  constructor(port: NodePort, validateInput?: ValidateInput<Read>) {
    super({
      name: 'NodeWorkerDuplexStream',
      validateInput,
      listen: (receiveInput) => {
        port.on('message', receiveInput);
        return () => port.off('message', receiveInput);
      },
      onDispatch: (value) => port.postMessage(value),
    });
  }

  /**
   * Creates and synchronizes a new {@link NodeWorkerDuplexStream}.
   *
   * @param port - The node worker port for bidirectional communication.
   * @param validateInput - A function that validates input from the transport.
   * @returns A synchronized duplex stream.
   */
  static async make<Read, Write = Read>(
    port: NodePort,
    validateInput?: ValidateInput<Read>,
  ): Promise<NodeWorkerDuplexStream<Read, Write>> {
    const stream = new NodeWorkerDuplexStream<Read, Write>(port, validateInput);
    await stream.synchronize();
    return stream;
  }
}
harden(NodeWorkerDuplexStream);
