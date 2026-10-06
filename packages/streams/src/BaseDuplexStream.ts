import type { PromiseKit } from '@endo/promise-kit';
import { makePromiseKit } from '@endo/promise-kit';
import { stringify } from '@metamask/kernel-utils';
import { is, literal, object } from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';

import { BaseReader, BaseWriter } from './BaseStream.ts';
import type { Dispatch, Listen, OnEnd, ValidateInput } from './BaseStream.ts';
import type { Reader } from './utils.ts';
import { makeDoneResult } from './utils.ts';

export const DuplexStreamSentinel = {
  Syn: '@@Syn',
  Ack: '@@Ack',
} as const;

const SynStruct = object({
  [DuplexStreamSentinel.Syn]: literal(true),
});

type DuplexStreamSyn = Infer<typeof SynStruct>;

export const isSyn = (value: unknown): value is DuplexStreamSyn =>
  is(value, SynStruct);

export const makeSyn = (): DuplexStreamSyn => ({
  [DuplexStreamSentinel.Syn]: true,
});

const AckStruct = object({
  [DuplexStreamSentinel.Ack]: literal(true),
});

type DuplexStreamAck = Infer<typeof AckStruct>;

export const isAck = (value: unknown): value is DuplexStreamAck =>
  is(value, AckStruct);

export const makeAck = (): DuplexStreamAck => ({
  [DuplexStreamSentinel.Ack]: true,
});

type DuplexStreamSignal = DuplexStreamSyn | DuplexStreamAck;

export const isDuplexStreamSignal = (
  value: unknown,
): value is DuplexStreamSignal => isSyn(value) || isAck(value);

/**
 * Augments a consumer-provided validator so that it accepts
 * {@link DuplexStreamSignal} values.
 *
 * @param validateInput - The validator for the stream's input type.
 * @returns The augmented validator, or `undefined` if none was provided.
 */
const makeDuplexStreamInputValidator = <Read>(
  validateInput?: ValidateInput<Read>,
): ValidateInput<Read> | undefined =>
  validateInput &&
  ((value: unknown): value is Read =>
    isDuplexStreamSignal(value) || validateInput(value));

const SynchronizationStatus = {
  Idle: 0,
  Pending: 1,
  Complete: 2,
  Failed: 3,
} as const;

type SynchronizationStatus =
  (typeof SynchronizationStatus)[keyof typeof SynchronizationStatus];

const isEnded = (status: SynchronizationStatus): boolean =>
  status === SynchronizationStatus.Complete ||
  status === SynchronizationStatus.Failed;

export type BaseDuplexStreamArgs<Read, Write> = {
  name: string;
  listen: Listen;
  onDispatch: Dispatch<Write>;
  validateInput?: ValidateInput<Read> | undefined;
  /**
   * Called once when the stream ends, after the final signal has been dispatched.
   * For cleanup such as closing the transport.
   */
  onEnd?: OnEnd | undefined;
};

/**
 * The base of a duplex stream over some transport. Essentially a
 * {@link BaseReader} with a `write()` method. Backed up by separate
 * {@link BaseReader} and {@link BaseWriter} instances under the hood, each of
 * which ends the other.
 */
export class BaseDuplexStream<Read, Write = Read> implements Reader<Read> {
  readonly #reader: BaseReader<Read>;

  readonly #writer: BaseWriter<Write>;

  /**
   * The promise for the synchronization of the stream with its remote
   * counterpart.
   */
  #syncKit: PromiseKit<void> = makePromiseKit<void>();

  /**
   * Whether the stream is synchronized with its remote counterpart.
   */
  #synchronizationStatus: SynchronizationStatus = SynchronizationStatus.Idle;

  /**
   * Reads the next value from the stream.
   *
   * @returns The next value from the stream.
   */
  next: () => Promise<IteratorResult<Read, undefined>>;

  /**
   * Writes a value to the stream.
   *
   * @param value - The next value to write to the stream.
   * @returns The result of writing the value.
   */
  write: (value: Write) => Promise<IteratorResult<undefined, undefined>>;

