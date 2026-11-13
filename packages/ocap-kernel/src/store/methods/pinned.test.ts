import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getPinMethods } from './pinned.ts';
import { getRefCountMethods } from './refcount.ts';
import { asKRef } from '../../../test/branded.ts';

// Mock the dependencies
vi.mock('./refcount.ts', () => ({
  getRefCountMethods: vi.fn(),
}));

type MockKv = {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  delete: (key: string) => void;
  getNextKey: (key: string) => string | undefined;
};

/**
 * Make a key/value store over a map, enough of one for the pin methods: reads,
 * writes, deletes, and the ordered key traversal `getPinnedObjects` iterates.
 *
 * @param entries - The entries the store starts out holding.
 * @returns The store.
 */
function makeMockKv(entries: Record<string, string> = {}): MockKv {
  const map = new Map(Object.entries(entries));
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
    delete: (key) => {
      map.delete(key);
    },
    getNextKey: (key) =>
      [...map.keys()].sort().find((candidate) => candidate > key),
  };
}

describe('getPinMethods', () => {
  const mockIncrementRefCount = vi.fn();
  const mockDecrementRefCount = vi.fn();
  let mockKv: MockKv;
  let methods: ReturnType<typeof getPinMethods>;

  beforeEach(() => {
    vi.resetAllMocks();
    (getRefCountMethods as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      {
        incrementRefCount: mockIncrementRefCount,
        decrementRefCount: mockDecrementRefCount,
      },
    );
    mockKv = makeMockKv({
      'pinned.ko1': '1',
      'pinned.ko2': '1',
      'pinned.ko3': '1',
    });
    // @ts-expect-error - We don't need to provide a full StoreContext for testing
    methods = getPinMethods({ kv: mockKv });
  });

  describe('pinObject', () => {
    it('records a pin on the object and takes a reference', () => {
      methods.pinObject(asKRef('ko4'));
      expect(mockIncrementRefCount).toHaveBeenCalledWith('ko4', 'pin');
      expect(mockKv.get('pinned.ko4')).toBe('1');
    });

    it('pins and increments again for an object already pinned', () => {
      methods.pinObject(asKRef('ko2'));
      expect(mockIncrementRefCount).toHaveBeenCalledWith('ko2', 'pin');
      expect(methods.getPinCount(asKRef('ko2'))).toBe(2);
      expect(methods.getPinnedObjects()).toStrictEqual(['ko1', 'ko2', 'ko3']);
    });

    it('records no pin if taking the reference is refused', () => {
      mockIncrementRefCount.mockImplementation(() => {
        throw Error('deleted kref');
      });
      expect(() => methods.pinObject(asKRef('ko4'))).toThrow('deleted kref');
      expect(methods.getPinCount(asKRef('ko4'))).toBe(0);
    });
  });

  describe('unpinObject', () => {
    it('drops the object from the pinned objects and releases its reference', () => {
      methods.unpinObject(asKRef('ko2'));
      expect(mockDecrementRefCount).toHaveBeenCalledWith('ko2', 'unpin');
      expect(methods.getPinnedObjects()).toStrictEqual(['ko1', 'ko3']);
    });

    it('spends one pin of several, leaving the object pinned', () => {
      methods.pinObject(asKRef('ko2'));

      methods.unpinObject(asKRef('ko2'));

      expect(mockDecrementRefCount).toHaveBeenCalledWith('ko2', 'unpin');
      expect(methods.getPinCount(asKRef('ko2'))).toBe(1);
      expect(methods.isObjectPinned(asKRef('ko2'))).toBe(true);
    });

    it('does not release a reference for an object that is not pinned', () => {
      methods.unpinObject(asKRef('ko4'));
      expect(mockDecrementRefCount).not.toHaveBeenCalled();
      expect(methods.getPinCount(asKRef('ko4'))).toBe(0);
    });
  });

  describe('getPinnedObjects', () => {
    it('returns all pinned objects', () => {
      expect(methods.getPinnedObjects()).toStrictEqual(['ko1', 'ko2', 'ko3']);
    });

    it('returns an empty array if no objects are pinned', () => {
      // @ts-expect-error - We don't need to provide a full StoreContext for testing
      methods = getPinMethods({ kv: makeMockKv() });
      expect(methods.getPinnedObjects()).toStrictEqual([]);
    });

    it('names an object once however many pins it holds', () => {
      methods.pinObject(asKRef('ko2'));
      methods.pinObject(asKRef('ko2'));

      expect(methods.getPinnedObjects()).toStrictEqual(['ko1', 'ko2', 'ko3']);
      expect(methods.getPinCount(asKRef('ko2'))).toBe(3);
    });
  });

  describe('isObjectPinned', () => {
    it('returns true if the object is pinned', () => {
      expect(methods.isObjectPinned(asKRef('ko2'))).toBe(true);
    });

    it('returns false if the object is not pinned', () => {
      expect(methods.isObjectPinned(asKRef('ko4'))).toBe(false);
    });
  });
});
