import { makePromiseKit } from '@endo/promise-kit';
import { stringify } from '@metamask/kernel-utils';
import type { PromiseCallbacks } from '@metamask/kernel-utils';

import type { Dispatchable, Reader, Writer } from './utils.ts';
import {
  isSignalLike,
  makeDoneResult,
  makePendingResult,
  makeStreamDoneSignal,
  makeStreamErrorSignal,
  parseSignal,
} from './utils.ts';

const makeStreamBuffer = <
  Value extends IteratorResult<unknown, undefined>,
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
>() => {
  const inputBuffer: (Value | Error)[] = [];
  const outputBuffer: PromiseCallbacks[] = [];
  let done = false;

  return {
    /**
     * Flushes pending reads with a value or error, and causes subsequent writes to be ignored.
     * Subsequent reads will exhaust any puts, then return the error (if any), and finally a `done` result.
     * Idempotent.
     *
     * @param error - The error to end the stream with. A `done` result is used if not provided.
     */
    end: (error?: Error): void => {
      if (done) {
        return;
      }
      done = true;

      for (const { resolve, reject } of outputBuffer) {
        error ? reject(error) : resolve(makeDoneResult() as Value);
      }
      outputBuffer.length = 0;
    },

    hasPendingReads(): boolean {
      return outputBuffer.length > 0;
    },

    /**
     * Puts a value or error into the buffer.
     *
     * @see `end()` for behavior when the stream ends.
     * @param value - The value or error to put.
     */
    put(value: Value | Error): void {
      if (done) {
        return;
      }

      if (outputBuffer.length > 0) {
        const { resolve } = outputBuffer.shift() as PromiseCallbacks;
        resolve(value);
        return;
      }
      inputBuffer.push(value);
    },

    async get(): Promise<Value> {
      if (inputBuffer.length > 0) {
        const value = inputBuffer.shift() as Value;
        return value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(value);
      }

      if (done) {
        return makeDoneResult() as Value;
      }

      const { promise, resolve, reject } = makePromiseKit<Value>();
      outputBuffer.push({
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      return promise;
    },
  };
};
harden(makeStreamBuffer);

/**
 * A function that is called when a stream ends. Useful for cleanup, such as closing a
 * message port.
 */
export type OnEnd = (error?: Error) => void | Promise<void>;

/**
 * A function that validates input to a readable stream.
 */
export type ValidateInput<Read> = (input: unknown) => input is Read;

/**
 * Forwards input from a transport to a reader. Never rejects; invalid input ends
 * the reader with an error.
 */
export type ReceiveInput = (input: unknown) => Promise<void>;

/**
 * Subscribes a reader to its transport. May return a function that unsubscribes it,
 * which is called when the reader ends.
 */
export type Listen = (
  receiveInput: (input: unknown) => void,
) => (() => void) | void;

export type BaseReaderArgs<Read> = {
  listen: Listen;
  name?: string | undefined;
  onEnd?: OnEnd | undefined;
  validateInput?: ValidateInput<Read> | undefined;
};

/**
 * The base of a readable async iterator stream.
 *
 * The result of any value received before the stream ends is guaranteed to be observable
 * by the consumer.
 */
export class BaseReader<Read> implements Reader<Read> {
  /**
   * A buffer for managing backpressure (writes > reads) and "suction" (reads > writes) for a stream.
   * Modeled on `AsyncQueue` from `@endo/stream`, but with arrays under the hood instead of a promise chain.
   */
  readonly #buffer = makeStreamBuffer<IteratorResult<Read, undefined>>();

  readonly #name: string;

  readonly #validateInput?: ValidateInput<Read> | undefined;

  #onEnd?: OnEnd | undefined;

  /**
   * Constructs a {@link BaseReader}.
   *
   * @param options - Options bag for configuring the reader.
   * @param options.listen - Subscribes the reader to its transport.
   * @param options.name - The name of the stream, for logging purposes. Defaults to the class name.
   * @param options.onEnd - A function that is called when the stream ends.
   * @param options.validateInput - A function that validates input from the transport.
   */
  constructor({ listen, name, onEnd, validateInput }: BaseReaderArgs<Read>) {
    this.#name = name ?? this.constructor.name;
    this.#validateInput = validateInput;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Never rejects.
    const unlisten = listen(this.#receiveInput);
    this.#onEnd = async (error) => {
      unlisten?.();
      await onEnd?.(error);
    };
    harden(this);
  }

  readonly #receiveInput: ReceiveInput = async (input) => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await null;
    try {
      if (isSignalLike(input)) {
        const error = parseSignal(input);
        if (error) {
          throw error;
        }
        await this.#end();
        return;
      }
      if (this.#validateInput?.(input) === false) {
        throw new Error(
          `${this.#name}: Message failed type validation:\n${stringify(input)}`,
        );
      }
      this.#buffer.put(makePendingResult(input));
    } catch (error) {
      if (!this.#buffer.hasPendingReads()) {
        this.#buffer.put(error as Error);
      }
      await this.#end(error as Error).catch(() => undefined);
    }
  };

  /**
   * Ends the stream. Calls and then unsets the `#onEnd` method.
   * Idempotent.
   *
   * @param error - The error to end the stream with. A `done` result is used if not provided.
   */
  async #end(error?: Error): Promise<void> {
    this.#buffer.end(error);
    const onEnd = this.#onEnd;
    this.#onEnd = undefined;
    await onEnd?.(error);
  }

  /**
   * Returns the async iterator for this stream.
   *
   * @returns This stream as an async iterator.
   */
  [Symbol.asyncIterator](): typeof this {
    return this;
  }

  /**
   * Reads the next message from the transport.
   *
   * @returns The next message from the transport.
   */
  async next(): Promise<IteratorResult<Read, undefined>> {
    return this.#buffer.get();
  }

  /**
   * Closes the underlying transport and returns. Any unread messages will be lost.
   *
   * @returns The final result for this stream.
   */
  async return(): Promise<IteratorResult<Read, undefined>> {
    await this.#end();
    return makeDoneResult();
  }

  /**
   * Rejects all pending reads with the specified error, closes the underlying transport,
   * and returns.
   *
   * @param error - The error to reject pending reads with.
   * @returns The final result for this stream.
   */
  async throw(error: Error): Promise<IteratorResult<Read, undefined>> {
    await this.#end(error);
    return makeDoneResult();
  }

  /**
   * Closes the stream. Syntactic sugar for `return()` or `throw(error)`. Idempotent.
   *
   * @param error - The error to close the stream with.
   * @returns The final result for this stream.
   */
  async end(error?: Error): Promise<IteratorResult<Read, undefined>> {
    return error ? this.throw(error) : this.return();
  }
}
harden(BaseReader);

