import {
  isMarshaledError,
  marshalError,
  unmarshalError,
} from '@metamask/kernel-errors';
import { stringify } from '@metamask/kernel-utils';
import type { Infer } from '@metamask/superstruct';
import { is, literal } from '@metamask/superstruct';
import {
  hasProperty,
  isObject,
  object,
  UnsafeJsonStruct,
} from '@metamask/utils';

/**
 * An async iterator that does not conflate its read and write types. Matches the
 * `Stream` type of `@endo/stream`.
 */
type Stream<Read, Write> = {
  next(value: Write): Promise<IteratorResult<Read, undefined>>;
  return(): Promise<IteratorResult<Read, undefined>>;
  throw(error: Error): Promise<IteratorResult<Read, undefined>>;
  [Symbol.asyncIterator](): Stream<Read, Write>;
};

export type Reader<Read> = Stream<Read, undefined>;

export type Writer<Write> = Stream<undefined, Write>;

export const StreamSentinel = {
  Error: '@@StreamError',
  Done: '@@StreamDone',
} as const;

const StreamDoneStruct = object({
  [StreamSentinel.Done]: literal(true),
});

const StreamErrorStruct = object({
  [StreamSentinel.Error]: literal(true),
  error: UnsafeJsonStruct,
});

type StreamDone = Infer<typeof StreamDoneStruct>;

type StreamError = Infer<typeof StreamErrorStruct>;

export type StreamSignal = StreamError | StreamDone;

export const isSignalLike = (value: unknown): value is StreamSignal =>
  isObject(value) &&
  (hasProperty(value, StreamSentinel.Error) ||
    hasProperty(value, StreamSentinel.Done));

export const makeStreamErrorSignal = (error: Error): StreamError => ({
  [StreamSentinel.Error]: true,
  error: marshalError(error),
});

export const makeStreamDoneSignal = (): StreamDone => ({
  [StreamSentinel.Done]: true,
});

/**
 * Parses a stream signal.
 *
 * @param signal - The signal to parse.
 * @returns The error carried by an error signal, or `undefined` for a done signal.
 * @throws If the value is not a valid stream signal.
 */
export const parseSignal = (signal: StreamSignal): Error | undefined => {
  if (is(signal, StreamDoneStruct)) {
    return undefined;
  }
  if (is(signal, StreamErrorStruct) && isMarshaledError(signal.error)) {
    return unmarshalError(signal.error);
  }
  throw new Error(`Invalid stream signal: ${stringify(signal)}`);
};

/**
 * A value that can be dispatched to the internal transport mechanism of a stream.
 *
 * @template Yield - The type of the values yielded by the stream.
 */
export type Dispatchable<Yield> = Yield | StreamSignal;

/**
 * Creates a {@link IteratorResult} with `{ done: true, value: undefined }`.
 *
 * @template Yield - The type of the values yielded by the iterator.
 * @returns A {@link IteratorResult} with `{ done: true, value: undefined }`.
 */
export const makeDoneResult = <Yield>(): IteratorResult<Yield, undefined> =>
  harden({
    done: true,
    value: undefined,
  });

/**
 * Creates a {@link IteratorResult} with `{ done: false, value }`.
 *
 * @template Yield - The type of the values yielded by the iterator.
 * @param value - The value of the iterator result.
 * @returns A {@link IteratorResult} with `{ done: false, value }`.
 */
export const makePendingResult = <Yield>(
  value: Yield,
): IteratorResult<Yield, undefined> =>
  harden({
    done: false,
    value,
  });
