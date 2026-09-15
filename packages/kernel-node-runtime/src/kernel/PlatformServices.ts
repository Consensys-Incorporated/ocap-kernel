import { quic } from '@chainsafe/libp2p-quic';
import { makePromiseKit } from '@endo/promise-kit';
import { tcp } from '@libp2p/tcp';
import { isJsonRpcMessage } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type {
  DirectTransport,
  PlatformServices,
  VatId,
  RemoteMessageHandler,
  SendRemoteMessage,
  StopRemoteComms,
  RemoteCommsOptions,
  OnIncarnationChange,
} from '@metamask/ocap-kernel';
import { initTransport } from '@metamask/ocap-kernel';
import { NodeWorkerDuplexStream } from '@metamask/streams';
import type { DuplexStream } from '@metamask/streams';
import { Worker as NodeWorker } from 'node:worker_threads';

// Worker file loads from the built dist directory, requires rebuild after change
// Note: Worker runs in same process and may be subject to spectre-style attacks
const DEFAULT_WORKER_FILE = new URL(
  '../../dist/vat/vat-worker.mjs',
  import.meta.url,
).pathname;

/**
 * Node.js implementation of platform services for launching, managing, and
 * terminating vat workers, as well as handling network communications.
 */
export class NodejsPlatformServices implements PlatformServices {
  readonly #logger: Logger;

  #sendRemoteMessageFunc: SendRemoteMessage | null = null;

  #stopRemoteCommsFunc: StopRemoteComms | null = null;

  #closeConnectionFunc: ((peerId: string) => Promise<void>) | null = null;

  #registerLocationHintsFunc:
    | ((peerId: string, hints: string[]) => void)
    | null = null;

  #reconnectPeerFunc:
    | ((peerId: string, hints?: string[]) => Promise<void>)
    | null = null;

  #resetAllBackoffsFunc: (() => void) | null = null;

  #getListenAddressesFunc: (() => string[]) | null = null;

  #remoteMessageHandler: RemoteMessageHandler | undefined = undefined;

  readonly #workerFilePath: string;

  workers = new Map<
    VatId,
    { worker: NodeWorker; stream: DuplexStream<JsonRpcMessage, JsonRpcMessage> }
  >();

  /**
   * The vat worker service, intended to be constructed in
   * the kernel worker.
   *
   * @param args - A bag of optional arguments.
   * @param args.workerFilePath - An optional path to a file defining the worker's routine. Defaults to 'vat-worker.mjs'.
   * @param args.logger - An optional {@link Logger}. Defaults to a new logger labeled '[vat worker client]'.
   */
  constructor(args: {
    workerFilePath?: string | undefined;
    logger?: Logger | undefined;
  }) {
    this.#workerFilePath = args.workerFilePath ?? DEFAULT_WORKER_FILE;
    this.#logger = args.logger ?? new Logger('vat-worker-service');
  }

  /**
   * Launch a new worker with a specific vat id.
   *
   * @param vatId - The vat id of the worker to launch.
   * @returns A promise for a duplex stream connected to the worker
   * which rejects if a worker with the given vat id already exists.
   */
  async launch(
    vatId: VatId,
  ): Promise<DuplexStream<JsonRpcMessage, JsonRpcMessage>> {
    // Check if worker already exists
    if (this.workers.has(vatId)) {
      throw new Error(
        `Worker ${vatId} already exists! Cannot launch duplicate.`,
      );
    }

    this.#logger.debug('launching vat', vatId);
    const { promise, resolve, reject } =
      makePromiseKit<DuplexStream<JsonRpcMessage, JsonRpcMessage>>();

    const worker = new NodeWorker(this.#workerFilePath, {
      env: {
        NODE_VAT_ID: vatId,
      },
    });

    // Handle worker errors before 'online' event
    worker.once('error', (error) => {
      worker.removeAllListeners();
      // eslint-disable-next-line promise/no-promise-in-callback
      worker.terminate().catch(() => {
        // Ignore termination errors
      });
      reject(
        new Error(`Worker ${vatId} errored during startup: ${error.message}`),
      );
    });

    // Handle worker exit before 'online' event
    worker.once('exit', (code) => {
      worker.removeAllListeners();
      reject(
        new Error(`Worker ${vatId} exited during startup with code ${code}`),
      );
    });

