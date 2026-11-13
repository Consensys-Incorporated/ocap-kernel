import {
  makeIframeVatWorker,
  PlatformServicesServer,
  createCommsQueryString,
  setupConsoleForwarding,
  isConsoleForwardMessage,
  isIframeWindow,
} from '@metamask/kernel-browser-runtime';
import { delay, isJsonRpcMessage } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import {
  initializeMessageChannel,
  ChromeRuntimeDuplexStream,
  MessagePortDuplexStream,
} from '@metamask/streams/browser';
import type { PostMessageTarget } from '@metamask/streams/browser';

const logger = new Logger('offscreen');

main().catch(logger.error);

/**
 * Main function to initialize the offscreen document.
 */
async function main(): Promise<void> {
  // Without this delay, sending messages via the chrome.runtime API can fail.
  await delay(50);

  // Create stream for CapTP messages from the background script
  const backgroundStream = await ChromeRuntimeDuplexStream.make<
    JsonRpcMessage,
    JsonRpcMessage
  >(chrome.runtime, 'offscreen', 'background', isJsonRpcMessage);

  setupConsoleForwarding({
    source: 'offscreen',
    onMessage: (message) => {
      backgroundStream.write(message).catch(() => undefined);
    },
  });

  // Listen for console messages from vat iframes and forward to background
  window.addEventListener('message', (event) => {
    if (isIframeWindow(event.source) && isConsoleForwardMessage(event.data)) {
      backgroundStream.write(event.data).catch(() => undefined);
    }
  });

  const kernelStream = await makeKernelWorker();

  // Handle messages from the background script / kernel
  await Promise.all([
    kernelStream.pipe(backgroundStream),
    backgroundStream.pipe(kernelStream),
  ]);
}

/**
 * Creates and initializes the kernel worker.
 *
 * @returns The message port stream for worker communication
 */
async function makeKernelWorker(): Promise<
  DuplexStream<JsonRpcMessage, JsonRpcMessage>
> {
  const workerUrlParams = createCommsQueryString({
    relays: [
      '/ip4/127.0.0.1/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc',
    ],
  });
  workerUrlParams.set('reset-storage', process.env.RESET_STORAGE ?? 'false');

  const workerUrl = new URL(
    /* @vite-ignore */ 'kernel-worker.js',
    import.meta.url,
  );
  workerUrl.search = workerUrlParams.toString();

  const worker = new Worker(workerUrl, {
    type: 'module',
  });

  const port = await initializeMessageChannel((message, transfer) =>
    worker.postMessage(message, transfer),
  );

  const kernelStream = await MessagePortDuplexStream.make<
    JsonRpcMessage,
    JsonRpcMessage
  >(port, isJsonRpcMessage);

  await PlatformServicesServer.make(worker as PostMessageTarget, (vatId) =>
    makeIframeVatWorker({
      id: vatId,
      iframeUri: 'iframe.html',
      getPort: initializeMessageChannel,
      logger: logger.subLogger({
        tags: ['iframe-vat-worker', vatId],
      }),
    }),
  );

  return kernelStream;
}