export type Dispatch<Yield> = (
  value: Dispatchable<Yield>,
) => void | Promise<void>;

export type BaseWriterArgs<Write> = {
  onDispatch: Dispatch<Write>;
  name?: string | undefined;
  onEnd?: OnEnd | undefined;
};

/**
 * The base of a writable async iterator stream.
 */
export class BaseWriter<Write> implements Writer<Write> {
  #isDone: boolean = false;

  readonly #name: string;

  readonly #onDispatch: Dispatch<Write>;

  #onEnd?: OnEnd | undefined;

  /**
   * Constructs a {@link BaseWriter}.
   *
   * @param options - Options bag for configuring the writer.
   * @param options.onDispatch - A function that dispatches messages over the underlying transport mechanism.
   * @param options.name - The name of the stream, for logging purposes. Defaults to the class name.
   * @param options.onEnd - A function that is called when the stream ends.
   */
  constructor({ name, onDispatch, onEnd }: BaseWriterArgs<Write>) {
    this.#name = name ?? this.constructor.name;
    this.#onDispatch = onDispatch;
    this.#onEnd = onEnd;
    harden(this);
  }

  /**
   * Dispatches the final signal and calls `onEnd`. The writer ends even if
   * either throws. Idempotent.
   *
   * @param error - The error to end the stream with.
   */
  async #end(error?: Error): Promise<void> {
    if (this.#isDone) {
      return;
    }
    this.#isDone = true;
    const onEnd = this.#onEnd;
    this.#onEnd = undefined;
    try {
      await this.#onDispatch(
        error ? makeStreamErrorSignal(error) : makeStreamDoneSignal(),
      );
    } finally {
      await onEnd?.(error);
    }
  }

  /**
   * Returns the async iterator for this stream.
   *
   * @returns This stream as an async iterator.
   */
  [Symbol.asyncIterator](): typeof this {
    return this;
  }

  /**
   * Writes the next message to the transport. If dispatching fails, forwards the
   * failure to the transport (if possible) and ends the stream.
   *
   * @param value - The next message to write to the transport.
   * @returns The result of writing the message.
   */
  async next(value: Write): Promise<IteratorResult<undefined, undefined>> {
    if (this.#isDone) {
      return makeDoneResult();
    }
    try {
      await this.#onDispatch(value);
    } catch (cause) {
      await this.#end(
        /* istanbul ignore next: The ternary is mostly to please TypeScript */
        cause instanceof Error ? cause : new Error(String(cause)),
      ).catch(() => undefined);
      throw new Error(`${this.#name} experienced a dispatch failure`, {
        cause,
      });
    }
    return makePendingResult(undefined);
  }

  /**
   * Closes the underlying transport and returns. Idempotent.
   *
   * @returns The final result for this stream.
   */
  async return(): Promise<IteratorResult<undefined, undefined>> {
    await this.#end();
    return makeDoneResult();
  }

  /**
   * Forwards the error to the transport and closes this stream. Idempotent.
   *
   * @param error - The error to forward to the transport.
   * @returns The final result for this stream.
   */
  async throw(error: Error): Promise<IteratorResult<undefined, undefined>> {
    await this.#end(error);
    return makeDoneResult();
  }

  /**
   * Closes the stream. Syntactic sugar for `return()` or `throw(error)`. Idempotent.
   *
   * @param error - The error to close the stream with.
   * @returns The final result for this stream.
   */
  async end(error?: Error): Promise<IteratorResult<undefined, undefined>> {
    return error ? this.throw(error) : this.return();
  }
}
harden(BaseWriter);