  /**
   * Constructs a new {@link BaseDuplexStream}.
   *
   * @param options - Options bag for configuring the duplex stream.
   * @param options.name - The name of the stream, for logging purposes.
   * @param options.listen - Subscribes the stream to its transport.
   * @param options.onDispatch - Dispatches messages over the transport.
   * @param options.validateInput - A function that validates input from the transport.
   * @param options.onEnd - A function that is called once when the stream ends.
   */
  constructor({
    name,
    listen,
    onDispatch,
    validateInput,
    onEnd,
  }: BaseDuplexStreamArgs<Read, Write>) {
    // The writer ends last, so that its final signal is dispatched before onEnd.
    const writer: BaseWriter<Write> = new BaseWriter({
      name,
      onDispatch,
      onEnd: async (error) => {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        await reader.return();
        await onEnd?.(error);
      },
    });
    const reader = new BaseReader<Read>({
      name,
      listen,
      validateInput: makeDuplexStreamInputValidator(validateInput),
      onEnd: async () => {
        await writer.return();
      },
    });

    // Set a catch handler to avoid unhandled rejection errors. The promise may
    // reject before reads or writes occur, in which case there are no handlers.
    this.#syncKit.promise.catch(() => undefined);

    // Next and write only work if synchronization completes.
    this.next = async () => {
      if (this.#synchronizationStatus !== SynchronizationStatus.Complete) {
        return this.#syncKit.promise.then(async () => reader.next());
      }

      const result = await reader.next();

      // If we receive a SYN message, we re-synchronize.
      if (isSyn(result.value)) {
        this.#resetSynchronizationStatus();
        this.#performSynchronization(result).catch((error) => {
          this.#failSynchronization(error);
        });
        return this.#syncKit.promise.then(async () => reader.next());
      }
      return result;
    };

    this.write = async (value: Write) =>
      this.#synchronizationStatus === SynchronizationStatus.Complete
        ? writer.next(value)
        : this.#syncKit.promise.then(async () => writer.next(value));

    this.#reader = reader;
    this.#writer = writer;

    harden(this);
  }

  /**
   * Resets the synchronization status to idle and creates a new promise kit.
   */
  #resetSynchronizationStatus(): void {
    this.#synchronizationStatus = SynchronizationStatus.Idle;
    this.#syncKit = makePromiseKit<void>();
    this.#syncKit.promise.catch(() => undefined);
  }

  /**
   * Synchronizes the duplex stream with its remote counterpart. Must be awaited
   * before values can be read from or written to the stream. Idempotent.
   *
   * @returns A promise that resolves when the stream is synchronized.
   */
  async synchronize(): Promise<void> {
    if (this.#synchronizationStatus !== SynchronizationStatus.Idle) {
      return this.#syncKit.promise;
    }

    try {
      await this.#performSynchronization();
    } catch (error) {
      this.#failSynchronization(error as Error);
    }

    return this.#syncKit.promise;
  }

  /**
   * Performs the synchronization protocol.
   *
   * **ATTN:** The synchronization protocol requires sending values that do not
   * conform to the read and write types of the stream. We do not currently have
   * the type system to express this, so we just override TypeScript and do it
   * anyway. This is far from ideal, but it works because (1) the streams always
   * allow stream signal values at runtime, and (2) the special values cannot
   * be observed by users of the stream.
   *
   * @param previousResult - The result of the previous `next()` call.
   * This method will call `next()` on the reader if not provided. Used
   * when the other side reinitializes synchronization.
   */
  async #performSynchronization(
    previousResult?: IteratorResult<Read, undefined>,
  ): Promise<void> {
    this.#synchronizationStatus = SynchronizationStatus.Pending;
    let receivedSyn = false;
    let sentAck = false;

    const sendAck = async (): Promise<void> => {
      sentAck = true;
      // @ts-expect-error See docstring.
      await this.#writer.next(makeAck());
    };

    // @ts-expect-error See docstring.
    await this.#writer.next(makeSyn());

    let result = previousResult ?? (await this.#reader.next());
    while (this.#synchronizationStatus === SynchronizationStatus.Pending) {
      if (isAck(result.value)) {
        if (!sentAck) {
          await sendAck();
        }
        this.#completeSynchronization();
      } else if (isSyn(result.value)) {
        if (receivedSyn) {
          this.#failSynchronization(
            new Error('Received duplicate SYN message during synchronization'),
          );
        } else {
          receivedSyn = true;
          await sendAck();
          result = await this.#reader.next();
        }
      } else {
        this.#failSynchronization(
          new Error(
            `Received unexpected message during synchronization: ${stringify(result)}`,
          ),
        );
      }
    }
  }

  /**
   * Completes the synchronization by resolving the sync promise. Idempotent.
   */
  #completeSynchronization(): void {
    if (isEnded(this.#synchronizationStatus)) {
      return;
    }

    this.#synchronizationStatus = SynchronizationStatus.Complete;
    this.#syncKit.resolve();
  }

  /**
   * Fails the synchronization by rejecting the sync promise with the given error. Idempotent.
   *
   * @param error - The error to reject the sync promise with.
   */
  #failSynchronization(error: Error): void {
    if (isEnded(this.#synchronizationStatus)) {
      return;
    }

    this.#synchronizationStatus = SynchronizationStatus.Failed;
    this.#syncKit.reject(error);
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
   * Drains the stream by passing each value to a handler function.
   *
   * @param handler - The function that will receive each value from the stream.
   */
  async drain(handler: (value: Read) => void | Promise<void>): Promise<void> {
    for await (const value of this) {
      await handler(value);
    }
  }

  /**
   * Pipes the stream to another duplex stream.
   *
   * @param sink - The duplex stream to pipe to.
   */
  async pipe<Read2>(sink: DuplexStream<Read2, Read>): Promise<void> {
    await this.drain(async (value) => {
      await sink.write(value);
    });
  }

  /**
   * Closes the stream. Idempotent.
   *
   * @returns The final result for this stream.
   */
  async return(): Promise<IteratorResult<Read, undefined>> {
    this.#completeSynchronization();
    await Promise.all([this.#writer.return(), this.#reader.return()]);
    return makeDoneResult();
  }

  /**
   * Closes the stream with an error. Idempotent.
   *
   * @param error - The error to close the stream with.
   * @returns The final result for this stream.
   */
  async throw(error: Error): Promise<IteratorResult<Read, undefined>> {
    this.#failSynchronization(error);
    // eslint-disable-next-line promise/no-promise-in-callback
    await Promise.all([this.#writer.throw(error), this.#reader.throw(error)]);
    return makeDoneResult();
  }

  /**
   * Closes the stream. Syntactic sugar for `throw(error)` or `return()`. Idempotent.
   *
   * @param error - The error to close the stream with.
   * @returns The final result for this stream.
   */
  async end(error?: Error): Promise<IteratorResult<Read, undefined>> {
    return error ? this.throw(error) : this.return();
  }
}
harden(BaseDuplexStream);

/**
 * A duplex stream. Essentially a {@link Reader} with a `write()` method.
 */
export type DuplexStream<Read, Write = Read> = Pick<
  BaseDuplexStream<Read, Write>,
  'next' | 'write' | 'drain' | 'pipe' | 'return' | 'throw' | 'end'
> & {
  [Symbol.asyncIterator]: () => DuplexStream<Read, Write>;
};
