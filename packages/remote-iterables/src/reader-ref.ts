import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

export const AsyncIteratorInterface = M.interface(
  'AsyncIterator',
  {},
  {
    defaultGuards: 'passable',
  },
);

export type SomehowAsyncIterable<Item> =
  | AsyncIterable<Item>
  | Iterable<Item>
  | { next: () => IteratorResult<Item> };

/**
 * Returns the iterator for the given iterable object.
 * Supports both synchronous and asynchronous iterables.
 *
 * @param iterable - The iterable object.
 * @returns The iterator for the given iterable object.
 */
export const asyncIterate = <Item>(
  iterable: SomehowAsyncIterable<Item>,
): AsyncIterator<Item> => {
  let iterator;
  if (iterable[Symbol.asyncIterator as keyof typeof iterable]) {
    iterator = (iterable as AsyncIterable<Item>)[Symbol.asyncIterator]();
  } else if (iterable[Symbol.iterator as keyof typeof iterable]) {
    iterator = (iterable as Iterable<Item>)[Symbol.iterator]();
  } else if ('next' in iterable) {
    iterator = iterable;
  } else {
    throw new Error('Not iterable');
  }
  return iterator as AsyncIterator<Item>;
};

/**
 * Make a remotable AsyncIterator.
 *
 * @param iterable - The iterable object.
 * @returns An exo for the iterator.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export const makeIteratorRef = <Item>(iterable: SomehowAsyncIterable<Item>) => {
  const iterator = asyncIterate(iterable);
  return makeExo('AsyncIterator', AsyncIteratorInterface, {
    /**
     * Gets the next value from the iterator.
     *
     * @returns A promise that resolves to the next iterator result.
     */
    async next() {
      return iterator.next(undefined);
    },
    /**
     * Finish the iterator without error.
     *
     * @param value - The value to return.
     * @returns The result of the return operation.
     */
    async return(value: Item): Promise<IteratorResult<Item>> {
      if (iterator.return !== undefined) {
        return iterator.return(value);
      }
      return harden({ done: true, value: undefined });
    },
    /**
     * Finish the iterator with an error.
     *
     * @param error - The error to throw.
     * @returns The result of the throw operation.
     */
    async throw(error: unknown) {
      if (iterator.throw !== undefined) {
        return iterator.throw(error);
      }
      return harden({ done: true, value: undefined });
    },
    /**
     * Returns the async iterator for use with for-await-of loops.
     *
     * @returns The iterator itself.
     */
    [Symbol.asyncIterator]() {
      return this;
    },
  });
};
