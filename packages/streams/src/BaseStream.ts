import { makePromiseKit } from '@endo/promise-kit';
import type { Reader, Writer } from '@endo/stream';
import { stringify } from '@metamask/kernel-utils';
import type { PromiseCallbacks } from '@metamask/kernel-utils';

import type { Dispatchable, Writable } from './utils.ts';
import {
  makeDoneResult,
  makePendingResult,
  makeStreamDoneSignal,
  makeStreamErrorSignal,
  marshal,
  StreamDoneSymbol,
  unmarshal,
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
 * A function that receives input from a transport mechanism to a readable stream.
 * Validates that the input is an {@link IteratorResult}, and throws if it is not.
 */
export type ReceiveInput = (input: unknown) => Promise<void>;

export type BaseReaderArgs<Read> = {
  name?: string | undefined;
  onEnd?: OnEnd | undefined;
  validateInput?: ValidateInput<Read> | undefined;
};

/**
 * The base of a readable async iterator stream.
 *
 * Subclasses must forward input received from the transport mechanism via the function
 * returned by `getReceiveInput()`. Any cleanup required by subclasses should be performed
 * in a callback passed to `setOnEnd()`.
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

  #didExposeReceiveInput: boolean = false;

  /**
   * Constructs a {@link BaseReader}.
   *
   * @param options - Options bag for configuring the reader.
   * @param options.name - The name of the stream, for logging purposes. Defaults to the class name.
   * @param options.onEnd - A function that is called when the stream ends. For any cleanup that
   * should happen when the stream ends, such as closing a message port.
   * @param options.validateInput - A function that validates input from the transport.
   */
  constructor({ name, onEnd, validateInput }: BaseReaderArgs<Read>) {
    this.#name = name ?? this.constructor.name;
    this.#onEnd = onEnd;
    this.#validateInput = validateInput;
    harden(this);
  }

  /**
   * Returns the `receiveInput()` method, which is used to receive input from the stream.
   * Attempting to call this method more than once will throw an error.
   *
   * @returns The `receiveInput()` method.
   */
  protected getReceiveInput(): ReceiveInput {
    if (this.#didExposeReceiveInput) {
      throw new Error(
        `${this.#name} received multiple calls to getReceiveInput()`,
      );
    }
    this.#didExposeReceiveInput = true;
    return this.#receiveInput.bind(this);
  }

  readonly #receiveInput = async (input: unknown): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await null;

    const unmarshaled = unmarshal(input);
    if (unmarshaled instanceof Error) {
      await this.#handleInputError(unmarshaled);
      return;
    }

    if (unmarshaled === StreamDoneSymbol) {
      await this.#end();
      return;
    }

    if (this.#validateInput?.(unmarshaled) === false) {
      await this.#handleInputError(
        new Error(
          `${this.#name}: Message failed type validation:\n${stringify(unmarshaled)}`,
        ),
      );
      return;
    }

    this.#buffer.put(makePendingResult(unmarshaled));
  };

  /**
   * Handles an input error by putting it into the buffer and ending the stream.
   *
   * @param error - The error to handle.
   */
  async #handleInputError(error: Error): Promise<void> {
    if (!this.#buffer.hasPendingReads()) {
      this.#buffer.put(error);
    }
    await this.#end(error);
  }

  /**
   * Ends the stream. Calls and then unsets the `#onEnd` method.
   * Idempotent.
   *
   * @param error - The error to end the stream with. A `done` result is used if not provided.
   */
  async #end(error?: Error): Promise<void> {
    this.#buffer.end(error);
    const onEndP = this.#onEnd?.(error);
    this.#onEnd = undefined;
    await onEndP;
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

  readonly #name: string = 'BaseWriter';

  readonly #onDispatch: Dispatch<Write>;

  #onEnd?: OnEnd | undefined;

  /**
   * Constructs a {@link BaseWriter}.
   *
   * @param options - Options bag for configuring the writer.
   * @param options.onDispatch - A function that dispatches messages over the underlying transport mechanism.
   * @param options.name - The name of the stream, for logging purposes. Defaults to the class name.
   * @param options.onEnd - A function that is called when the stream ends. For any cleanup that
   * should happen when the stream ends, such as closing a message port.
   */
  constructor({ name, onDispatch, onEnd }: BaseWriterArgs<Write>) {
    this.#name = name ?? this.constructor.name;
    this.#onDispatch = onDispatch;
    this.#onEnd = onEnd;
    harden(this);
  }

  /**
   * Dispatches the value, via the dispatch function registered in the constructor.
   * If dispatching fails, calls `#throw()`, and is therefore mutually recursive with
   * that method. For this reason, includes a flag indicating past failure to dispatch
   * a value, which is used to avoid infinite recursion. If dispatching succeeds, returns a
   * `{ done: true }` result if the value was an {@link Error} or itself a `done` result,
   * otherwise returns `{ done: false }`.
   *
   * @param value - The value to dispatch.
   * @param hasFailed - Whether dispatching has failed previously.
   * @returns The result of dispatching the value.
   */
  async #dispatch(
    value: Writable<Write>,
    hasFailed = false,
  ): Promise<IteratorResult<undefined, undefined>> {
    try {
      await this.#onDispatch(marshal(value));
      return value === StreamDoneSymbol || value instanceof Error
        ? makeDoneResult()
        : makePendingResult(undefined);
    } catch (error) {
      if (hasFailed) {
        // Break out of repeated failure to dispatch an error. It is unclear how this would occur
        // in practice, but it's the kind of failure mode where it's better to be sure.
        const repeatedFailureError = new Error(
          `${this.#name} experienced repeated dispatch failures.`,
          { cause: error },
        );
        await this.#onDispatch(makeStreamErrorSignal(repeatedFailureError));
        throw repeatedFailureError;
      } else {
        await this.#throw(
          /* istanbul ignore next: The ternary is mostly to please TypeScript */
          error instanceof Error ? error : new Error(String(error)),
          true,
        );
        throw new Error(`${this.#name} experienced a dispatch failure`, {
          cause: error,
        });
      }
    }
  }

  /**
   * Ends the stream and calls the onEnd callback. Idempotent.
   *
   * @param error - The error to end the stream with.
   */
  async #end(error?: Error): Promise<void> {
    this.#isDone = true;
    const onEndP = this.#onEnd?.(error);
    this.#onEnd = undefined;
    await onEndP;
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
   * Writes the next message to the transport.
   *
   * @param value - The next message to write to the transport.
   * @returns The result of writing the message.
   */
  async next(value: Write): Promise<IteratorResult<undefined, undefined>> {
    if (this.#isDone) {
      return makeDoneResult();
    }
    return this.#dispatch(value);
  }

  /**
   * Closes the underlying transport and returns. Idempotent.
   * The stream ends even if dispatching the done signal fails, in which case
   * the dispatch error is rethrown.
   *
   * @returns The final result for this stream.
   */
  async return(): Promise<IteratorResult<undefined, undefined>> {
    if (!this.#isDone) {
      try {
        await this.#onDispatch(makeStreamDoneSignal());
      } finally {
        await this.#end();
      }
    }
    return makeDoneResult();
  }

  /**
   * Forwards the error to the transport and closes this stream. Idempotent.
   *
   * @param error - The error to forward to the transport.
   * @returns The final result for this stream.
   */
  async throw(error: Error): Promise<IteratorResult<undefined, undefined>> {
    if (!this.#isDone) {
      await this.#throw(error);
    }
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

  /**
   * Dispatches the error and calls `#end()`. Mutually recursive with `dispatch()`.
   * For this reason, includes a flag indicating past failure, so that `dispatch()`
   * can avoid infinite recursion. See `dispatch()` for more details.
   *
   * @param error - The error to forward.
   * @param hasFailed - Whether dispatching has failed previously.
   * @returns The final result for this stream.
   */
  async #throw(
    error: Error,
    hasFailed = false,
  ): Promise<IteratorResult<undefined, undefined>> {
    const result = this.#dispatch(error, hasFailed);
    if (!this.#isDone) {
      await this.#end(error);
    }
    return result;
  }
}
harden(BaseWriter);
