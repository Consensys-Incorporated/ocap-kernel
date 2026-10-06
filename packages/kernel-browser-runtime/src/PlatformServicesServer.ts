import {
  VatAlreadyExistsError,
  VatNotFoundError,
} from '@metamask/kernel-errors';
import { RpcClient, RpcService } from '@metamask/kernel-rpc-methods';
import { isJsonRpcMessage } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type {
  VatId,
  VatConfig,
  SendRemoteMessage,
  StopRemoteComms,
  RemoteCommsOptions,
} from '@metamask/ocap-kernel';
import { initTransport } from '@metamask/ocap-kernel';
import {
  kernelRemoteMethodSpecs,
  platformServicesHandlers,
} from '@metamask/ocap-kernel/rpc';
import { serializeError } from '@metamask/rpc-errors';
import { PostMessageDuplexStream } from '@metamask/streams/browser';
import type {
  PostMessageEnvelope,
  PostMessageTarget,
} from '@metamask/streams/browser';
import { isJsonRpcRequest, isJsonRpcResponse } from '@metamask/utils';
import type { JsonRpcRequest } from '@metamask/utils';

// Appears in the docs.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { PlatformServicesClient } from './PlatformServicesClient.ts';

export type VatWorker = {
  launch: (vatConfig: VatConfig) => Promise<[MessagePort, unknown]>;
  terminate: () => Promise<null>;
};

export type PlatformServicesStream = PostMessageDuplexStream<
  MessageEvent<JsonRpcMessage>, // was JsonRpcRequest
  PostMessageEnvelope<JsonRpcMessage> // was JsonRpcResponse
>;

/**
 * The server end of the platform services, intended to be constructed in
 * the offscreen document. Listens for launch and terminate worker requests
 * from the client and uses the {@link VatWorker} methods to effect those
 * requests, and provides network connectivity.
 *
 * Note that {@link PlatformServicesServer.start} must be called to start
 * the server.
 *
 * @see {@link PlatformServicesClient} for the other end of the service.
 *
 * @param stream - The stream to use for communication with the client.
 * @param makeWorker - A method for making a {@link VatWorker}.
 * @param logger - An optional {@link Logger}. Defaults to a new logger labeled '[platform services server]'.
 * @returns A new {@link PlatformServicesServer}.
 */
export class PlatformServicesServer {
  readonly #logger;

  readonly #stream: PlatformServicesStream;

  /** RPC client for delivering remote message events to the kernel */
  readonly #rpcClient: RpcClient<typeof kernelRemoteMethodSpecs>;

  /** RPC service for handling platform services requests */
  readonly #rpcServer: RpcService<typeof platformServicesHandlers>;

  readonly #vatWorkers: Map<VatId, VatWorker> = new Map();

  readonly #makeWorker: (vatId: VatId) => VatWorker;

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

  /**
   * **ATTN:** Prefer {@link PlatformServicesServer.make} over constructing
   * this class directly.
   *
   * The server end of the platform services, intended to be constructed in
   * the offscreen document. Listens for launch and terminate worker requests
   * from the client and uses the {@link VatWorker} methods to effect those
   * requests, and provides network connectivity.
   *
   * Note that {@link PlatformServicesServer.start} must be called to start
   * the server.
   *
   * @see {@link PlatformServicesClient} for the other end of the service.
   *
   * @param stream - The stream to use for communication with the client.
   * @param makeWorker - A method for making a {@link VatWorker}.
   * @param logger - An optional {@link Logger}. Defaults to a new logger labeled '[platform services server]'.
   */
  constructor(
    stream: PlatformServicesStream,
    makeWorker: (vatId: VatId) => VatWorker,
    logger?: Logger,
  ) {
    this.#stream = stream;
    this.#makeWorker = makeWorker;
    this.#logger = logger ?? new Logger('platform-services-server');

    this.#rpcClient = new RpcClient(
      kernelRemoteMethodSpecs,
      async (request) => {
        await this.#sendMessage(request);
      },
      `vws:`,
      this.#logger.subLogger({ tags: ['rpc-client'] }),
    );

