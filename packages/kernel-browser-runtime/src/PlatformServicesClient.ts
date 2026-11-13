import { RpcClient, RpcService } from '@metamask/kernel-rpc-methods';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { isJsonRpcMessage, stringify } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type {
  PlatformServices,
  RemoteMessageHandler,
  VatId,
  VatConfig,
  RemoteCommsOptions,
  OnIncarnationChange,
} from '@metamask/ocap-kernel';
import {
  platformServicesMethodSpecs,
  kernelRemoteHandlers,
} from '@metamask/ocap-kernel/rpc';
import { serializeError } from '@metamask/rpc-errors';
import type { DuplexStream } from '@metamask/streams';
import {
  MessagePortDuplexStream,
  PostMessageDuplexStream,
} from '@metamask/streams/browser';
import type {
  PostMessageEnvelope,
  PostMessageTarget,
} from '@metamask/streams/browser';
import { isJsonRpcResponse, isJsonRpcRequest } from '@metamask/utils';
import type { JsonRpcRequest } from '@metamask/utils';
import type { JsonRpcId } from '@metamask/utils';

// Appears in the docs.
// oxlint-disable-next-line typescript/no-unused-vars
import type { PlatformServicesServer } from './PlatformServicesServer.ts';

export type PlatformServicesClientStream = PostMessageDuplexStream<
  MessageEvent<JsonRpcMessage>,
  PostMessageEnvelope<JsonRpcMessage>
>;

/**
 * The client end of the platform services, intended to be constructed in
 * the kernel worker. Sends launch and terminate worker requests to the
 * server and wraps the launch response in a DuplexStream for consumption
 * by the kernel, and provides network connectivity.
 *
 * @see {@link PlatformServicesServer} for the other end of the service.
 *
 * @param stream - The stream to use for communication with the server.
 * @param logger - An optional {@link Logger}. Defaults to a new logger labeled '[platform services client]'.
 * @returns A new {@link PlatformServicesClient}.
 */
export class PlatformServicesClient implements PlatformServices {
  readonly #logger: Logger;

  readonly #stream: PlatformServicesClientStream;

  readonly #rpcClient: RpcClient<typeof platformServicesMethodSpecs>;

  readonly #rpcServer: RpcService<typeof kernelRemoteHandlers>;

  readonly #portMap: Map<JsonRpcId, MessagePort | undefined>;

  #remoteMessageHandler: RemoteMessageHandler | undefined = undefined;

  #remoteGiveUpHandler: ((peerId: string) => void) | undefined = undefined;

  #remoteIncarnationChangeHandler: OnIncarnationChange | undefined = undefined;

