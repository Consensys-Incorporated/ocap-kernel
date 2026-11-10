import { E } from '@endo/eventual-send';
import { makePipe } from '@endo/stream';
import type { Writer, Reader } from '@endo/stream';

// This type is used in the docs.
// oxlint-disable-next-line typescript/no-unused-vars
import type { makeEventualIterator } from './eventual-iterator.ts';
import { makeIteratorRef } from './reader-ref.ts';

/**
 * Make a remotable generator. Intended to be used in conjunction with
 * {@link makeEventualIterator}. This is the producing end of the pair.
 *
 * @param generator - The generator to make remotable.
 * @returns A remotable reference to the generator.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export const makeExoGenerator = <Item>(generator: AsyncGenerator<Item>) => {
  const [writer, reader] = makePipe<Item>() as unknown as [
    Writer<Item>,
    Reader<Item>,
  ];
  (async () => {
    for await (const value of generator) {
      await E(writer).next(value);
    }
    await E(writer).return(undefined);
  })().catch(async (error) => await E(writer).throw(error));
  return makeIteratorRef<Item>(reader);
};
