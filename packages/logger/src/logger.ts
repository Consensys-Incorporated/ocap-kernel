/**
 * A Logger is a logging facility that supports multiple transports and tags.
 * The transports are the actual logging functions, and the tags are used to
 * identify the source of the log message independent of its location in the
 * code.
 *
 * @example
 * ```ts
 * const logger = new Logger('my-logger');
 * logger.info('Hello, world!');
 * >>> [my-logger] Hello, world!
 * ```
 *
 * Sub-loggers can be created by calling the `subLogger` method. They inherit
 * the tags and transports of their parent logger, and can add additional tags
 * to their own messages.
 *
 *
 * @example
 * ```ts
 * const subLogger = logger.subLogger('sub');
 * subLogger.info('Hello, world!');
 * >>> [my-logger, sub] Hello, world!
 * ```
 *
 * The transports can be configured to ignore certain log levels, or to write
 * different tags to different destinations, and so on. The default transports
 * write to the console, but other transports can be added by passing a custom
 * transport function to the constructor. The transports must be synchronous,
 * but they can initiate asynchronous operations if needed.
 *
 * @example
 * ```ts
 * const logger = new Logger({
 *   tags: ['my-logger'],
 *   transports: [
 *     (entry) => {
 *       if (entry.tags.includes('vat')) {
 *         fs.writeFile('vat.log', `${entry.message}\n`, { flag: 'a' }).catch(
 *           (error) => {
 *             console.error('Error writing to vat.log:', error);
 *           },
 *         );
 *       }
 *     },
 *   ],
 * });
 * ```
 */

import type { DuplexStream } from '@metamask/streams';

import { parseOptions, mergeOptions } from './options.ts';
import { lunser } from './stream.ts';
import type { LogMessage } from './stream.ts';
import type {
  LogLevel,
  LogEntry,
  LoggerOptions,
  LogMethod,
  LogArgs,
} from './types.ts';

// We make use of harden() if it exists, but we don't want to fail if it doesn't.
const harden = globalThis.harden ?? ((value: unknown) => value);

/**
 * The logger class.
 */
export class Logger {
  readonly #options: LoggerOptions;

  /**
   * Logs a message at the 'log' level.
   *
   * @param message - The message to log.
   * @param args - Additional arguments to include in the log entry.
   */
  log: LogMethod;

  /**
   * Logs a message at the 'debug' level.
   *
   * @param message - The message to log.
   * @param args - Additional arguments to include in the log entry.
   */
  debug: LogMethod;

  /**
   * Logs a message at the 'info' level.
   *
   * @param message - The message to log.
   * @param args - Additional arguments to include in the log entry.
   */
  info: LogMethod;

  /**
   * Logs a message at the 'warn' level.
   *
   * @param message - The message to log.
   * @param args - Additional arguments to include in the log entry.
   */
  warn: LogMethod;

  /**
   * Logs a message at the 'error' level.
   *
   * @param message - The message to log.
   * @param args - Additional arguments to include in the log entry.
   */
  error: LogMethod;

  /**
   * The constructor for the logger. Sub-loggers can be created by calling the
   * `subLogger` method. Sub-loggers inherit the transports and tags of their
   * parent logger.
   *
   * @param options - The options for the logger, or a string to use as the
   *   logger's tag.
   * @param options.transports - The transports, which deliver the log messages
   *   to the appropriate destination.
   * @param options.tags - The tags for the logger, which are accumulated by
   *   sub-loggers and passed to the transports.
   */
  constructor(options: LoggerOptions | string | undefined = undefined) {
    this.#options = parseOptions(options);

    // Create aliases for the log methods, allowing them to be used in a
    // manner similar to the console object.
    const bind = (level: LogLevel): LogMethod => {
      return harden(
        this.#dispatch.bind(this, { ...this.#options }, level),
      ) as LogMethod;
    };
    this.debug = bind('debug');
    this.info = bind('info');
    this.log = bind('log');
    this.warn = bind('warn');
    this.error = bind('error');
  }

  /**
   * Creates a sub-logger with the given options.
   *
   * @param options - The options for the sub-logger, or a string to use as the
   *   sub-logger's tag.
   * @returns The sub-logger.
   */
  subLogger(options: LoggerOptions | string = {}): Logger {
    return new Logger(
      mergeOptions(
        this.#options,
        typeof options === 'string' ? { tags: [options] } : options,
      ),
    );
  }

  /**
   * Injects a stream of log messages into the logger.
   *
   * @param stream - The stream of log messages to inject.
   * @param onError - The function to call if an error occurs while draining
   *   the stream. If not provided, the error will be lost to the void.
   */
  injectStream(
    stream: DuplexStream<LogMessage>,
    onError?: (error: unknown) => void,
  ): void {
    stream
      .drain(async ({ params }) => {
        const [, args]: ['logger', string] = params;
        const { level, tags, message, data } = lunser(args);
        const logArgs: LogArgs =
          message === undefined ? [] : [message, ...(data ?? [])];
        this.#dispatch({ tags }, level, ...logArgs);
      })
      .catch((problem) => onError?.(problem));
  }

  /**
   * Dispatches a log entry to all configured transports.
   *
   * @param options - Additional logger options to merge with the instance options.
   * @param level - The severity level of the log entry.
   * @param args - The message and additional data to include in the log entry.
   */
  #dispatch(options: LoggerOptions, level: LogLevel, ...args: LogArgs): void {
    const { transports, tags } = mergeOptions(this.#options, options);
    const [message, ...data] = args;
    // Hardening must stop short of the caller's data: it would freeze whatever
    // was logged, such as state the caller goes on to mutate.
    const entry: LogEntry = Object.freeze({
      ...harden({ level, tags, message }),
      data,
    });
    transports.forEach((transport) => transport(entry));
  }
}
harden(Logger);