    this.#rpcServer = new RpcService(platformServicesHandlers, {
      launch: this.#launch.bind(this),
      terminate: this.#terminate.bind(this),
      terminateAll: this.#terminateAll.bind(this),
      sendRemoteMessage: this.#sendRemoteMessage.bind(this),
      initializeRemoteComms: this.#initializeRemoteComms.bind(this),
      stopRemoteComms: this.#stopRemoteComms.bind(this),
      closeConnection: this.#closeConnection.bind(this),
      registerLocationHints: this.#registerLocationHints.bind(this),
      reconnectPeer: this.#reconnectPeer.bind(this),
      resetAllBackoffs: this.#resetAllBackoffs.bind(this),
    });

    // Start draining messages immediately after construction
    this.#stream
      .drain(this.#handleMessage.bind(this))
      .catch((error: unknown) => {
        this.#logger.error('Error draining stream:', error);
      });
  }

  /**
   * Create a new {@link PlatformServicesServer}. Does not start the server.
   *
   * @param messageTarget - The target to use for posting and receiving messages.
   * @param makeWorker - A method for making a {@link VatWorker}.
   * @param logger - An optional {@link Logger}.
   * @returns A new {@link PlatformServicesServer}.
   */
  static async make(
    messageTarget: PostMessageTarget,
    makeWorker: (vatId: VatId) => VatWorker,
    logger?: Logger,
  ): Promise<PlatformServicesServer> {
    const stream: PlatformServicesStream = new PostMessageDuplexStream({
      messageTarget,
      messageEventMode: 'event',
      validateInput: (
        message: unknown,
      ): message is MessageEvent<JsonRpcMessage> =>
        message instanceof MessageEvent && isJsonRpcMessage(message.data),
    });
    await stream.synchronize();
    return new PlatformServicesServer(stream, makeWorker, logger);
  }

  /**
   * Handles incoming JSON-RPC messages from the shared worker.
   *
   * @param event - The message event containing the JSON-RPC message data.
   */
  async #handleMessage(event: MessageEvent<JsonRpcMessage>): Promise<void> {
    if (isJsonRpcResponse(event.data)) {
      const message = event.data;
      this.#rpcClient.handleResponse(message.id as string, message);
    } else if (isJsonRpcRequest(event.data)) {
      // Run the request handler in the background instead of awaiting it
      // inside the drain. The drain processes responses too, and a request
      // handler that fires an outbound RPC back to the other side (e.g.
      // transport.sendRemoteMessage's handshake calling onIncarnationChange)
      // would deadlock waiting for its response — the drain can't get to
      // that response until the request handler returns.
      this.#executeRequest(event.data).catch(() => undefined);
    }
  }

  /**
   * Execute a JSON-RPC request and write the response back. Errors during
   * execution are serialized into a JSON-RPC error response; errors during
   * response delivery are logged and swallowed (the caller has nowhere to
   * surface them).
   *
   * @param request - The JSON-RPC request to execute.
   */
  async #executeRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;
    try {
      this.#rpcServer.assertHasMethod(method);
      // Ridiculous cast to bypass TypeScript vs. JsonRpc tug-o-war
      const port: MessagePort | undefined = (await this.#rpcServer.execute(
        method,
        params,
      )) as unknown as MessagePort | undefined;
      await this.#sendMessage({ id, result: null, jsonrpc: '2.0' }, port);
    } catch (error) {
      this.#logger.error(`Error handling "${method}" request:`, error);
      this.#sendMessage({
        id,
        error: serializeError(error),
        jsonrpc: '2.0',
      }).catch(() => undefined);
    }
  }

  /**
   * Send a message to the client.
   *
   * @param message - The message to send.
   * @param port - An optional port to transfer.
   * @returns A promise that resolves when the message has been sent.
   */
  async #sendMessage(
    message: JsonRpcMessage,
    port?: MessagePort,
  ): Promise<void> {
    await this.#stream.write({
      payload: message,
      transfer: port ? [port] : [],
    });
  }

  /**
   * Launch a new worker with a specific vat id.
   *
   * @param vatId - The vat id of the worker to launch.
   * @param vatConfig - The configuration for the worker.
   * @returns A promise that resolves when the worker has been launched.
   */
  async #launch(vatId: VatId, vatConfig: VatConfig): Promise<null> {
    if (this.#vatWorkers.has(vatId)) {
      throw new VatAlreadyExistsError(vatId);
    }
    const vatWorker = this.#makeWorker(vatId);
    const [port] = await vatWorker.launch(vatConfig);
    this.#vatWorkers.set(vatId, vatWorker);
    // This cast is a deliberate lie, to bypass TypeScript vs. JsonRpc tug-o-war
    return port as unknown as null;
  }

  /**
   * Terminate a worker identified by its vat id.
   *
   * @param vatId - The vat id of the worker to terminate.
   * @returns A promise that resolves when the worker has been terminated.
   */
  async #terminate(vatId: VatId): Promise<null> {
    const vatWorker = this.#vatWorkers.get(vatId);
    if (!vatWorker) {
      throw new VatNotFoundError(vatId);
    }
    try {
      await vatWorker.terminate();
    } finally {
      this.#vatWorkers.delete(vatId);
    }
    return null;
  }

  /**
   * Terminate all workers managed by the service.
   *
   * @returns A promise that resolves when all workers have been terminated.
   */
  async #terminateAll(): Promise<null> {
    await Promise.all(
      Array.from(this.#vatWorkers.keys()).map(async (vatId) =>
        this.#terminate(vatId),
      ),
    );
    return null;
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
   * @param incarnationId - This kernel's incarnation ID for handshake protocol.
   * @returns A promise that resolves when network access has been initialized.
   */
  async #initializeRemoteComms(
    keySeed: string,
    options: RemoteCommsOptions,
    incarnationId?: string,
  ): Promise<null> {
    if (this.#sendRemoteMessageFunc) {
      throw Error('remote comms already initialized');
    }
    const {
      sendRemoteMessage,
      stop,
      closeConnection,
      registerLocationHints,
      reconnectPeer,
      resetAllBackoffs,
    } = await initTransport(
      keySeed,
      options,
      this.#handleRemoteMessage.bind(this),
      this.#handleRemoteGiveUp.bind(this),
      incarnationId,
      this.#handleRemoteIncarnationChange.bind(this),
    );
    this.#sendRemoteMessageFunc = sendRemoteMessage;
    this.#stopRemoteCommsFunc = stop;
    this.#closeConnectionFunc = closeConnection;
    this.#registerLocationHintsFunc = registerLocationHints;
    this.#reconnectPeerFunc = reconnectPeer;
    this.#resetAllBackoffsFunc = resetAllBackoffs;
    return null;
  }

  /**
   * Stop network communications.
   *
   * @returns A promise that resolves when network access has been stopped.
   */
  async #stopRemoteComms(): Promise<null> {
    if (!this.#stopRemoteCommsFunc) {
      return null;
    }
    await this.#stopRemoteCommsFunc();
    this.#sendRemoteMessageFunc = null;
    this.#stopRemoteCommsFunc = null;
    this.#closeConnectionFunc = null;
    this.#registerLocationHintsFunc = null;
    this.#reconnectPeerFunc = null;
    this.#resetAllBackoffsFunc = null;
    return null;
  }

  /**
   * Explicitly close a connection to a peer.
   *
   * @param peerId - The peer ID to close the connection for.
   * @returns A promise that resolves when the connection has been closed.
   */
  async #closeConnection(peerId: string): Promise<null> {
    if (!this.#closeConnectionFunc) {
      throw Error('remote comms not initialized');
    }
    await this.#closeConnectionFunc(peerId);
    return null;
  }

  /**
   * Take note of where a peer might be.
   *
   * @param peerId - The peer ID to whom this information applies.
   * @param hints - An array of location hints
   * @returns A promise that resolves when the connection has been closed.
   */
  async #registerLocationHints(peerId: string, hints: string[]): Promise<null> {
    if (!this.#registerLocationHintsFunc) {
      throw Error('remote comms not initialized');
    }
    this.#registerLocationHintsFunc(peerId, hints);
    return null;
  }

  /**
   * Manually reconnect to a peer after intentional close.
   *
   * @param peerId - The peer ID to reconnect to.
   * @param hints - Optional hints for reconnection.
   * @returns A promise that resolves when reconnection has been initiated.
   */
  async #reconnectPeer(peerId: string, hints: string[] = []): Promise<null> {
    if (!this.#reconnectPeerFunc) {
      throw Error('remote comms not initialized');
    }
    await this.#reconnectPeerFunc(peerId, hints);
    return null;
  }

  /**
   * Reset all reconnection backoffs.
   *
   * @returns A promise that resolves when backoffs have been reset.
   */
  async #resetAllBackoffs(): Promise<null> {
    if (!this.#resetAllBackoffsFunc) {
      return null;
    }
    this.#resetAllBackoffsFunc();
    return null;
  }

  /**
   * Send a remote message to a peer.
   *
   * @param to - The peer ID to send the message to.
   * @param message - The serialized message string to send.
   * @returns A promise that resolves when the message has been sent.
   */
  async #sendRemoteMessage(to: string, message: string): Promise<null> {
    if (!this.#sendRemoteMessageFunc) {
      throw Error('remote comms not initialized');
    }
    await this.#sendRemoteMessageFunc(to, message);
    return null;
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
    return this.#rpcClient.call('remoteDeliver', {
      from,
      message,
    });
  }

  /**
   * Handle when we give up on a remote connection.
   * Notifies the kernel worker via RPC.
   *
   * @param peerId - The peer ID of the remote we're giving up on.
   */
  #handleRemoteGiveUp(peerId: string): void {
    this.#rpcClient.call('remoteGiveUp', { peerId }).catch((error) => {
      this.#logger.error('Error notifying kernel of remote give up:', error);
    });
  }

  /**
   * Forward the incarnationId observed during a peer handshake to the kernel
   * worker, and return its determination of whether the peer truly restarted.
   * The transport awaits this so it can suppress stale outbound messages on
   * the same connection.
   *
   * On RPC failure (kernel worker unreachable, channel torn down, validation
   * error) we fail *closed* — return `true` to make the transport drop the
   * outbound and re-dial. The opposite default (`false` = "no restart") would
   * silently let stale writes through exactly when the RPC is most likely to
   * fail (kernel-side restart), which is the bug class this whole change is
   * defending against.
   *
   * @param peerId - The peer that completed the handshake.
   * @param observedIncarnation - The incarnationId reported by the peer.
   * @returns Whether the kernel detected a peer restart, or `true` when the
   *   kernel-side check could not be performed.
   */
  async #handleRemoteIncarnationChange(
    peerId: string,
    observedIncarnation: string,
  ): Promise<boolean> {
    try {
      return await this.#rpcClient.call('remoteIncarnationChange', {
        peerId,
        observedIncarnation,
      });
    } catch (error) {
      this.#logger.error(
        `Cannot reach kernel for incarnation handshake with ${peerId.slice(0, 8)}; ` +
          'treating as restart to avoid stale delivery:',
        error,
      );
      return true;
    }
  }
}
harden(PlatformServicesServer);