  /**
   * **ATTN:** Prefer {@link PlatformServicesClient.make} over constructing
   * this class directly.
   *
   * The client end of the platform services, intended to be constructed in
   * the kernel worker. Sends launch and terminate worker requests to the
   * server and wraps the launch response in a DuplexStream for consumption
   * by the kernel, and provides network connectivity.
   *
   * @see {@link PlatformServicesServer} for the other end of the service.
   *
   * @param stream - The stream to use for communication with the server.
   * @param logger - An optional {@link Logger}. Defaults to a new logger labeled '[platform services client]'.
   */
  constructor(stream: PlatformServicesClientStream, logger?: Logger) {
    this.#stream = stream;
    this.#portMap = new Map();
    this.#logger = logger ?? new Logger('platform-services-client');
    this.#rpcClient = new RpcClient(
      platformServicesMethodSpecs,
      async (request) => {
        if ('id' in request) {
          if (request.method === 'launch') {
            this.#portMap.set(request.id, undefined);
          }
        }
        await this.#sendMessage(request);
      },
      'm',
      this.#logger,
    );
    this.#rpcServer = new RpcService(kernelRemoteHandlers, {
      remoteDeliver: this.#remoteDeliver.bind(this),
      remoteGiveUp: this.#remoteGiveUp.bind(this),
      remoteIncarnationChange: this.#remoteIncarnationChange.bind(this),
    });

    // Start draining messages immediately after construction
    // This runs for the lifetime of the client
    this.#stream
      .drain(this.#handleMessage.bind(this))
      .catch((error: unknown) => {
        this.#logger.error('Error draining stream:', error);
      });
  }

  /**
   * Create and initialize a new {@link PlatformServicesClient}.
   * The client will be ready to handle vat launches after this completes.
   *
   * @param messageTarget - The target to use for posting and receiving messages.
   * @param logger - An optional {@link Logger}.
   * @returns A new {@link PlatformServicesClient}.
   */
  static async make(
    messageTarget: PostMessageTarget,
    logger?: Logger,
  ): Promise<PlatformServicesClient> {
    const stream: PlatformServicesClientStream = new PostMessageDuplexStream({
      messageTarget,
      messageEventMode: 'event',
      validateInput: (
        message: unknown,
      ): message is MessageEvent<JsonRpcMessage> =>
        message instanceof MessageEvent && isJsonRpcMessage(message.data),
    });
    // Synchronize the stream before creating the client
    await stream.synchronize();
    // Now create the client which will start draining immediately
    return new PlatformServicesClient(stream, logger);
  }

  /**
   * Launch a new worker with a specific vat id.
   *
   * @param vatId - The vat id of the worker to launch.
   * @param vatConfig - The configuration for the worker.
   * @returns A promise for a duplex stream connected to the worker
   * which rejects if a worker with the given vat id already exists.
   */
  async launch(
    vatId: VatId,
    vatConfig: VatConfig,
  ): Promise<DuplexStream<JsonRpcMessage, JsonRpcMessage>> {
    const [id] = await this.#rpcClient.callAndGetId('launch', {
      vatId,
      vatConfig,
    });
    const port = this.#portMap.get(id);
    if (!port) {
      throw new Error(
        `No port found for launch of: ${stringify({ vatId, vatConfig })}`,
      );
    }
    this.#portMap.delete(id);
    return await MessagePortDuplexStream.make<JsonRpcMessage, JsonRpcMessage>(
      port,
      isJsonRpcMessage,
    );
  }

  /**
   * Terminate a worker identified by its vat id.
   *
   * @param vatId - The vat id of the worker to terminate.
   * @returns A promise that resolves when the worker has terminated
   * or rejects if that worker does not exist.
   */
  async terminate(vatId: VatId): Promise<void> {
    await this.#rpcClient.call('terminate', { vatId });
  }

  /**
   * Terminate all workers managed by the service.
   *
   * @returns A promise that resolves after all workers have terminated
   * or rejects if there was an error during termination.
   */
  async terminateAll(): Promise<void> {
    await this.#rpcClient.call('terminateAll', []);
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
   * @param incarnationId - Unique identifier for this kernel instance.
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
    this.#remoteMessageHandler = remoteMessageHandler;
    this.#remoteGiveUpHandler = onRemoteGiveUp;
    this.#remoteIncarnationChangeHandler = onIncarnationChange;
    await this.#rpcClient.call('initializeRemoteComms', {
      keySeed,
      ...Object.fromEntries(
        Object.entries(options).filter(([, value]) => value !== undefined),
      ),
      ...(incarnationId !== undefined && { incarnationId }),
    });
  }

  /**
   * Stop network communications.
   *
   * @returns A promise that resolves when network access has been stopped
   *   or rejects if there is some problem doing so.
   */
  async stopRemoteComms(): Promise<void> {
    await this.#rpcClient.call('stopRemoteComms', []);
  }

  /**
   * Send a remote message to a peer.
   *
   * @param to - The peer ID to send the message to.
   * @param message - The serialized message string to send.
   * @returns A promise that resolves when the message has been sent.
   */
  async sendRemoteMessage(to: string, message: string): Promise<void> {
    await this.#rpcClient.call('sendRemoteMessage', { to, message });
  }

  /**
   * Explicitly close a connection to a peer.
   * Marks the peer as intentionally closed to prevent automatic reconnection.
   *
   * @param peerId - The peer ID to close the connection for.
   * @returns A promise that resolves when the connection is closed.
   */
  async closeConnection(peerId: string): Promise<void> {
    await this.#rpcClient.call('closeConnection', { peerId });
  }

  /**
   * Take note of where a peer might be.
   *
   * @param peerId - The peer ID to whom this information applies.
   * @param hints - An array of location hint strings.
   */
  async registerLocationHints(peerId: string, hints: string[]): Promise<void> {
    await this.#rpcClient.call('registerLocationHints', { peerId, hints });
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
    await this.#rpcClient.call('reconnectPeer', { peerId, hints });
  }

  /**
   * Reset all reconnection backoffs.
   * Called after detecting a cross-incarnation wake to avoid unnecessary delays.
   *
   * @returns A promise that resolves when backoffs have been reset.
   */
  async resetAllBackoffs(): Promise<void> {
    await this.#rpcClient.call('resetAllBackoffs', []);
  }

  /**
   * Get the listen addresses of the libp2p node.
   * In the browser runtime, this always returns an empty array since
   * direct transport is only supported in Node.js.
   *
   * @returns An empty array.
   */
  getListenAddresses(): string[] {
    return [];
  }

  /**
   * Handle a remote message from a peer.
   *
   * @param from - The peer ID that sent the message.
   * @param message - The message received.
   * @returns A promise that resolves with the reply message, or null if no reply is needed.
   */
  async #remoteDeliver(from: string, message: string): Promise<string | null> {
    if (this.#remoteMessageHandler) {
      return await this.#remoteMessageHandler(from, message);
    }
    throw Error(`remote message handler not set`);
  }

  /**
   * Handle a remote give up notification from the server.
   *
   * @param peerId - The peer ID of the remote we're giving up on.
   * @returns A promise that resolves when handling is complete.
   */
  async #remoteGiveUp(peerId: string): Promise<null> {
    if (this.#remoteGiveUpHandler) {
      this.#remoteGiveUpHandler(peerId);
    }
    return null;
  }

  /**
   * Forward an incarnationId observed during a peer handshake to the kernel
   * layer. Fires on every successful handshake; the kernel decides whether
   * it represents a peer restart and returns the verdict so the transport
   * can suppress stale outbound messages.
   *
   * Fails closed: handler exceptions and non-boolean returns coerce to
   * `true` so the transport drops the outbound rather than letting a
   * potentially stale message through. Returns `false` only when no handler
   * is registered (transport has no kernel to consult, so the verdict is
   * effectively unknown — the receiver-side persisted check still gates
   * correctness).
   *
   * @param peerId - The peer that completed the handshake.
   * @param observedIncarnation - The incarnationId reported by the peer.
   * @returns Whether the kernel detected a peer restart.
   */
  async #remoteIncarnationChange(
    peerId: string,
    observedIncarnation: string,
  ): Promise<boolean> {
    if (!this.#remoteIncarnationChangeHandler) {
      return false;
    }
    try {
      const verdict = await this.#remoteIncarnationChangeHandler(
        peerId,
        observedIncarnation,
      );
      if (typeof verdict !== 'boolean') {
        this.#logger.error(
          `incarnation handler returned non-boolean ${typeof verdict} for ${peerId.slice(0, 8)}; treating as restart`,
        );
        return true;
      }
      return verdict;
    } catch (error) {
      this.#logger.error(
        `incarnation handler threw for ${peerId.slice(0, 8)}; treating as restart:`,
        error,
      );
      return true;
    }
  }

  /**
   * Send a message to the server.
   *
   * @param payload - The message to send.
   * @returns A promise that resolves when the message has been sent.
   */
  async #sendMessage(payload: JsonRpcMessage): Promise<void> {
    await this.#stream.write({
      payload,
      transfer: [],
    });
  }

  /**
   * Handle a message from the server.
   *
   * @param event - The message event.
   * @returns A promise that resolves when the message has been sent.
   */
  async #handleMessage(event: MessageEvent<JsonRpcMessage>): Promise<void> {
    if (isJsonRpcResponse(event.data)) {
      const { id } = event.data;
      const port = event.ports.at(0);
      if (typeof id !== 'string') {
        this.#logger.error(
          'Received response with unexpected id:',
          stringify(event.data),
        );
        return;
      }

      if (this.#portMap.has(id)) {
        this.#portMap.set(id, port);
      } else if (port !== undefined) {
        this.#logger.error(
          'Received message with unexpected port:',
          stringify(event.data),
        );
      }

      this.#rpcClient.handleResponse(id, event.data);
    } else if (isJsonRpcRequest(event.data)) {
      // Run the request handler in the background instead of awaiting it
      // inside the drain. The drain processes responses too, and a request
      // handler that fires an outbound RPC back to the other side would
      // deadlock waiting for its response — the drain can't get to that
      // response until the request handler returns.
      this.#executeRequest(event.data).catch(() => undefined);
    }
  }

  /**
   * Execute a JSON-RPC request and write the response back. Errors during
   * execution are serialized into a JSON-RPC error response; errors during
   * response delivery are swallowed.
   *
   * @param request - The JSON-RPC request to execute.
   */
  async #executeRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;
    try {
      this.#rpcServer.assertHasMethod(method);
      const result = await this.#rpcServer.execute(method, params);
      await this.#sendMessage({ id, result, jsonrpc: '2.0' });
    } catch (error) {
      await this.#sendMessage({
        id,
        error: serializeError(error),
        jsonrpc: '2.0',
      }).catch(() => undefined);
    }
  }
}
harden(PlatformServicesClient);
