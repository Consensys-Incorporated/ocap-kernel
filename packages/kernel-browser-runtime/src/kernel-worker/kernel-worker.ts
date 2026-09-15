import { JsonRpcServer } from '@metamask/json-rpc-engine/v2';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/wasm';
import { isJsonRpcMessage, stringify } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { Kernel } from '@metamask/ocap-kernel';
import type { PostMessageTarget } from '@metamask/streams/browser';
import {
  MessagePortDuplexStream,
  receiveMessagePort,
} from '@metamask/streams/browser';

import {
  isCapTPNotification,
  makeCapTPNotification,
} from '../background-captp.ts';
import type { CapTPMessage } from '../background-captp.ts';
import { receiveInternalConnections } from '../internal-comms/internal-connections.ts';
import { PlatformServicesClient } from '../PlatformServicesClient.ts';
import { setupConsoleForwarding } from '../utils/console-forwarding.ts';
import { makeKernelCapTP } from './captp/index.ts';
import { makeLoggingMiddleware } from './middleware/logging.ts';
import { makePanelMessageMiddleware } from './middleware/panel-message.ts';
import { getCommsParamsFromCurrentLocation } from '../utils/comms-query-string.ts';

const logger = new Logger('kernel-worker');
const DB_FILENAME = 'store.db';

main().catch(logger.error);

/**
 * Run the kernel.
 */
async function main(): Promise<void> {
  const port = await receiveMessagePort(
    (listener) => globalThis.addEventListener('message', listener),
    (listener) => globalThis.removeEventListener('message', listener),
  );

  const [messageStream, platformServicesClient, kernelDatabase] =
    await Promise.all([
      MessagePortDuplexStream.make<JsonRpcMessage, JsonRpcMessage>(
        port,
        isJsonRpcMessage,
      ),
      PlatformServicesClient.make(globalThis as PostMessageTarget),
      makeSQLKernelDatabase({
        dbFilename: DB_FILENAME,
        logger: logger.subLogger({ tags: ['kernel-store'] }),
      }),
    ]);

  setupConsoleForwarding({
    source: 'kernel-worker',
    onMessage: (message) => {
      messageStream.write(message).catch(() => undefined);
    },
  });

  const urlParams = new URLSearchParams(globalThis.location.search);
  const resetStorage = urlParams.get('reset-storage') === 'true';
  const systemSubclustersParam = urlParams.get('system-subclusters');
  const systemSubclusters = systemSubclustersParam
    ? JSON.parse(systemSubclustersParam)
    : undefined;

  const kernelP = Kernel.make(platformServicesClient, kernelDatabase, {
    resetStorage,
    systemSubclusters,
    // Log and stay up, deliberately. `self.close()` would match what the daemon
    // does, but here it would remove the only diagnostic without buying any
    // recovery: nothing respawns this worker, the vat iframes belong to the
    // offscreen document and would outlive it as orphans, and the panel keeps
    // its last successful status when polling fails — so it would go on showing
    // a healthy kernel forever. Staying up is what lets `getStatus` report
    // `runLoop: failed` and the panel say so. Reviving the browser kernel means
    // teardown and respawn driven from the offscreen document.
    onRunLoopFailure: (error) => {
      logger.error(
        'Kernel run loop died; this worker must be reloaded.',
        error,
      );
    },
  });

  const handlerP = kernelP.then((kernel) => {
    const server = new JsonRpcServer({
      middleware: [
        makeLoggingMiddleware(logger.subLogger('internal-rpc')),
        makePanelMessageMiddleware(kernel, kernelDatabase),
      ],
    });
    return async (request: JsonRpcMessage) => server.handle(request);
  });

  receiveInternalConnections({
    handlerPromise: handlerP,
    logger,
  });

  const kernel = await kernelP;

  const kernelCapTP = makeKernelCapTP({
    kernel,
    send: (captpMessage: CapTPMessage) => {
      const notification = makeCapTPNotification(captpMessage);
      messageStream.write(notification).catch((error) => {
        logger.error('Failed to send CapTP message:', error);
      });
    },
  });

  messageStream
    .drain((message) => {
      if (isCapTPNotification(message)) {
        const captpMessage = message.params[0];
        kernelCapTP.dispatch(captpMessage);
      } else {
        throw new Error(`Unexpected message: ${stringify(message)}`);
      }
    })
    .catch((error) => {
      kernelCapTP.abort(error);
      logger.error('Message stream error:', error);
    });

  const commsOptions = getCommsParamsFromCurrentLocation();
  await kernel.initRemoteComms(commsOptions);
}
