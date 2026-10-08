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
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
      // Without a listener, a worker's uncaught exception is rethrown in the
      // kernel's own thread. Its `exit` follows.
      worker.on('error', (error) => {
        this.#logger.error(`Worker ${vatId} errored:`, error);
      });

      const stream = new NodeWorkerDuplexStream<JsonRpcMessage, JsonRpcMessage>(
        worker,
        isJsonRpcMessage,
      );
      let phase: 'handshake' | 'registered' | 'exited' = 'handshake';
      worker.once('exit', (code) => {
        if (phase === 'handshake') {
          phase = 'exited';
          const error = new Error(
            `Worker ${vatId} exited during startup with code ${code}`,
          );
          // Failed, so the handshake does not wait forever on a worker that is
          // gone.
          stream.throw(error).catch(() => undefined);
          reject(error);
          return;
        }
        const entry = this.workers.get(vatId);
        // Forgotten by a `terminate` under way; the slot may hold the vat's
        // next worker.
        if (entry?.worker !== worker) {
          return;
        }
        this.workers.delete(vatId);
        const error = new Error(`Worker ${vatId} exited with code ${code}`);
        this.#logger.error(error.message);
        // A worker thread that dies emits no port event, so failing the
        // channel is the only way the kernel hears of it.
        entry.stream.throw(error).catch((closeError: unknown) => {
          this.#logger.error(
            `Failed to end the channel of exited worker ${vatId}:`,
            closeError,
          );
        });
      });

      stream
        .synchronize()
        .then(() => {
          if (phase === 'exited') {
            return undefined;
          }
          phase = 'registered';
          // Only add worker to map after successful synchronization
          this.workers.set(vatId, { worker, stream });
          resolve(stream);
          this.#logger.debug('connected to kernel');
          return undefined;
        })
        .catch(async (error) => {
          // Clean up worker if synchronization fails
          try {
            await this.#killWorker(vatId, worker);
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
   * @returns A promise that resolves when the worker has terminated, or at
   * once if there is no worker or another call is stopping it, and rejects if
   * the channel or the worker would not stop.
   */
  async terminate(vatId: VatId): Promise<undefined> {
    const workerEntry = this.workers.get(vatId);
    if (!workerEntry) {
      // Exited on its own, never launched, still shaking hands, or stopped by
      // another call.
      this.#logger.debug(`No worker to terminate for vat ${vatId}`);
      return undefined;
    }
    // Forgotten first. An entry left behind refuses the vat's next worker as a
    // duplicate, and a second call would strip the listener this call's
    // `worker.terminate()` settles on, leaving it pending forever.
    this.workers.delete(vatId);
    const { worker, stream } = workerEntry;
    try {
      await stream.return();
    } finally {
      await this.#killWorker(vatId, worker);
    }
    return undefined;
  }

  /**
   * Kill a worker. An `error` listener stays on: Node emits an exception the
   * worker threw before it stopped as it exits, and rethrows one nothing
   * listens for in the kernel's thread.
   *
   * @param vatId - The vat whose worker it is.
   * @param worker - The worker.
   */
  async #killWorker(vatId: VatId, worker: NodeWorker): Promise<void> {
    worker.removeAllListeners();
    worker.on('error', (error) => {
      this.#logger.error(`Worker ${vatId} errored as it stopped:`, error);
    });
    await worker.terminate();
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
