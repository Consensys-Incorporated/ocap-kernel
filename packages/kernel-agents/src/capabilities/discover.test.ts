import { S } from '@metamask/kernel-utils';
import { describe, expect, it } from 'vitest';

import { makeInternalCapabilities } from './discover.ts';

/**
 * Whether a promise rejects. Used instead of `.rejects.toThrow()` because the
 * interface guard rejects with an opaque (non-`Error`) value under the test
 * shim; here we only care that the membrane blocked the call.
 *
 * @param promise - The promise to observe.
 * @returns `true` if the promise rejects, `false` if it resolves.
 */
const rejects = async (promise: Promise<unknown>): Promise<boolean> => {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
};

// Build the capabilities once, mirroring how the built-in capability modules
// construct their exo at import.
const capabilities = makeInternalCapabilities(
  'Test',
  {
    async count(word: string) {
      return word.length;
    },
    async add(summands: number[]) {
      return summands.reduce((acc, summand) => acc + summand, 0);
    },
  },
  S.interface('Test', {
    count: S.method(
      'Count characters.',
      [S.arg('word', S.string('The string to measure.'))],
      S.number('The number of characters.'),
    ),
    add: S.method(
      'Add numbers.',
      [S.arg('summands', S.arrayOf(S.number()))],
      S.number('The sum.'),
    ),
  }),
);

describe('makeInternalCapabilities', () => {
  it('projects a capability record keyed by the schema method names', () => {
    expect(Object.keys(capabilities)).toStrictEqual(['count', 'add']);
    expect(capabilities.count.schema.description).toBe('Count characters.');
  });

  it('maps the named-args object to positional args and invokes the method', async () => {
    expect(await capabilities.count.func({ word: 'abcdefg' } as never)).toBe(7);
    expect(
      await capabilities.add.func({ summands: [1, 2, 3, 4] } as never),
    ).toBe(10);
  });

  it('rejects a mistyped argument at the exo membrane', async () => {
    // `count` expects a string; the interface guard rejects a number before the
    // implementation runs.
    expect(
      await rejects(capabilities.count.func({ word: 12345 } as never)),
    ).toBe(true);
  });

  it('rejects a missing required argument at the exo membrane', async () => {
    expect(await rejects(capabilities.add.func({} as never))).toBe(true);
  });

  it('normalizes the rejection into a real error naming the expected signature', async () => {
    // Whatever the guard rejects with (an opaque value under the test shim), the
    // membrane rethrows a real `Error` carrying the method signature so callers
    // can surface an actionable message to the model.
    let caught: unknown;
    try {
      await capabilities.count.func({ word: 12345 } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(
      (caught as Error).message.startsWith(
        'Error calling count(word: string): ',
      ),
    ).toBe(true);
  });

  it('throws at construction when an implementation has no matching schema', () => {
    expect(() =>
      makeInternalCapabilities(
        'Skewed',
        {
          // Typo: the schema declares `search`, not `serch`.
          async serch(query: string) {
            return query;
          },
        },
        S.interface('Skewed', {
          search: S.method('Search.', [S.arg('query', S.string())], S.string()),
        }),
      ),
    ).toThrow(/implementation and schema method names must match/u);
  });
});
