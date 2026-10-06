import { stringify } from '@metamask/kernel-utils';

import type { DuplexStream } from './BaseDuplexStream.ts';
import { BaseReader } from './BaseStream.ts';
import type { ReceiveInput } from './BaseStream.ts';

/**
 * A {@link DuplexStream} for use within {@link split} that reads a subset of its
 * parent's values and forwards writes to its parent.
 */
class SplitStream<Read, Write> implements DuplexStream<Read, Write> {
  readonly #parent: DuplexStream<unknown, Write>;

  readonly #reader: BaseReader<Read>;

  /**
   * Constructs a new {@link SplitStream}.
   *
   * @param parent - The parent stream.
   * @param reader - The reader that receives this split's subset of the parent's values.
   */
  constructor(parent: DuplexStream<unknown, Write>, reader: BaseReader<Read>) {
    this.#parent = parent;
    this.#reader = reader;
    harden(this);
  }

  /**
   * Reads the next value from the stream.
   *
   * @returns The next value from the stream.
   */
  async next(): Promise<IteratorResult<Read, undefined>> {
    return this.#reader.next();
  }

  /**
   * Writes a value to the parent stream.
   *
   * @param value - The value to write.
   * @returns The result of writing the value.
   */
  async write(value: Write): Promise<IteratorResult<undefined, undefined>> {
    return this.#parent.write(value);
  }

  /**
   * Drains the stream by passing each value to a handler function.
   *
   * @param handler - The function that will receive each value from the stream.
   */
  async drain(handler: (value: Read) => void | Promise<void>): Promise<void> {
    for await (const value of this.#reader) {
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
   * Closes the stream and its parent. Idempotent.
   *
   * @returns The final result for this stream.
   */
  async return(): Promise<IteratorResult<Read, undefined>> {
    return this.end();
  }

  /**
   * Closes the stream and its parent with an error. Idempotent.
   *
   * @param error - The error to close the stream with.
   * @returns The final result for this stream.
   */
  async throw(error: Error): Promise<IteratorResult<Read, undefined>> {
    return this.end(error);
  }

  /**
   * Closes the stream and its parent. Idempotent.
   *
   * @param error - The error to close the stream with.
   * @returns The final result for this stream.
   */
  async end(error?: Error): Promise<IteratorResult<Read, undefined>> {
    await this.#parent.end(error);
    return this.#reader.end(error);
  }

  /**
   * Returns the async iterator for this stream.
   *
   * @returns This stream as an async iterator.
   */
  [Symbol.asyncIterator](): typeof this {
    return this;
  }
}
harden(SplitStream);

type Splits<Read, Write, Predicates> = {
  [Index in keyof Predicates]: DuplexStream<
    Predicates[Index] extends ((
      value: Read,
    ) => value is infer Narrowed extends Read)
      ? Narrowed
      : Read,
    Write
  >;
};

/**
 * Splits a stream into one stream per predicate. Each value read from the parent
 * goes to the first split whose predicate it matches; a value that matches none
 * ends all splits with an error. Writes to any split go to the parent, and ending
 * any split ends the parent and therefore all splits.
 *
 * @param parentStream - The stream to split.
 * @param predicates - The predicates to use to split the stream.
 * @returns An array of "splits" of the parent stream.
 */
export function split<
  Read,
  Write,
  Predicates extends ((value: Read) => boolean)[],
>(
  parentStream: DuplexStream<Read, Write>,
  ...predicates: Predicates
): Splits<Read, Write, Predicates> {
  const splits = predicates.map((predicate) => {
    let receiveInput!: ReceiveInput;
    const reader = new BaseReader<Read>({
      name: 'SplitStream',
      listen: (receive) => {
        receiveInput = receive as ReceiveInput;
      },
    });
    const stream = new SplitStream(parentStream, reader);
    return { predicate, receiveInput, stream };
  });

  // eslint-disable-next-line no-void
  void (async () => {
    let error: Error | undefined;
    try {
      for await (const value of parentStream) {
        const match = splits.find(({ predicate }) => predicate(value));
        if (!match) {
          throw new Error(
            `Failed to match any predicate for value: ${stringify(value)}`,
          );
        }
        // Awaited so that every value is received before the splits end.
        await match.receiveInput(value);
      }
    } catch (caughtError) {
      error = caughtError as Error;
    }

    await Promise.all(splits.map(async ({ stream }) => stream.end(error)));
  })();

  return splits.map(({ stream }) => stream) as Splits<Read, Write, Predicates>;
}
