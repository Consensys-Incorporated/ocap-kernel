import type { KVStore } from '@metamask/kernel-store';

import type { EndpointId, KRef, Ref } from '../../types.ts';
import type { StoredQueue, StoredValue } from '../types.ts';

/**
 * Get the base store methods for managing stored values and queues.
 *
 * @param kv - The key/value store to provide the underlying persistence mechanism.
 * @returns An object with methods for managing stored values and queues.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getBaseMethods(kv: KVStore) {
  /**
   * Get the key for the reachable flag and vatSlot for a given endpoint and kref.
   *
   * @param endpointId - The endpoint for which the reachable flag is being set.
   * @param ref - The ref.
   * @returns The key for the reachable flag and vatSlot.
   */
  function getSlotKey(endpointId: EndpointId, ref: Ref): string {
    return `${getCListPrefix(endpointId)}${ref}`;
  }

  /**
   * Get the prefix shared by both directions of every entry in an endpoint's
   * c-list, for iterating over the whole thing.
   *
   * @param endpointId - The endpoint whose c-list is of interest.
   * @returns The prefix that all of that endpoint's c-list keys begin with.
   */
  function getCListPrefix(endpointId: EndpointId): string {
    return `${endpointId}.c.`;
  }

  /**
   * Generate the storage key for a kernel entity's reference count.
   *
   * @param kref - The KRef of interest.
   * @returns the key to store the indicated reference count at.
   */
  function refCountKey(kref: KRef): string {
    return `${kref}.refCount`;
  }

  /**
   * Generate the storage key for a kernel entity's owner.
   *
   * @param kref - The KRef of interest.
   * @returns the key to store the indicated owner at.
   */
  function getOwnerKey(kref: KRef): string {
    return `${kref}.owner`;
  }

  /**
   * Generate the storage key for a kernel entity's revoked flag.
   *
   * @param kref - The KRef of interest.
   * @returns the key to store the indicated revoked flag at.
   */
  function getRevokedKey(kref: KRef): string {
    return `${kref}.revoked`;
  }

  /**
   * Increment the value of a persistently stored counter.
   *
   * Note that the while the value is interpreted as an integer (in order to
   * enable it to be incremented), it is stored and returned in the form of a
   * string. This is because (a) our persistent storage only stores strings, and
   * (b) the sole purpose of one of these counters is simply to provide an
   * unending sequence of unique values; we don't actually use them as numbers
   * or, indeed, even care at all if this sequence is produced using numbers.
   *
   * @param value - Reference to the stored value to be incremented.
   * @returns The value as it was prior to being incremented.
   */
  function incCounter(value: StoredValue): string {
    const current = value.get();
    const next = `${Number(current) + 1}`;
    value.set(next);
    return current as string;
  }

  /**
   * Provide a stored value object for which we keep an in-memory cache. We only
   * touch persistent storage if the value hasn't ever been read of if it is
   * modified; otherwise we can service read requests from memory.
   *
   * IMPORTANT NOTE: in order for the cache to work, all subsequent accesses to
   * the value MUST be made through a common stored value object.
   *
   * @param key - A key string that identifies the value.
   * @param init - If provided, an initial setting if the stored entity does not exist.
   * @returns An object for interacting with the value.
   */
  function provideCachedStoredValue(key: string, init?: string): StoredValue {
    let value: string | undefined = kv.get(key);
    if (value === undefined && init !== undefined) {
      kv.set(key, init);
      value = init;
    }
    return harden({
      get(): string | undefined {
        return value;
      },
      set(newValue: string): void {
        // Cached only once stored, so that a write that fails leaves the two
        // agreeing.
        kv.set(key, newValue);
        value = newValue;
      },
      delete(): void {
        kv.delete(key);
        value = undefined;
      },
    });
  }

  /**
   * Provide a stored value object that is kept in persistent storage without caching.
   *
   * @param key - A key string that identifies the value.
   * @param init - If provided, an initial setting if the stored entity does not exist.
   * @returns An object for interacting with the value.
   */
  function provideRawStoredValue(key: string, init?: string): StoredValue {
    if (kv.get(key) === undefined && init !== undefined) {
      kv.set(key, init);
    }
    return harden({
      get: () => kv.get(key),
      set: (newValue: string) => kv.set(key, newValue),
      delete: () => kv.delete(key),
    });
  }

  /**
   * Produce an object to access a persistently stored queue.
   *
   * @param queueName - The name for the queue (must be unique among queues).
   * @param cached - Optional flag: set to true if the queue should cache its
   * limit indices in memory (only do this if the queue is going to be accessed or
   * checked frequently).
   * @returns An object for interacting with the queue.
   */
  function provideStoredQueue(
    queueName: string,
    cached: boolean = false,
  ): StoredQueue {
    const qk = `queue.${queueName}`;
    // Note: cached=true ==> caches only the head & tail indices, NOT the queue entries themselves
    const provideValue = cached
      ? provideCachedStoredValue
      : provideRawStoredValue;
    const head = provideValue(`${qk}.head`, '1');
    const tail = provideValue(`${qk}.tail`, '1');
    if (head.get() === undefined || tail.get() === undefined) {
      throw Error(`queue ${queueName} not initialized`);
    }
    return {
      enqueue(item: object): void {
        if (head.get() === undefined) {
          throw Error(`enqueue into deleted queue ${queueName}`);
        }
        // Before the head moves: outside a crank nothing rolls back, and a
        // head past an entry that failed to be written leaves a gap every
        // later dequeue dies on.
        kv.set(`${qk}.${head.get()}`, JSON.stringify(item));
        incCounter(head);
      },
      dequeue(): object | undefined {
        const headPos = head.get();
        if (headPos === undefined) {
          return undefined;
        }
        const tailPos = tail.get();
        if (tailPos !== headPos) {
          const entry = kv.getRequired(`${qk}.${tailPos}`);
          // The tail moves first: an entry deleted under a tail that failed
          // to move is one every later dequeue dies on.
          incCounter(tail);
          kv.delete(`${qk}.${tailPos}`);
          return JSON.parse(entry) as object;
        }
        return undefined;
      },
      delete(): void {
        const headPos = head.get();
        if (headPos !== undefined) {
          let tailPos = tail.get();
          while (tailPos !== headPos) {
            kv.delete(`${qk}.${tailPos}`);
            tailPos = `${Number(tailPos) + 1}`;
          }
          head.delete();
          tail.delete();
        }
      },
    };
  }

  /**
   * Generator that yields all the keys beginning with a given prefix.
   *
   * @param prefix - The prefix of interest.
   *
   * @yields the keys that start with `prefix`.
   */
  function* getPrefixedKeys(prefix: string): Generator<string> {
    let key: string | undefined = prefix;
    for (;;) {
      key = kv.getNextKey(key);
      if (!key) {
        break;
      }
      if (!key.startsWith(prefix)) {
        break;
      }
      yield key;
    }
  }

  return {
    getSlotKey,
    getCListPrefix,
    refCountKey,
    getOwnerKey,
    getRevokedKey,
    incCounter,
    provideCachedStoredValue,
    provideRawStoredValue,
    provideStoredQueue,
    getPrefixedKeys,
  };
}
