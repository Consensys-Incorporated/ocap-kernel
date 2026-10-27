import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getQueueMethods } from './queue.ts';
import type { RunQueueItem } from '../../types.ts';
import type { StoreContext } from '../types.ts';

describe('queue store methods', () => {
  let mockKV: Map<string, string>;
  let mockRunQueue = {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
  };
  let context: StoreContext;
  let queueMethods: ReturnType<typeof getQueueMethods>;

  beforeEach(() => {
    mockKV = new Map();
    mockRunQueue = {
      enqueue: vi.fn(),
      dequeue: vi.fn(),
    };

    context = {
      kv: {
        get: (key: string): string | undefined => mockKV.get(key),
        getRequired: (key: string): string => {
          const value = mockKV.get(key);
          if (value === undefined) {
            throw new Error(`Required key ${key} not found`);
          }
          return value;
        },
        set: (key: string, value: string): void => {
          mockKV.set(key, value);
        },
        delete: (key: string): void => {
          mockKV.delete(key);
        },
      },
      runQueue: mockRunQueue,
      runQueueLengthCache: 0,
    } as unknown as StoreContext;

    queueMethods = getQueueMethods(context);
  });

  describe('getQueueLength', () => {
    it('calculates queue length from head and tail', () => {
      mockKV.set('queue.test.head', '10');
      mockKV.set('queue.test.tail', '3');

      const result = queueMethods.getQueueLength('test');

      expect(result).toBe(7);
    });

    it('returns zero for empty queue', () => {
      mockKV.set('queue.test.head', '5');
      mockKV.set('queue.test.tail', '5');

      const result = queueMethods.getQueueLength('test');

      expect(result).toBe(0);
    });

    it('throws error if queue does not exist', () => {
      expect(() => queueMethods.getQueueLength('nonexistent')).toThrow(
        'unknown queue nonexistent',
      );
    });

    it('throws error if only head exists', () => {
      mockKV.set('queue.test.head', '5');

      expect(() => queueMethods.getQueueLength('test')).toThrow(
        'unknown queue test',
      );
    });

    it('throws error if only tail exists', () => {
      mockKV.set('queue.test.tail', '3');

      expect(() => queueMethods.getQueueLength('test')).toThrow(
        'unknown queue test',
      );
    });
  });

  describe('enqueueRun', () => {
    it('increments runQueueLengthCache and enqueues the message', () => {
      const message: RunQueueItem = {
        type: 'message',
        data: { some: 'data' },
      } as unknown as RunQueueItem;

      queueMethods.enqueueRun(message);

      expect(context.runQueueLengthCache).toBe(1);
      expect(mockRunQueue.enqueue).toHaveBeenCalledWith(message);
    });

    it('counts no message whose write failed', () => {
      const fault = new Error('SQLITE_FULL');
      mockRunQueue.enqueue.mockImplementationOnce(() => {
        throw fault;
      });

      expect(() => queueMethods.enqueueRun({} as RunQueueItem)).toThrow(fault);
      expect(context.runQueueLengthCache).toBe(0);
    });

    it('increments runQueueLengthCache multiple times correctly', () => {
      const message1: RunQueueItem = {
        type: 'message',
        data: { id: 1 },
      } as unknown as RunQueueItem;
      const message2: RunQueueItem = {
        type: 'message',
        data: { id: 2 },
      } as unknown as RunQueueItem;

      queueMethods.enqueueRun(message1);
      queueMethods.enqueueRun(message2);

      expect(context.runQueueLengthCache).toBe(2);
      expect(mockRunQueue.enqueue).toHaveBeenCalledTimes(2);
      expect(mockRunQueue.enqueue).toHaveBeenNthCalledWith(1, message1);
      expect(mockRunQueue.enqueue).toHaveBeenNthCalledWith(2, message2);
    });

    it('resolves an invalidated cache from the database before incrementing', () => {
      // A negative cache means "length unknown, re-read from the DB".
      // Incrementing it blindly would yield 0 for a queue that already
      // holds an item, and since 0 is not negative the stale value would
      // never be re-read — stranding queued items and losing the run
      // loop's wakeup.
      const message: RunQueueItem = {
        type: 'message',
        data: { some: 'data' },
      } as unknown as RunQueueItem;
      context.runQueueLengthCache = -1;
      mockKV.set('queue.run.head', '38');
      mockKV.set('queue.run.tail', '37');

      queueMethods.enqueueRun(message);

      expect(context.runQueueLengthCache).toBe(2);
      expect(queueMethods.runQueueLength()).toBe(2);
    });
  });

  describe('dequeueRun', () => {
    it('decrements runQueueLengthCache and returns the dequeued message', () => {
      const message: RunQueueItem = {
        type: 'message',
        data: { some: 'data' },
      } as unknown as RunQueueItem;
      mockRunQueue.dequeue.mockReturnValue(message);
      context.runQueueLengthCache = 1;

      const result = queueMethods.dequeueRun();

      expect(context.runQueueLengthCache).toBe(0);
      expect(mockRunQueue.dequeue).toHaveBeenCalled();
      expect(result).toStrictEqual(message);
    });

    it('decrements runQueueLengthCache and returns undefined when queue is empty', () => {
      mockRunQueue.dequeue.mockReturnValue(undefined);
      context.runQueueLengthCache = 1;

      const result = queueMethods.dequeueRun();

      expect(context.runQueueLengthCache).toBe(0);
      expect(mockRunQueue.dequeue).toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('works correctly when called multiple times', () => {
      const message1: RunQueueItem = {
        type: 'message',
        data: { id: 1 },
      } as unknown as RunQueueItem;
      const message2: RunQueueItem = {
        type: 'message',
        data: { id: 2 },
      } as unknown as RunQueueItem;

      mockRunQueue.dequeue
        .mockReturnValueOnce(message1)
        .mockReturnValueOnce(message2)
        .mockReturnValueOnce(undefined);

      context.runQueueLengthCache = 3;

      expect(queueMethods.dequeueRun()).toStrictEqual(message1);
      expect(context.runQueueLengthCache).toBe(2);

      expect(queueMethods.dequeueRun()).toStrictEqual(message2);
      expect(context.runQueueLengthCache).toBe(1);

      expect(queueMethods.dequeueRun()).toBeUndefined();
      expect(context.runQueueLengthCache).toBe(0);
    });

    it('resolves an invalidated cache from the database before decrementing', () => {
      const message: RunQueueItem = {
        type: 'message',
        data: { some: 'data' },
      } as unknown as RunQueueItem;
      mockRunQueue.dequeue.mockReturnValue(message);
      context.runQueueLengthCache = -1;
      mockKV.set('queue.run.head', '39');
      mockKV.set('queue.run.tail', '37');

      expect(queueMethods.dequeueRun()).toStrictEqual(message);

      expect(context.runQueueLengthCache).toBe(1);
    });
  });

  describe('runQueueLength', () => {
    it('returns the cached run queue length when cache is valid', () => {
      context.runQueueLengthCache = 5;

      const result = queueMethods.runQueueLength();

      expect(result).toBe(5);
    });

    it('recalculates queue length when cache is negative', () => {
      context.runQueueLengthCache = -1;
      mockKV.set('queue.run.head', '8');
      mockKV.set('queue.run.tail', '3');

      const result = queueMethods.runQueueLength();

      expect(result).toBe(5);
      expect(context.runQueueLengthCache).toBe(5);
    });

    it('keeps the recalculated value in cache for subsequent calls', () => {
      context.runQueueLengthCache = -1;
      mockKV.set('queue.run.head', '8');
      mockKV.set('queue.run.tail', '3');

      queueMethods.runQueueLength(); // First call recalculates
      const result = queueMethods.runQueueLength(); // Second call should use cache

      expect(result).toBe(5);
      expect(context.runQueueLengthCache).toBe(5);
    });

    it('throws error when recalculating if run queue does not exist', () => {
      context.runQueueLengthCache = -1;

      expect(() => queueMethods.runQueueLength()).toThrow('unknown queue run');
    });
  });
});
