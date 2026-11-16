import { describe, it, expect, vi } from 'vitest';

import { isStoreFault, markStoreFaults } from './store-fault.ts';
import { makeMapKVStore, makeStoreFault } from '../../../test/storage.ts';

describe('markStoreFaults', () => {
  it.each(['get', 'getRequired', 'getNextKey', 'set', 'delete'] as const)(
    'marks what %s throws',
    (method) => {
      const kv = makeMapKVStore();
      const fault = new Error('disk I/O error');
      const throwFault = (): never => {
        throw fault;
      };
      vi.spyOn(kv, method).mockImplementation(throwFault);
      // The wrapper's `getRequired` goes by way of `get`.
      vi.spyOn(kv, 'get').mockImplementation(throwFault);

      const call = markStoreFaults(kv)[method] as (
        ...args: string[]
      ) => unknown;

      expect(() => call('key', 'value')).toThrow(fault);
      expect(isStoreFault(fault)).toBe(true);
    },
  );

  it.each([
    ['a missing key', 'other'],
    ['an empty value', 'empty'],
  ])('passes calls through, and does not mark %s', (_, key) => {
    const marked = markStoreFaults(makeMapKVStore());
    marked.set('key', 'value');
    marked.set('empty', '');
    let refused: unknown;
    try {
      marked.getRequired(key);
    } catch (error) {
      refused = error;
    }

    expect({
      found: marked.getRequired('key'),
      refused,
      marked: isStoreFault(refused),
    }).toStrictEqual({
      found: 'value',
      refused: Error(`no record matching key '${key}'`),
      marked: false,
    });
  });
});

describe('isStoreFault', () => {
  it('finds a store fault among the causes', () => {
    const fault = makeStoreFault();

    expect(isStoreFault(new Error('wrapped', { cause: fault }))).toBe(true);
  });

  it.each([
    ['an error the store did not throw', new Error('unknown method')],
    ['a value that is not an object', 'disk I/O error'],
    ['undefined', undefined],
  ])('is false for %s', (_, error) => {
    expect(isStoreFault(error)).toBe(false);
  });

  it('stops at a cause that loops back', () => {
    const error = new Error('first');
    const second = new Error('second', { cause: error });
    Object.defineProperty(error, 'cause', { value: second });

    expect(isStoreFault(error)).toBe(false);
  });
});
