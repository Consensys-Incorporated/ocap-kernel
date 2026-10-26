import type { JsonRpcMessage } from '@metamask/kernel-utils';
import type { DuplexStream } from '@metamask/streams';

import { logLevels } from './constants.ts';
import { lser } from './stream.ts';
import { hasTags } from './tags.ts';
import type { Transport, LogArgs, LogLevel, LogMethod } from './types.ts';

type ConsoleTransportOptions = {
  level?: LogLevel;
  tags?: boolean;
};

/**
 * The console transport for the logger.
 *
 * @param options - Options for the console transport.
 * @param options.level - The logging level for this instance (default: `'debug'`).
 * @param options.tags - Whether to include tags in the output (default: `false`).
 * @returns A transport function that writes to the console.
 */
export function makeConsoleTransport(
  options: ConsoleTransportOptions = {},
): Transport {
  const { level = 'debug', tags = false } = options;
  const baseLevelIdx = logLevels[level];
  const logFn = (method: LogLevel): LogMethod => {
    if (baseLevelIdx <= logLevels[method]) {
      return (...args: unknown[]) => {
        // Ultimately, a console somewhere is an acceptable terminal for logging
        console[method](...args);
      };
    }
    // oxlint-disable-next-line no-empty-function
    return harden(() => {}) as LogMethod;
  };
  const filteredConsole = {
    debug: logFn('debug'),
    info: logFn('info'),
    log: logFn('log'),
    warn: logFn('warn'),
    error: logFn('error'),
  };
  return (entry) => {
    const args = [
      ...(hasTags(tags, entry) ? [entry.tags] : []),
      ...(entry.message ? [entry.message] : []),
      ...(entry.data ?? []),
    ] as LogArgs;
    filteredConsole[entry.level](...args);
  };
}

/**
 * The stream transport for the logger. Expects the stream is listening for
 * log entries.
 *
 * @param stream - The stream to write the log entry to.
 * @returns A transport function that writes to the stream.
 */
export const makeStreamTransport = (
  stream: DuplexStream<JsonRpcMessage>,
): Transport => {
  return (entry) => {
    stream
      .write({
        method: 'notify',
        params: ['logger', lser(entry)],
        jsonrpc: '2.0',
      })
      // This is a last resort, but it's better than nothing
      // oxlint-disable-next-line no-console
      .catch(console.debug);
  };
};

export const makeArrayTransport = (
  target: Parameters<Transport>[0][],
): Transport => {
  return (entry) => {
    target.push(entry);
  };
};