    worker.once('online', () => {
      // The startup listeners reject the launch, which is no longer what an
      // error or exit means; they are replaced rather than simply dropped,
      // because a worker that dies later is otherwise noticed only through the
      // stream, and the exit code is the only place the reason appears.
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
      worker.once('exit', (code) => {
        // An orderly `terminate` removes this listener before killing the
        // worker, so reaching it here means the worker went away on its own.
        // The identity check is belt and braces: it would matter if a
        // replacement were ever registered without the old one's listeners
        // being removed.
        const entry = this.workers.get(vatId);
        if (entry?.worker === worker) {
          this.workers.delete(vatId);
          this.#logger.error(`Worker ${vatId} exited with code ${code}`);
          // A worker thread that dies emits no port event, so this is the only
          // thing that tells the kernel. Without it the stream stays open, the
          // vat keeps its handle, and the next delivery to it never returns.
          entry.stream.return().catch((error: unknown) => {
            this.#logger.error(
              `Failed to close the channel of exited worker ${vatId}:`,
              error,
            );
          });
        }
      });

      const stream = new NodeWorkerDuplexStream<JsonRpcMessage, JsonRpcMessage>(
        worker,
        isJsonRpcMessage,
      );
      stream
        .synchronize()
        .then(() => {
          // Only add worker to map after successful synchronization
          this.workers.set(vatId, { worker, stream });
          resolve(stream);
          this.#logger.debug('connected to kernel');
          return undefined;
        })
        .catch(async (error) => {
          // Clean up worker if synchronization fails
          worker.removeAllListeners();
          try {
            await worker.terminate();
          } catch (terminateError) {
            this.#logger.error(
              `Error terminating worker ${vatId} after sync failure`,
              terminateError,
            );
          }
          reject(error);
        });
    });
    return promise;
  }

  /**
   * Terminate a worker identified by its vat id.
   *
   * @param vatId - The vat id of the worker to terminate.
   * @returns A promise that resolves when the worker has terminated
   * or rejects if that worker does not exist.
   */
  async terminate(vatId: VatId): Promise<undefined> {
    const workerEntry = this.workers.get(vatId);
    if (!workerEntry) {
      // A worker that exited on its own took its own entry, and its vat is
      // being torn down on the strength of that: there is nothing left to stop
      // and saying so would report every crash as a failure to clean up.
      this.#logger.debug(`No worker to terminate for vat ${vatId}`);
      return undefined;
    }
    const { worker, stream } = workerEntry;
    await stream.return();
    worker.removeAllListeners();
    await worker.terminate();
    this.workers.delete(vatId);
    return undefined;
  }

  /**
   * Terminate all workers managed by the service.
   *
   * @returns A promise that resolves after all workers have terminated
   * or rejects if there was an error during termination.
   */
  async terminateAll(): Promise<void> {
    const vatIds = Array.from(this.workers.keys());
    for (const vatId of vatIds) {
      try {
        await this.terminate(vatId);
      } catch (error) {
        this.#logger.error('Error terminating worker', vatId, error);
      }
    }
  }

  /**
   * Send a remote message to a peer.
   *
   * @param to - The peer ID to send the message to.
   * @param message - The serialized message string to send.
   * @returns A promise that resolves when the message has been sent.
   */
  async sendRemoteMessage(to: string, message: string): Promise<void> {
    if (!this.#sendRemoteMessageFunc) {
      throw Error('remote comms not initialized');
    }
    await this.#sendRemoteMessageFunc(to, message);
  }

  /**
   * Handle a remote message from a peer.
   *
   * @param from - The peer ID that sent the message.
   * @param message - The message received.
   * @returns A promise that resolves with the reply message, or null if no reply is needed.
   */
  async #handleRemoteMessage(
    from: string,
    message: string,
  ): Promise<string | null> {
    if (!this.#remoteMessageHandler) {
      // This can't actually happen, but TypeScript can't infer it
      throw Error('remote comms not initialized');
    }
    // Return the reply - network layer handles sending it with proper seq/ack
    return this.#remoteMessageHandler(from, message);
  }

  /**
   * Initialize network communications.
   *
   * @param keySeed - The seed for generating this kernel's secret key.
   * @param options - Options for remote communications initialization.
   * @param options.relays - Array of the peerIDs of relay nodes that can be used to listen for incoming
   *   connections from other kernels.
   * @param options.maxRetryAttempts - Maximum number of reconnection attempts. 0 = infinite (default).
   * @param options.maxQueue - Maximum number of messages to queue per peer while reconnecting (default: 200).
   * @param remoteMessageHandler - A handler function to receive remote messages.
   * @param onRemoteGiveUp - Optional callback to be called when we give up on a remote.
   * @param incarnationId - This kernel's incarnation ID for handshake protocol.
   * @param onIncarnationChange - Optional callback when a remote peer's incarnation changes.
   * @returns A promise that resolves once network access has been established
   *   or rejects if there is some problem doing so.
   */
  async initializeRemoteComms(
    keySeed: string,
    options: RemoteCommsOptions,
    remoteMessageHandler: (
      from: string,
      message: string,
    ) => Promise<string | null>,
    onRemoteGiveUp?: (peerId: string) => void,
    incarnationId?: string,
    onIncarnationChange?: OnIncarnationChange,
  ): Promise<void> {
    if (this.#sendRemoteMessageFunc) {
      throw Error('remote comms already initialized');
    }
    this.#remoteMessageHandler = remoteMessageHandler;

    const { directListenAddresses, ...restOptions } = options;

    const directTransports: DirectTransport[] = [];

    if (directListenAddresses && directListenAddresses.length > 0) {
      const quicAddresses: string[] = [];
      const tcpAddresses: string[] = [];

      for (const addr of directListenAddresses) {
        const isQuic = addr.includes('/quic-v1');
        const isTcp = addr.includes('/tcp/');

        if (isQuic) {
          quicAddresses.push(addr);
        } else if (isTcp) {
          tcpAddresses.push(addr);
        } else {
          throw new Error(
            `Unsupported direct listen address: ${addr}. ` +
              `Only QUIC (/quic-v1) and TCP (/tcp/) addresses are supported.`,
          );
        }
      }

      if (quicAddresses.length > 0) {
        directTransports.push({
          transport: quic(),
          listenAddresses: quicAddresses,
        });
      }

      if (tcpAddresses.length > 0) {
        directTransports.push({
          transport: tcp(),
          listenAddresses: tcpAddresses,
        });
      }
    }

    const enhancedOptions: RemoteCommsOptions = {
      ...restOptions,
      ...(directTransports.length > 0 ? { directTransports } : {}),
    };

    const {
      sendRemoteMessage,
      stop,
      closeConnection,
      registerLocationHints,
      reconnectPeer,
      resetAllBackoffs,
      getListenAddresses,
    } = await initTransport(
      keySeed,
      enhancedOptions,
      this.#handleRemoteMessage.bind(this),
      onRemoteGiveUp,
      incarnationId,
      onIncarnationChange,
    );
    this.#sendRemoteMessageFunc = sendRemoteMessage;
    this.#stopRemoteCommsFunc = stop;
    this.#closeConnectionFunc = closeConnection;
    this.#registerLocationHintsFunc = registerLocationHints;
    this.#reconnectPeerFunc = reconnectPeer;
    this.#resetAllBackoffsFunc = resetAllBackoffs;
    this.#getListenAddressesFunc = getListenAddresses;
  }

  /**
   * Stop network communications.
   *
   * @returns A promise that resolves when network access has been stopped
   *   or rejects if there is some problem doing so.
   */
  async stopRemoteComms(): Promise<void> {
    if (!this.#stopRemoteCommsFunc) {
      return;
    }
    await this.#stopRemoteCommsFunc();
    this.#sendRemoteMessageFunc = null;
    this.#stopRemoteCommsFunc = null;
    this.#closeConnectionFunc = null;
    this.#registerLocationHintsFunc = null;
    this.#reconnectPeerFunc = null;
    this.#resetAllBackoffsFunc = null;
    this.#getListenAddressesFunc = null;
  }

  /**
   * Explicitly close a connection to a peer.
   * Marks the peer as intentionally closed to prevent automatic reconnection.
   *
   * @param peerId - The peer ID to close the connection for.
   * @returns A promise that resolves when the connection is closed.
   */
  async closeConnection(peerId: string): Promise<void> {
    if (!this.#closeConnectionFunc) {
      throw Error('remote comms not initialized');
    }
    await this.#closeConnectionFunc(peerId);
  }

  /**
   * Take note of where a peer might be.
   *
   * @param peerId - The peer ID to which this information applies.
   * @param hints - Location hints for the peer.
   */
  async registerLocationHints(peerId: string, hints: string[]): Promise<void> {
    if (!this.#registerLocationHintsFunc) {
      throw Error('remote comms not initialized');
    }
    this.#registerLocationHintsFunc(peerId, hints);
  }

  /**
   * Manually reconnect to a peer after intentional close.
   * Clears the intentional close flag and initiates reconnection.
   *
   * @param peerId - The peer ID to reconnect to.
   * @param hints - Optional hints for reconnection.
   * @returns A promise that resolves when reconnection is initiated.
   */
  async reconnectPeer(peerId: string, hints: string[] = []): Promise<void> {
    if (!this.#reconnectPeerFunc) {
      throw Error('remote comms not initialized');
    }
    await this.#reconnectPeerFunc(peerId, hints);
  }

  /**
   * Reset all reconnection backoffs.
   * Called after detecting a cross-incarnation wake to avoid unnecessary delays.
   */
  async resetAllBackoffs(): Promise<void> {
    if (!this.#resetAllBackoffsFunc) {
      return;
    }
    this.#resetAllBackoffsFunc();
  }

  /**
   * Get the listen addresses of the libp2p node.
   * Returns multiaddr strings that other peers can use to dial this node directly.
   *
   * @returns The listen address strings, or empty array if remote comms not initialized.
   */
  getListenAddresses(): string[] {
    if (!this.#getListenAddressesFunc) {
      return [];
    }
    return this.#getListenAddressesFunc();
  }
}
harden(NodejsPlatformServices);
