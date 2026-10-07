import { stringify } from '@metamask/kernel-utils';
import {
  object,
  literal,
  string,
  array,
  enums,
  is,
} from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';

const ConsoleForwardMessageStruct = object({
  jsonrpc: literal('2.0'),
  method: literal('console-forward'),
  params: object({
    source: string(),
    method: enums(['log', 'debug', 'info', 'warn', 'error']),
    args: array(string()),
  }),
});

/**
 * Message type for forwarding console output from one context to another.
 * Used to capture console logs from offscreen documents in Playwright tests.
 */
export type ConsoleForwardMessage = Infer<typeof ConsoleForwardMessageStruct>;

/**
 * Type guard for console-forward messages.
 *
 * @param value - The value to check.
 * @returns Whether the value is a ConsoleForwardMessage.
 */
export const isConsoleForwardMessage = (
  value: unknown,
): value is ConsoleForwardMessage => is(value, ConsoleForwardMessageStruct);

/**
 * Checks whether a message event source is the window of an iframe in the
 * current document. Vat iframes are sandboxed and have the opaque origin
 * `"null"`, so their messages cannot be authenticated by `event.origin`.
 *
 * @param source - The `source` of a message event.
 * @returns Whether the source is the window of an iframe in the document.
 */
export const isIframeWindow = (source: MessageEventSource | null): boolean =>
  source !== null &&
  Array.from(document.querySelectorAll('iframe')).some(
    (iframe) => iframe.contentWindow === source,
  );

/**
 * Wraps console methods to forward messages via a provided callback.
 * This enables capturing console output from contexts that Playwright cannot
 * directly access (like offscreen documents, workers, or iframes).
 *
 * Call this early in the context's initialization. After setup, console output
 * will be forwarded to the callback where it can be sent to a stream, posted
 * to a parent window, or handled in any other way.
 *
 * @param options - The options for setting up console forwarding.
 * @param options.source - The source identifier for this context (e.g., 'offscreen', 'kernel-worker', 'vat-v1').
 * @param options.onMessage - Callback invoked with each console message.
 */
export function setupConsoleForwarding({
  source,
  onMessage,
}: {
  source: string;
  onMessage: (message: ConsoleForwardMessage) => void;
}): void {
  const originalConsole = { ...console };
  const consoleMethods = ['log', 'debug', 'info', 'warn', 'error'] as const;

  consoleMethods.forEach((consoleMethod) => {
    // eslint-disable-next-line no-console
    console[consoleMethod] = (...args: unknown[]) => {
      // Call original console method
      originalConsole[consoleMethod](...args);

      // Forward via callback
      const message: ConsoleForwardMessage = {
        jsonrpc: '2.0',
        method: 'console-forward',
        params: {
          source,
          method: consoleMethod,
          args: args.map((arg) => stringify(arg, 0)),
        },
      };
      onMessage(message);
    };
  });

  harden(globalThis.console);
}

/**
 * Handles a console-forward message by replaying it to the local console.
 * Use this in the stream handler to replay forwarded console output.
 *
 * @param message - The console-forward message to handle.
 */
export function handleConsoleForwardMessage(
  message: ConsoleForwardMessage,
): void {
  const { source, method, args } = message.params;
  // eslint-disable-next-line no-console
  console[method](`[${source}]`, ...args);
}
