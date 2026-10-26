import type { CapData } from '@endo/marshal';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getBaseMethods } from './base.ts';
import { getPromiseMethods } from './promise.ts';
import { getQueueMethods } from './queue.ts';
import { getRefCountMethods } from './refcount.ts';
import { asKRef, asVatId } from '../../../test/branded.ts';
import type { KRef, KernelMessage, VatId } from '../../types.ts';
import type { StoreContext } from '../types.ts';
import * as promiseRefModule from '../utils/promise-ref.ts';

vi.mock('./base.ts', () => ({
  getBaseMethods: vi.fn(),
}));

vi.mock('./queue.ts', () => ({
  getQueueMethods: vi.fn(),
}));

vi.mock('./refcount.ts', () => ({
  getRefCountMethods: vi.fn(() => ({
    incrementRefCount: vi.fn(),
    decrementRefCount: vi.fn(),
  })),
}));

vi.mock('../utils/kernel-slots.ts', () => ({
  makeKernelSlot: vi.fn((type, id) =>
    type === 'promise' ? `kp${id}` : `ko${id}`,
  ),
}));

vi.mock('../utils/parse-ref.ts', () => ({
  parseRef: vi.fn((kref) => {
    if (kref.startsWith('kp')) {
      return { context: 'kernel', isPromise: true };
    }
    return { context: 'vat', isPromise: false };
  }),
}));

// Mock the isPromiseRef function
vi.mock('../utils/promise-ref.ts', () => ({
  isPromiseRef: vi.fn((kref) => kref.startsWith('kp')),
}));

