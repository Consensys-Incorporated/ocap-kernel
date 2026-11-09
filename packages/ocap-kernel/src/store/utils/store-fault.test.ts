import type { KVStore, VatStore } from '@metamask/kernel-store';
import { describe, it, expect, vi } from 'vitest';

import {
  isStoreFault,
  markStoreFaults,
  markVatStoreFaults,
} from './store-fault.ts';

/**
 * A KV store over a map.
 *
 * @returns The store.
 */
function makeKV(): KVStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) as never,
    getRequired: (key) => map.get(key) as never,
    getNextKey: () => undefined,
    set: (key, value) => {
      map.set(key, value);
    },
    delete: (key) => {
      map.delete(key);
    },
  };
}

describe('markStoreFaults', () => {
  it.each(['get', 'getRequired', 'getNextKey', 'set', 'delete'] as const)(
    'marks what %s throws',
    (method) => {
      const kv = makeKV();
      const fault = new Error('disk I/O error');
      const throwFault = (): never => {
        throw fault;
      };
      vi.spyOn(kv, method).mockImplementation(throwFault);
      vi.spyOn(kv, 'get').mockImplementation(throwFault);

      const call = markStoreFaults(kv)[method] as (
        ...args: string[]
      ) => unknown;

      expect(() => call('key', 'value')).toThrow(fault);
      expect(isStoreFault(fault)).toBe(true);
    },
  );

  it('passes calls through', () => {
    const marked = markStoreFaults(makeKV());

    marked.set('key', 'value');

    expect(marked.getRequired('key')).toBe('value');
  });

  it('does not mark a missing key', () => {
    let missing: unknown;
    try {
      markStoreFaults(makeKV()).getRequired('key');
    } catch (error) {
      missing = error;
    }

    expect(missing).toStrictEqual(Error("no record matching key 'key'"));
    expect(isStoreFault(missing)).toBe(false);
  });
});

describe('markVatStoreFaults', () => {
  it.each(['getKVData', 'updateKVData'] as const)(
    'marks what %s throws',
    (method) => {
      const vatStore: VatStore = {
        getKVData: () => [],
        updateKVData: () => undefined,
      };
      const fault = new Error('disk I/O error');
      vi.spyOn(vatStore, method).mockImplementation(() => {
        throw fault;
      });

      const call = markVatStoreFaults(vatStore)[method] as (
        ...args: unknown[]
      ) => unknown;

      expect(() => call([], [])).toThrow(fault);
      expect(isStoreFault(fault)).toBe(true);
    },
  );
});

describe('isStoreFault', () => {
  it('finds a store fault among the causes', () => {
    const kv = makeKV();
    const fault = new Error('database or disk is full');
    vi.spyOn(kv, 'set').mockImplementation(() => {
      throw fault;
    });
    expect(() => markStoreFaults(kv).set('key', 'value')).toThrow(fault);

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
