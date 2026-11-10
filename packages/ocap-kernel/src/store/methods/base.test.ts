import type { KVStore } from '@metamask/kernel-store';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getBaseMethods } from './base.ts';
import { asKRef, asRemoteId, asVatId } from '../../../test/branded.ts';
import { makeMapKVStore } from '../../../test/storage.ts';
import type { KRef } from '../../types.ts';

describe('base-methods', () => {
  let kv: KVStore;
  let baseStore: ReturnType<typeof getBaseMethods>;

  beforeEach(() => {
    kv = makeMapKVStore();
    baseStore = getBaseMethods(kv);
  });

  describe('getSlotKey', () => {
    it('generates correct slot keys', () => {
      expect(baseStore.getSlotKey(asVatId('v1'), asKRef('ko123'))).toBe(
        'v1.c.ko123',
      );
      expect(baseStore.getSlotKey(asRemoteId('r2'), asKRef('kp456'))).toBe(
        'r2.c.kp456',
      );
    });
  });

  describe('refCountKey', () => {
    it('generates correct reference count keys', () => {
      expect(baseStore.refCountKey(asKRef('ko1'))).toBe('ko1.refCount');
      expect(baseStore.refCountKey(asKRef('kp42'))).toBe('kp42.refCount');
      expect(baseStore.refCountKey('v7' as KRef)).toBe('v7.refCount');
    });
  });

  describe('getOwnerKey', () => {
    it('generates correct owner keys', () => {
      expect(baseStore.getOwnerKey(asKRef('ko1'))).toBe('ko1.owner');
      expect(baseStore.getOwnerKey(asKRef('kp42'))).toBe('kp42.owner');
      expect(baseStore.getOwnerKey('v7' as KRef)).toBe('v7.owner');
    });
  });

  describe('getRevokedKey', () => {
    it('generates correct revoked keys', () => {
      expect(baseStore.getRevokedKey(asKRef('ko1'))).toBe('ko1.revoked');
      expect(baseStore.getRevokedKey(asKRef('kp42'))).toBe('kp42.revoked');
      expect(baseStore.getRevokedKey('v7' as KRef)).toBe('v7.revoked');
    });
  });

  describe('incCounter', () => {
    it('increments a stored counter value', () => {
      // Create a stored value to increment
      const storedValue = baseStore.provideCachedStoredValue(
        'test-counter',
        '5',
      );

      // Increment and check return value
      expect(baseStore.incCounter(storedValue)).toBe('5');
      expect(storedValue.get()).toBe('6');

      // Increment again
      expect(baseStore.incCounter(storedValue)).toBe('6');
      expect(storedValue.get()).toBe('7');
    });
  });

  describe('provideCachedStoredValue', () => {
    it('creates a new value if it does not exist', () => {
      const value = baseStore.provideCachedStoredValue('new-key', 'initial');
      expect(value.get()).toBe('initial');
      expect(kv.get('new-key')).toBe('initial');
    });

    it('retrieves an existing value', () => {
      kv.set('existing-key', 'existing-value');
      const value = baseStore.provideCachedStoredValue('existing-key');
      expect(value.get()).toBe('existing-value');
    });

    it('caches values in memory', () => {
      const value = baseStore.provideCachedStoredValue('cached-key', 'initial');

      // Change the value through the stored value object
      value.set('updated');
      expect(value.get()).toBe('updated');
      expect(kv.get('cached-key')).toBe('updated');

      // Change the value directly in the KV store
      kv.set('cached-key', 'changed-externally');

      // The cached value should still return the cached value, not the updated KV store value
      // This is because the value is cached in memory
      expect(value.get()).toBe('updated');

      // But a new stored value object should see the updated KV store value
      const newValue = baseStore.provideCachedStoredValue('cached-key');
      expect(newValue.get()).toBe('changed-externally');
    });

    it('keeps its cached value when writing a new one fails', () => {
      const value = baseStore.provideCachedStoredValue('failing-key', 'kept');
      const fault = new Error('SQLITE_FULL');
      vi.spyOn(kv, 'set').mockImplementationOnce(() => {
        throw fault;
      });

      expect(() => value.set('lost')).toThrow(fault);
      expect(value.get()).toBe('kept');
    });

    it('keeps its cached value when deleting it fails', () => {
      const value = baseStore.provideCachedStoredValue('failing-key', 'kept');
      const fault = new Error('SQLITE_FULL');
      vi.spyOn(kv, 'delete').mockImplementationOnce(() => {
        throw fault;
      });

      expect(() => value.delete()).toThrow(fault);
      expect(value.get()).toBe('kept');
    });

    it('deletes values correctly', () => {
      const value = baseStore.provideCachedStoredValue(
        'delete-key',
        'to-delete',
      );
      expect(value.get()).toBe('to-delete');

      value.delete();
      expect(value.get()).toBeUndefined();
      expect(kv.get('delete-key')).toBeUndefined();
    });
  });

  describe('provideRawStoredValue', () => {
    it('creates a new value if it does not exist', () => {
      const value = baseStore.provideRawStoredValue('new-raw-key', 'initial');
      expect(value.get()).toBe('initial');
      expect(kv.get('new-raw-key')).toBe('initial');
    });

    it('retrieves an existing value', () => {
      kv.set('existing-raw-key', 'existing-value');
      const value = baseStore.provideRawStoredValue('existing-raw-key');
      expect(value.get()).toBe('existing-value');
    });

    it('does not cache values in memory', () => {
      const value = baseStore.provideRawStoredValue('raw-key', 'initial');

      // Change the value through the stored value object
      value.set('updated');
      expect(value.get()).toBe('updated');
      expect(kv.get('raw-key')).toBe('updated');

      // Change the value directly in the KV store
      kv.set('raw-key', 'changed-externally');

      // The raw value should always read from the KV store
      expect(value.get()).toBe('changed-externally');
    });

    it('deletes values correctly', () => {
      const value = baseStore.provideRawStoredValue(
        'delete-raw-key',
        'to-delete',
      );
      expect(value.get()).toBe('to-delete');

      value.delete();
      expect(value.get()).toBeUndefined();
      expect(kv.get('delete-raw-key')).toBeUndefined();
    });
  });

  describe('integration', () => {
    it('works with multiple stored values', () => {
      const counter1 = baseStore.provideCachedStoredValue('counter1', '1');
      const counter2 = baseStore.provideCachedStoredValue('counter2', '10');

      expect(baseStore.incCounter(counter1)).toBe('1');
      expect(baseStore.incCounter(counter2)).toBe('10');

      expect(counter1.get()).toBe('2');
      expect(counter2.get()).toBe('11');
    });

    it('supports both cached and raw stored values', () => {
      const cachedValue = baseStore.provideCachedStoredValue(
        'cached',
        'cached-value',
      );
      const rawValue = baseStore.provideRawStoredValue('raw', 'raw-value');

      expect(cachedValue.get()).toBe('cached-value');
      expect(rawValue.get()).toBe('raw-value');

      // Modify directly in KV store
      kv.set('cached', 'modified-cached');
      kv.set('raw', 'modified-raw');

      // Cached value should still return the cached value
      expect(cachedValue.get()).toBe('cached-value');
      // Raw value should return the updated value
      expect(rawValue.get()).toBe('modified-raw');
    });
  });

  describe('provideStoredQueue', () => {
    it('creates a queue with cache when cached=true', () => {
      const cachedQueue = baseStore.provideStoredQueue('cached-queue', true);
      cachedQueue.enqueue({ id: 1 });
      expect(kv.get('queue.cached-queue.head')).toBe('2');
      cachedQueue.delete();
      expect(kv.get('queue.cached-queue.head')).toBeUndefined();
    });

    it('creates a queue without cache when cached=false', () => {
      const rawQueue = baseStore.provideStoredQueue('raw-queue', false);
      rawQueue.enqueue({ id: 1 });
      expect(kv.get('queue.raw-queue.head')).toBe('2');
      rawQueue.delete();
      expect(kv.get('queue.raw-queue.head')).toBeUndefined();
    });

    it('throws if queue is not initialized properly', () => {
      kv.set('queue.broken-queue.head', '1');
      const originalSet = kv.set;
      vi.spyOn(kv, 'set').mockImplementation((key, value) => {
        if (key !== 'queue.broken-queue.tail') {
          return originalSet.call(kv, key, value);
        }
        return undefined;
      });
      expect(() => baseStore.provideStoredQueue('broken-queue')).toThrow(
        'queue broken-queue not initialized',
      );
    });

    it('returns undefined when dequeueing from a deleted queue', () => {
      const queue = baseStore.provideStoredQueue('test-dequeue-deleted');
      queue.enqueue({ id: 'test' });
      kv.delete('queue.test-dequeue-deleted.head');
      expect(queue.dequeue()).toBeUndefined();
    });

    it('throws when enqueueing into a deleted queue', () => {
      // Create a queue properly
      const queue = baseStore.provideStoredQueue('test', false);

      // Manually delete the head to simulate a deleted queue
      kv.delete('queue.test.head');

      // This should throw when trying to enqueue
      expect(() => queue.enqueue({ data: 'test' })).toThrow(
        'enqueue into deleted queue test',
      );
    });

    it.each([true, false])(
      'leaves no gap when an entry fails to be written (cached: %s)',
      (cached) => {
        const queue = baseStore.provideStoredQueue('test', cached);
        queue.enqueue({ id: 1 });
        const fault = new Error('SQLITE_FULL');
        const originalSet = kv.set;
        const set = vi.spyOn(kv, 'set').mockImplementation((key, value) => {
          if (key === 'queue.test.2') {
            throw fault;
          }
          originalSet.call(kv, key, value);
        });
        expect(() => queue.enqueue({ id: 2 })).toThrow(fault);
        set.mockRestore();
        queue.enqueue({ id: 3 });

        const reopened = baseStore.provideStoredQueue('test', cached);
        expect([
          reopened.dequeue(),
          reopened.dequeue(),
          reopened.dequeue(),
        ]).toStrictEqual([{ id: 1 }, { id: 3 }, undefined]);
      },
    );

    it.each([true, false])(
      'keeps an entry when moving the tail past it fails (cached: %s)',
      (cached) => {
        const queue = baseStore.provideStoredQueue('test', cached);
        queue.enqueue({ id: 1 });
        const fault = new Error('SQLITE_FULL');
        vi.spyOn(kv, 'set').mockImplementationOnce(() => {
          throw fault;
        });

        expect(() => queue.dequeue()).toThrow(fault);
        expect(queue.dequeue()).toStrictEqual({ id: 1 });
      },
    );

    it('returns undefined when dequeueing from an empty queue', () => {
      // Create a queue with matching head and tail (empty)
      kv.set('queue.test.head', '1');
      kv.set('queue.test.tail', '1');
      const queue = baseStore.provideStoredQueue('test', false);

      // Should return undefined for an empty queue
      expect(queue.dequeue()).toBeUndefined();
    });

    it('deletes all queue items and metadata', () => {
      const queue = baseStore.provideStoredQueue('test');

      // Add some items
      queue.enqueue({ id: 1 });
      queue.enqueue({ id: 2 });

      // Delete the queue
      queue.delete();

      // Verify head and tail are gone
      expect(kv.get('queue.test.head')).toBeUndefined();
      expect(kv.get('queue.test.tail')).toBeUndefined();

      // Verify items are gone
      expect(kv.get('queue.test.1')).toBeUndefined();
      expect(kv.get('queue.test.2')).toBeUndefined();
    });

    it('does nothing when deleting an already deleted queue', () => {
      const queue = baseStore.provideStoredQueue('test');

      // Delete the queue through KV directly
      kv.delete('queue.test.head');

      // Should not throw when calling delete
      expect(() => queue.delete()).not.toThrow();
    });
  });

  describe('getPrefixedKeys', () => {
    beforeEach(() => {
      // Add a minimal set of test keys
      kv.set('test.a', 'value1');
      kv.set('test.b', 'value2');
      kv.set('other', 'value3');
    });

    it('yields keys with the given prefix', () => {
      // Mock the getNextKey function for predictable testing
      const originalGetNextKey = kv.getNextKey;
      const mockKeys = ['test.a', 'test.b', 'other'];
      let keyIndex = 0;

      vi.spyOn(kv, 'getNextKey').mockImplementation(() => {
        if (keyIndex < mockKeys.length) {
          // oxlint-disable-next-line no-plusplus
          return mockKeys[keyIndex++];
        }
        return undefined;
      });

      const keys = Array.from(baseStore.getPrefixedKeys('test.'));

      // Restore original function
      kv.getNextKey = originalGetNextKey;

      // Verify results
      expect(keys).toStrictEqual(['test.a', 'test.b']);
      expect(keys).not.toContain('other');
    });

    it('stops iteration when key does not match prefix', () => {
      // Create a custom mock implementation
      const originalGetNextKey = kv.getNextKey;

      // This mocks a sequence of keys where we first get matching keys,
      // then a non-matching key
      vi.spyOn(kv, 'getNextKey')
        .mockReturnValueOnce('test.a')
        .mockReturnValueOnce('test.b')
        .mockReturnValueOnce('other'); // This should stop the iteration

      const keys = Array.from(baseStore.getPrefixedKeys('test.'));

      // Restore original function
      kv.getNextKey = originalGetNextKey;

      // Should only contain keys before the non-matching key
      expect(keys).toStrictEqual(['test.a', 'test.b']);
      expect(keys).toHaveLength(2);
    });

    it('handles case when no keys are found', () => {
      // Mock getNextKey to return undefined (no keys)
      const originalGetNextKey = kv.getNextKey;
      vi.spyOn(kv, 'getNextKey').mockReturnValue(undefined);

      const keys = Array.from(baseStore.getPrefixedKeys('nonexistent.'));

      // Restore original function
      kv.getNextKey = originalGetNextKey;

      expect(keys).toHaveLength(0);
    });
  });
});
