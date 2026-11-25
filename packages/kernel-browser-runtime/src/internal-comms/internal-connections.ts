import { stringify } from '@metamask/kernel-utils';
import type { JsonRpcCall } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import { PostMessageDuplexStream } from '@metamask/streams/browser';
import { isJsonRpcRequest, isJsonRpcResponse } from '@metamask/utils';
import type { JsonRpcResponse } from '@metamask/utils';
import { nanoid } from 'nanoid';

import { isCommsControlMessage } from './comms-control-message.ts';
import type { CommsControlMessage } from './comms-control-message.ts';

export const COMMS_CONTROL_CHANNEL_NAME = 'comms-control';

export type KernelRpcStream = PostMessageDuplexStream<
  JsonRpcCall,
  JsonRpcResponse
>;

export type KernelRpcReplyStream = PostMessageDuplexStream<
  JsonRpcResponse,
  JsonRpcCall
>;

export type HandleInternalMessage = (
  request: JsonRpcCall,
) => Promise<JsonRpcResponse | void>;

type Options = {
  label: string;
  logger: Logger;
  controlChannelName?: string;
};

/**
 * Establishes a connection between an internal process, e.g. a UI instance, and the kernel.
 * Should be called exactly once per internal process, during initialization, after the
 * kernel has called {@link receiveInternalConnections}.
 *
 * @param options - The options for the connection.
 * @param options.logger - The logger instance.
 * @param options.controlChannelName - The name of the control channel. Must match
 * the name used by {@link receiveInternalConnections} on the other end.
 * @param options.label - The label of the internal process. Used to identify the internal
 * process in the logs.
 * @returns The kernel control reply stream.
 */
export const connectToKernel = async ({
  label,
  logger,
  controlChannelName = COMMS_CONTROL_CHANNEL_NAME,
}: Options): Promise<KernelRpcReplyStream> => {
  const commsControlChannel = new BroadcastChannel(controlChannelName);
  const commsChannelName = `${label}-${nanoid()}`;
  const commsChannel = new BroadcastChannel(commsChannelName);

  commsControlChannel.postMessage({
    method: 'init',
    params: { channelName: commsChannelName },
  } satisfies CommsControlMessage);
  commsControlChannel.close();

  const kernelStream = await PostMessageDuplexStream.make<
    JsonRpcResponse,
    JsonRpcCall
  >({
    validateInput: isJsonRpcResponse,
    messageTarget: commsChannel,
    onEnd: () => {
      commsChannel.close();
    },
  });

  commsChannel.onmessageerror = (event) => {
    logger.error(`Internal comms channel error: ${stringify(event.data)}`);
    kernelStream
      .throw(new Error(stringify(event.data)))
      .catch(/* istanbul ignore next */ () => undefined);
    commsChannel.close();
  };

  return kernelStream;
};

const connectToInternalProcess = async (
  channelName: string,
): Promise<KernelRpcStream> => {
  const channel = new BroadcastChannel(channelName);
  const stream: KernelRpcStream = await PostMessageDuplexStream.make({
    validateInput: isJsonRpcRequest,
    messageTarget: channel,
    onEnd: () => {
      channel.close();
    },
  });

  channel.onmessageerror = (event) => {
    stream
      .throw(new Error(stringify(event.data)))
      .catch(/* istanbul ignore next */ () => undefined);
  };

  return stream;
};

type ReceiveConnectionsOptions = Omit<Options, 'label'> &
  (
    | {
        handler: HandleInternalMessage;
        handlerPromise?: never;
      }
    | {
        handler?: never;
        handlerPromise: Promise<HandleInternalMessage>;
      }
  );

/**
 * Listens for connections between the kernel and an internal process, e.g. a UI instance.
 * Should be called exactly once in the kernel, during initialization, before any internal
 * processes have attempted to connect.
 *
 * @param options - The options for the connection.
 * @param options.handler - The function to handle internal messages. Mutually exclusive
 * with `handlerPromise`.
 * @param options.handlerPromise - A promise that resolves to the handler function.
 * Mutually exclusive with `handler`.
 * @param options.logger - The logger instance.
 * @param options.controlChannelName - The name of the control channel. Must match
 * the name used by {@link connectToKernel} on the other end.
 */
export const receiveInternalConnections = ({
  handler: directHandler,
  handlerPromise,
  logger,
  controlChannelName = COMMS_CONTROL_CHANNEL_NAME,
}: ReceiveConnectionsOptions): void => {
  let handler: HandleInternalMessage | null = null;
  let handlerReady: Promise<HandleInternalMessage>;

  if (handlerPromise === undefined) {
    handler = directHandler;
    handlerReady = Promise.resolve(directHandler);
  } else {
    handlerReady = handlerPromise.then((resolvedHandler) => {
      handler = resolvedHandler;
      return resolvedHandler;
    });
  }

  const seenChannels = new Set<string>();
  new BroadcastChannel(controlChannelName).onmessage = (event) => {
    if (!isCommsControlMessage(event.data)) {
      logger.error(
        `Received invalid internal comms control message: ${stringify(event.data)}`,
      );
      return;
    }

    const {
      params: { channelName },
    } = event.data;
    if (seenChannels.has(channelName)) {
      logger.error(`Already connected to internal process "${channelName}"`);
      return;
    }
    seenChannels.add(channelName);

    logger.debug(`Connecting to internal process "${channelName}"`);
    connectToInternalProcess(channelName)
      .then(async (kernelRpcStream) => {
        return kernelRpcStream.drain(async (message) => {
          logger.debug(
            `Received message from internal process "${channelName}": ${JSON.stringify(message)}`,
          );

          const messageHandler = handler ?? (await handlerReady);
          const reply = await messageHandler(message);
          if (reply !== undefined) {
            await kernelRpcStream.write(reply);
          }
        });
      })
      .catch((error) => {
        logger.error(
          `Error handling message from internal process "${channelName}":`,
          error,
        );
      })
      .finally(() => {
        logger.debug(`Closed connection to internal process "${channelName}"`);
        seenChannels.delete(channelName);
      });
  };
};