describe('promise store methods', () => {
  let mockKV: Map<string, string>;
  let mockEnqueueRun = vi.fn();
  let mockIncCounter = vi.fn();
  let mockProvideStoredQueue = vi.fn();
  let mockGetPrefixedKeys = vi.fn();
  let mockRefCountKey = vi.fn((id) => `refcount.${id}`);
  let mockQueue = {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    delete: vi.fn(),
  };
  let context: StoreContext;
  let promiseMethods: ReturnType<typeof getPromiseMethods>;
  const mockIncrementRefCount = vi.fn();
  const mockDecrementRefCount = vi.fn();

  beforeEach(() => {
    mockKV = new Map();
    mockEnqueueRun = vi.fn();
    mockIncCounter = vi.fn();
    mockGetPrefixedKeys = vi.fn();
    mockRefCountKey = vi.fn((id) => `refcount.${id}`);
    mockQueue = {
      enqueue: vi.fn(),
      dequeue: vi.fn(),
      delete: vi.fn(),
    };
    mockProvideStoredQueue = vi.fn(() => mockQueue);

    (getBaseMethods as ReturnType<typeof vi.fn>).mockReturnValue({
      refCountKey: mockRefCountKey,
      incCounter: mockIncCounter,
      provideStoredQueue: mockProvideStoredQueue,
      getPrefixedKeys: mockGetPrefixedKeys,
      getCListPrefix: (endpointId: string) => `${endpointId}.c.`,
    });

    (getQueueMethods as ReturnType<typeof vi.fn>).mockReturnValue({
      enqueueRun: mockEnqueueRun,
    });

    (getRefCountMethods as ReturnType<typeof vi.fn>).mockReturnValue({
      incrementRefCount: mockIncrementRefCount,
      decrementRefCount: mockDecrementRefCount,
    });

    // Reset the isPromiseRef mock
    vi.mocked(promiseRefModule.isPromiseRef).mockImplementation(
      (kref) => typeof kref === 'string' && kref.startsWith('kp'),
    );

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
      nextPromiseId: 'nextPromiseId',
    } as unknown as StoreContext;

    promiseMethods = getPromiseMethods(context);
  });

  describe('initKernelPromise', () => {
    it('creates a new unresolved kernel promise with reference count 1', () => {
      mockIncCounter.mockReturnValue('42');

      const [kpid, kpr] = promiseMethods.initKernelPromise();

      expect(kpid).toBe('kp42');
      expect(kpr).toStrictEqual({
        state: 'unresolved',
        subscribers: [],
      });

      expect(mockIncCounter).toHaveBeenCalledWith('nextPromiseId');
      expect(mockProvideStoredQueue).toHaveBeenCalledWith('kp42', false);
      expect(mockKV.get('kp42.state')).toBe('unresolved');
      expect(mockKV.get('kp42.subscribers')).toBe('[]');
      expect(mockKV.get('refcount.kp42')).toBe('1');
    });
  });

  describe('getKernelPromise', () => {
    it('retrieves an unresolved promise without decider', () => {
      const kpid = asKRef('kp123');
      mockKV.set(`${kpid}.state`, 'unresolved');
      mockKV.set(`${kpid}.subscribers`, '["v1", "v2"]');

      const result = promiseMethods.getKernelPromise(kpid);

      expect(result).toStrictEqual({
        state: 'unresolved',
        subscribers: ['v1', 'v2'],
      });
    });

    it('retrieves an unresolved promise with decider', () => {
      const kpid = asKRef('kp123');
      mockKV.set(`${kpid}.state`, 'unresolved');
      mockKV.set(`${kpid}.decider`, 'v3');
      mockKV.set(`${kpid}.subscribers`, '["v1", "v2"]');

      const result = promiseMethods.getKernelPromise(kpid);

      expect(result).toStrictEqual({
        state: 'unresolved',
        decider: 'v3',
        subscribers: ['v1', 'v2'],
      });
    });

    it('retrieves a fulfilled promise', () => {
      const kpid = asKRef('kp123');
      mockKV.set(`${kpid}.state`, 'fulfilled');
      mockKV.set(`${kpid}.value`, '{"body":"someValue","slots":[]}');

      const result = promiseMethods.getKernelPromise(kpid);

      expect(result).toStrictEqual({
        state: 'fulfilled',
        value: { body: 'someValue', slots: [] },
      });
    });

    it('retrieves a rejected promise', () => {
      const kpid = asKRef('kp123');
      mockKV.set(`${kpid}.state`, 'rejected');
      mockKV.set(`${kpid}.value`, '{"body":"error","slots":[]}');

      const result = promiseMethods.getKernelPromise(kpid);

      expect(result).toStrictEqual({
        state: 'rejected',
        value: { body: 'error', slots: [] },
      });
    });

    it('throws for unknown promise', () => {
      const kpid = asKRef('kp999');

      expect(() => promiseMethods.getKernelPromise(kpid)).toThrow(
        `unknown kernel promise ${kpid}`,
      );
    });

    it('throws for unknown promise state', () => {
      const kpid = asKRef('kp123');
      mockKV.set(`${kpid}.state`, 'invalid-state');

      expect(() => promiseMethods.getKernelPromise(kpid)).toThrow(
        `unknown state for ${kpid}: invalid-state`,
      );
    });
  });

  describe('deleteKernelPromise', () => {
    it('removes all data associated with a kernel promise', () => {
      const kpid = asKRef('kp123');
      mockKV.set(`${kpid}.state`, 'unresolved');
      mockKV.set(`${kpid}.decider`, 'v1');
      mockKV.set(`${kpid}.subscribers`, '["v2", "v3"]');
      mockKV.set(`${kpid}.value`, '{"body":"someValue","slots":[]}');
      mockKV.set(`refcount.${kpid}`, '2');

      promiseMethods.deleteKernelPromise(kpid);

      expect(mockKV.has(`${kpid}.state`)).toBe(false);
      expect(mockKV.has(`${kpid}.decider`)).toBe(false);
      expect(mockKV.has(`${kpid}.subscribers`)).toBe(false);
      expect(mockKV.has(`${kpid}.value`)).toBe(false);
      expect(mockKV.has(`refcount.${kpid}`)).toBe(false);
      expect(mockProvideStoredQueue).toHaveBeenCalledWith(kpid);
      expect(mockQueue.delete).toHaveBeenCalled();
    });
  });

  describe('getNextPromiseId', () => {
    it('increments the counter and returns a new promise ID', () => {
      mockIncCounter.mockReturnValue('456');

      const result = promiseMethods.getNextPromiseId();

      expect(result).toBe('kp456');
      expect(mockIncCounter).toHaveBeenCalledWith('nextPromiseId');
    });
  });

  describe('addPromiseSubscriber', () => {
    it('adds a new subscriber to an unresolved promise', () => {
      const kpid = asKRef('kp123');
      const vatId = 'v2' as VatId;
      mockKV.set(`${kpid}.state`, 'unresolved');
      mockKV.set(`${kpid}.subscribers`, '["v1"]');

      promiseMethods.addPromiseSubscriber(vatId, kpid);

      expect(mockKV.get(`${kpid}.subscribers`)).toBe('["v1","v2"]');
    });

    it('does not add duplicate subscribers', () => {
      const kpid = asKRef('kp123');
      const vatId = 'v1' as VatId;
      mockKV.set(`${kpid}.state`, 'unresolved');
      mockKV.set(`${kpid}.subscribers`, '["v1"]');

      promiseMethods.addPromiseSubscriber(vatId, kpid);

      expect(mockKV.get(`${kpid}.subscribers`)).toBe('["v1"]');
    });

    it('throws if promise is already resolved', () => {
      const kpid = asKRef('kp123');
      const vatId = 'v2' as VatId;
      mockKV.set(`${kpid}.state`, 'fulfilled');
      mockKV.set(`${kpid}.value`, '{"body":"someValue","slots":[]}');

      expect(() => promiseMethods.addPromiseSubscriber(vatId, kpid)).toThrow(
        `attempt to add subscriber to resolved promise "${kpid}"`,
      );
    });
  });

  describe('setPromiseDecider', () => {
    it('sets the decider for a kernel promise', () => {
      const kpid = asKRef('kp123');
      const vatId = 'v1' as VatId;

      promiseMethods.setPromiseDecider(kpid, vatId);

      expect(mockKV.get(`${kpid}.decider`)).toBe(vatId);
    });

    it('does nothing when kpid is falsy', () => {
      const kpid = '' as KRef;
      const vatId = 'v1' as VatId;

      promiseMethods.setPromiseDecider(kpid, vatId);

      expect(mockKV.get(`${kpid}.decider`)).toBeUndefined();
    });
  });

  describe('resolveKernelPromise', () => {
    it('fulfills a promise and returns queued messages', () => {
      const kpid = asKRef('kp123');
      const value: CapData<KRef> = {
        body: 'someValue',
        slots: ['o+1' as KRef, 'o+2' as KRef],
      };
      const message1: KernelMessage = {
        methargs: { body: 'method1', slots: [asKRef('ko7')] },
        result: asKRef('kp8'),
      };
      const message2: KernelMessage = {
        methargs: { body: 'method2', slots: [] },
      };

      mockKV.set(`${kpid}.state`, 'unresolved');
      mockKV.set(`${kpid}.decider`, 'v1');
      mockKV.set(`${kpid}.subscribers`, '["v2", "v3"]');

      mockQueue.dequeue
        .mockReturnValueOnce(message1)
        .mockReturnValueOnce(message2)
        .mockReturnValueOnce(undefined);

      const queuedMessages = promiseMethods.resolveKernelPromise(
        kpid,
        false,
        value,
      );

      expect(mockQueue.dequeue).toHaveBeenCalledTimes(3);
      // Now returns messages instead of calling enqueueRun
      expect(queuedMessages).toStrictEqual([
        [kpid, message1],
        [kpid, message2],
      ]);
      expect(mockEnqueueRun).not.toHaveBeenCalled();

      expect(mockKV.get(`${kpid}.state`)).toBe('fulfilled');
      expect(mockKV.get(`${kpid}.value`)).toBe(JSON.stringify(value));
      expect(mockKV.has(`${kpid}.decider`)).toBe(false);
      expect(mockKV.has(`${kpid}.subscribers`)).toBe(false);
      expect(mockQueue.delete).toHaveBeenCalled();
      // Each dequeued message releases what its queue entry held, then the
      // promise releases the decision it was owed
      expect(mockDecrementRefCount.mock.calls).toStrictEqual([
        [kpid, 'resolve|dequeue|target'],
        ['kp8', 'resolve|dequeue|result'],
        ['ko7', 'resolve|dequeue|slot'],
        [kpid, 'resolve|dequeue|target'],
        [kpid, 'resolve|decider'],
      ]);
    });

    it('rejects a promise and enqueues pending messages', () => {
      const kpid = asKRef('kp123');
      const value: CapData<KRef> = { body: 'error', slots: [] };

      mockKV.set(`${kpid}.state`, 'unresolved');
      mockKV.set(`${kpid}.decider`, 'v1');
      mockKV.set(`${kpid}.subscribers`, '["v2", "v3"]');

      mockQueue.dequeue.mockReturnValue(undefined);

      promiseMethods.resolveKernelPromise(kpid, true, value);

      expect(mockKV.get(`${kpid}.state`)).toBe('rejected');
      expect(mockKV.get(`${kpid}.value`)).toBe(JSON.stringify(value));
      expect(mockKV.has(`${kpid}.decider`)).toBe(false);
      expect(mockKV.has(`${kpid}.subscribers`)).toBe(false);
      expect(mockQueue.delete).toHaveBeenCalled();
    });
  });

  describe('enqueuePromiseMessage', () => {
    it('adds a message to the promise queue', () => {
      const kpid = asKRef('kp123');
      const message = {
        methargs: { body: 'test', slots: [] },
        result: null as KRef | null,
      };
      promiseMethods.enqueuePromiseMessage(kpid, message);
      expect(mockProvideStoredQueue).toHaveBeenCalledWith(kpid, false);
      expect(mockQueue.enqueue).toHaveBeenCalledWith(message);
    });

    it('takes a reference on everything the queued message carries', () => {
      const kpid = asKRef('kp123');
      const message: KernelMessage = {
        methargs: { body: 'test', slots: [asKRef('ko1'), asKRef('kp2')] },
        result: asKRef('kp3'),
      };

      promiseMethods.enqueuePromiseMessage(kpid, message);

      expect(mockIncrementRefCount.mock.calls).toStrictEqual([
        [kpid, 'promiseQueue|target'],
        ['kp3', 'promiseQueue|result'],
        ['ko1', 'promiseQueue|slot'],
        ['kp2', 'promiseQueue|slot'],
      ]);
    });
  });

  describe('getKernelPromiseMessageQueue', () => {
    it('retrieves all messages from the promise queue', () => {
      const kpid = asKRef('kp123');
      const message1: KernelMessage = {
        method: 'method1',
      } as unknown as KernelMessage;
      const message2: KernelMessage = {
        method: 'method2',
      } as unknown as KernelMessage;

      mockQueue.dequeue
        .mockReturnValueOnce(message1)
        .mockReturnValueOnce(message2)
        .mockReturnValueOnce(undefined);

      const result = promiseMethods.getKernelPromiseMessageQueue(kpid);

      expect(result).toStrictEqual([message1, message2]);
      expect(mockProvideStoredQueue).toHaveBeenCalledWith(kpid, false);
      expect(mockQueue.dequeue).toHaveBeenCalledTimes(3);
    });

    it('returns an empty array for an empty queue', () => {
      const kpid = asKRef('kp123');

      mockQueue.dequeue.mockReturnValue(undefined);

      const result = promiseMethods.getKernelPromiseMessageQueue(kpid);

      expect(result).toStrictEqual([]);
      expect(mockProvideStoredQueue).toHaveBeenCalledWith(kpid, false);
      expect(mockQueue.dequeue).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPromisesByDecider', () => {
    /**
     * Populate a c-list and an unresolved promise record, using the real key
     * layout so the scan is exercised rather than mocked around.
     *
     * @param endpointId - The endpoint whose c-list to add to.
     * @param eref - The endpoint's ref for the promise.
     * @param kpid - The kernel promise.
     * @param decider - The promise's decider, if it has one.
     * @param state - The promise's state.
     */
    function givenCListPromise(
      endpointId: string,
      eref: string,
      kpid: string,
      decider: string | undefined,
      state = 'unresolved',
    ): void {
      mockKV.set(`${endpointId}.c.${eref}`, kpid);
      mockKV.set(`${endpointId}.c.${kpid}`, `R ${eref}`);
      mockKV.set(`${kpid}.state`, state);
      mockKV.set(`${kpid}.subscribers`, '[]');
      if (state === 'unresolved') {
        if (decider) {
          mockKV.set(`${kpid}.decider`, decider);
        }
      } else {
        mockKV.set(`${kpid}.value`, '{"body":"value","slots":[]}');
      }
      mockGetPrefixedKeys.mockImplementation((prefix: string) =>
        [...mockKV.keys()].filter((key) => key.startsWith(prefix)).sort(),
      );
    }

    it.each([
      { context: 'a vat', endpointId: 'v1', erefs: ['p+1', 'p-2'] },
      { context: 'a remote', endpointId: 'r1', erefs: ['rp+1', 'rp-2'] },
    ])('yields promises decided by $context', ({ endpointId, erefs }) => {
      givenCListPromise(endpointId, erefs[0] as string, 'kp101', endpointId);
      givenCListPromise(endpointId, erefs[1] as string, 'kp102', endpointId);
      givenCListPromise(endpointId, 'p+3', 'kp103', 'v2');

      const result = Array.from(
        promiseMethods.getPromisesByDecider(endpointId as VatId),
      );

      expect(result).toStrictEqual(['kp101', 'kp102']);
    });

    it('does not yield resolved promises', () => {
      givenCListPromise('v1', 'p+1', 'kp101', undefined, 'fulfilled');
      givenCListPromise('v1', 'p+2', 'kp102', 'v1');

      const result = Array.from(
        promiseMethods.getPromisesByDecider(asVatId('v1')),
      );

      expect(result).toStrictEqual(['kp102']);
    });

    it('ignores object entries in the same c-list', () => {
      givenCListPromise('v1', 'p+1', 'kp101', 'v1');
      mockKV.set('v1.c.o+1', 'ko1');
      mockKV.set('v1.c.ko1', 'R o+1');

      const result = Array.from(
        promiseMethods.getPromisesByDecider(asVatId('v1')),
      );

      expect(result).toStrictEqual(['kp101']);
    });

    it('yields nothing if no promises are decided by the vat', () => {
      const vatId = 'v1' as VatId;

      mockGetPrefixedKeys.mockReturnValue([]);

      const result = Array.from(promiseMethods.getPromisesByDecider(vatId));

      expect(result).toStrictEqual([]);
    });
  });

  describe('getKpidsToRetire', () => {
    it('returns the original promise kpid when there are no promises in the resolution value', () => {
      const origKpid = asKRef('kp123');
      const origValue: CapData<KRef> = {
        body: 'someValue',
        slots: [asKRef('ko1'), asKRef('ko2')], // non-promise slots
      };

      const result = promiseMethods.getKpidsToRetire(origKpid, origValue);

      expect(result).toStrictEqual([origKpid]);
    });

    it('returns kpids of resolved promises found in the resolution value', () => {
      const origKpid = asKRef('kp123');
      const resolvedPromise1 = asKRef('kp456');
      const resolvedPromise2 = asKRef('kp789');

      // Set up a resolution value with promise references
      const origValue: CapData<KRef> = {
        body: 'value with promises',
        slots: [asKRef('ko1'), resolvedPromise1, resolvedPromise2],
      };

      // Set up the promises in the KV store
      mockKV.set(`${resolvedPromise1}.state`, 'fulfilled');
      mockKV.set(
        `${resolvedPromise1}.value`,
        JSON.stringify({
          body: 'fulfilled value 1',
          slots: [],
        }),
      );

      mockKV.set(`${resolvedPromise2}.state`, 'rejected');
      mockKV.set(
        `${resolvedPromise2}.value`,
        JSON.stringify({
          body: 'rejected value',
          slots: [],
        }),
      );

      const result = promiseMethods.getKpidsToRetire(origKpid, origValue);

      // Should include the original promise and the two resolved promises
      expect(result).toContain(origKpid);
      expect(result).toContain(resolvedPromise1);
      expect(result).toContain(resolvedPromise2);
      expect(result).toHaveLength(3);
    });

    it('handles promises with nested promise references', () => {
      const origKpid = asKRef('kp100');
      const promise1 = asKRef('kp101');
      const promise2 = 'kp102';
      const promise3 = 'kp103';

      // Original promise resolves to promise1
      const origValue: CapData<KRef> = {
        body: 'value with promise',
        slots: [promise1],
      };

      // promise1 resolves to promise2
      mockKV.set(`${promise1}.state`, 'fulfilled');
      mockKV.set(
        `${promise1}.value`,
        JSON.stringify({
          body: 'nested promise',
          slots: [promise2],
        }),
      );

      // promise2 resolves to promise3
      mockKV.set(`${promise2}.state`, 'fulfilled');
      mockKV.set(
        `${promise2}.value`,
        JSON.stringify({
          body: 'deeper nested promise',
          slots: [promise3],
        }),
      );

      // promise3 resolves to a simple value
      mockKV.set(`${promise3}.state`, 'fulfilled');
      mockKV.set(
        `${promise3}.value`,
        JSON.stringify({
          body: 'final value',
          slots: [],
        }),
      );

      const result = promiseMethods.getKpidsToRetire(origKpid, origValue);

      // Should include all promises in the chain
      expect(result).toContain(origKpid);
      expect(result).toContain(promise1);
      expect(result).toContain(promise2);
      expect(result).toContain(promise3);
      expect(result).toHaveLength(4);
    });

    it('handles cyclic promise references', () => {
      const origKpid = asKRef('kp200');
      const promise1 = asKRef('kp201');
      const promise2 = 'kp202';

      // Original promise resolves to promise1
      const origValue: CapData<KRef> = {
        body: 'cyclic promises',
        slots: [promise1],
      };

      // promise1 resolves to promise2
      mockKV.set(`${promise1}.state`, 'fulfilled');
      mockKV.set(
        `${promise1}.value`,
        JSON.stringify({
          body: 'points to promise2',
          slots: [promise2],
        }),
      );

      // promise2 resolves back to promise1 (creates a cycle)
      mockKV.set(`${promise2}.state`, 'fulfilled');
      mockKV.set(
        `${promise2}.value`,
        JSON.stringify({
          body: 'points back to promise1',
          slots: [promise1],
        }),
      );

      const result = promiseMethods.getKpidsToRetire(origKpid, origValue);

      // Should handle the cycle without infinite recursion
      expect(result).toContain(origKpid);
      expect(result).toContain(promise1);
      expect(result).toContain(promise2);
      expect(result).toHaveLength(3);
    });

    it('only includes resolved promises', () => {
      const origKpid = asKRef('kp300');
      const resolvedPromise = asKRef('kp301');
      const unresolvedPromise = asKRef('kp302');

      // Original promise has both resolved and unresolved promises
      const origValue: CapData<KRef> = {
        body: 'mixed promises',
        slots: [resolvedPromise, unresolvedPromise],
      };

      // resolvedPromise is fulfilled
      mockKV.set(`${resolvedPromise}.state`, 'fulfilled');
      mockKV.set(
        `${resolvedPromise}.value`,
        JSON.stringify({
          body: 'resolved value',
          slots: [],
        }),
      );

      // unresolvedPromise is unresolved
      mockKV.set(`${unresolvedPromise}.state`, 'unresolved');
      mockKV.set(`${unresolvedPromise}.subscribers`, '[]');

      const result = promiseMethods.getKpidsToRetire(origKpid, origValue);

      // Should include original and resolved promise, but not unresolved one
      expect(result).toContain(origKpid);
      expect(result).toContain(resolvedPromise);
      expect(result).not.toContain(unresolvedPromise);
      expect(result).toHaveLength(2);
    });
  });
});
