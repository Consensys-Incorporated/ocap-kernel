import { Fail } from '@endo/errors';
import type { CapData } from '@endo/marshal';

import { getBaseMethods } from './base.ts';
import { insistEndpointId } from '../../types.ts';
import type {
  KRef,
  KernelPromise,
  KernelMessage,
  PromiseState,
  EndpointId,
} from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { getRefCountMethods } from './refcount.ts';
import { makeKernelSlot } from '../utils/kernel-slots.ts';
import { parseRef } from '../utils/parse-ref.ts';
import { isPromiseRef } from '../utils/promise-ref.ts';

/** Matches the promise erefs in a c-list: `p+NN`/`p-NN`, or `rp+NN`/`rp-NN` for a remote. */
const PROMISE_EREF = /^r?p[-+]\d+$/u;

/**
 * Create a promise store object that provides functionality for managing kernel promises.
 *
 * @param ctx - The store context.
 * @returns A promise store object that maps various persistent kernel data
 * structures onto `kv`.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getPromiseMethods(ctx: StoreContext) {
  const {
    incCounter,
    provideStoredQueue,
    getPrefixedKeys,
    getCListPrefix,
    refCountKey,
  } = getBaseMethods(ctx.kv);
  const { incrementRefCount, decrementRefCount } = getRefCountMethods(ctx);

  /**
   * Create a new, unresolved kernel promise, born with a reference count of 1:
   * an unsettled promise is owed a decision, and that obligation is itself a
   * reference. Released, exactly once, when the promise settles in
   * {@link resolveKernelPromise}.
   *
   * @returns A tuple of the new promise's KRef and an object describing the
   * new promise itself.
   */
  function initKernelPromise(): [KRef, KernelPromise] {
    const kpr: KernelPromise = {
      state: 'unresolved',
      subscribers: [],
    };
    const kpid = getNextPromiseId();
    provideStoredQueue(kpid, false);
    ctx.kv.set(`${kpid}.state`, 'unresolved');
    ctx.kv.set(`${kpid}.subscribers`, '[]');
    ctx.kv.set(refCountKey(kpid), '1');
    return [kpid, kpr];
  }

  /**
   * Fetch the descriptive record for a kernel promise.
   *
   * @param kpid - The KRef of the kernel promise of interest.
   * @returns An object describing the requested kernel promise.
   */
  function getKernelPromise(kpid: KRef): KernelPromise {
    const { context, isPromise } = parseRef(kpid);
    assert(context === 'kernel' && isPromise);
    const state = ctx.kv.get(`${kpid}.state`) as PromiseState;
    if (state === undefined) {
      throw Error(`unknown kernel promise ${kpid}`);
    }
    const result: KernelPromise = { state };
    switch (state as string) {
      case 'unresolved': {
        const decider = ctx.kv.get(`${kpid}.decider`);
        if (decider !== '' && decider !== undefined) {
          if (decider !== 'kernel') {
            insistEndpointId(decider);
          }
          result.decider = decider;
        }
        const subscribers = ctx.kv.getRequired(`${kpid}.subscribers`);
        result.subscribers = JSON.parse(subscribers);
        break;
      }
      case 'fulfilled':
      case 'rejected': {
        result.value = JSON.parse(ctx.kv.getRequired(`${kpid}.value`));
        break;
      }
      default:
        throw Error(`unknown state for ${kpid}: ${state}`);
    }
    return result;
  }

  /**
   * Expunge a kernel promise from the kernel's persistent state.
   *
   * @param kpid - The KRef of the kernel promise to delete.
   */
  function deleteKernelPromise(kpid: KRef): void {
    ctx.kv.delete(`${kpid}.state`);
    ctx.kv.delete(`${kpid}.decider`);
    ctx.kv.delete(`${kpid}.subscribers`);
    ctx.kv.delete(`${kpid}.value`);
    ctx.kv.delete(refCountKey(kpid));
    provideStoredQueue(kpid).delete();
  }

  /**
   * Obtain a KRef for the next unallocated kernel promise.
   *
   * @returns The next kpid use.
   */
  function getNextPromiseId(): KRef {
    return makeKernelSlot('promise', incCounter(ctx.nextPromiseId));
  }

  /**
   * Add a new subscriber to a kernel promise's collection of subscribers.
   *
   * @param endpointId - The endpoint that is subscribing.
   * @param kpid - The KRef of the promise being subscribed to.
   */
  function addPromiseSubscriber(endpointId: EndpointId, kpid: KRef): void {
    const kp = getKernelPromise(kpid);
    kp.state === 'unresolved' ||
      Fail`attempt to add subscriber to resolved promise ${kpid}`;
    const tempSet = new Set(kp.subscribers);
    tempSet.add(endpointId);
    const newSubscribers = Array.from(tempSet).sort();
    const key = `${kpid}.subscribers`;
    ctx.kv.set(key, JSON.stringify(newSubscribers));
  }

  /**
   * Assign a kernel promise's decider.
   *
   * @param kpid - The KRef of promise whose decider is being set.
   * @param endpointId - The endpoint which will become the decider.
   */
  function setPromiseDecider(
    kpid: KRef,
    endpointId: EndpointId | 'kernel',
  ): void {
    if (kpid) {
      ctx.kv.set(`${kpid}.decider`, endpointId);
    }
  }

  /**
   * Resolve a kernel promise, updating its state and returning any queued messages.
   * The queued messages should be buffered by the caller for eventual delivery.
   *
   * @param kpid - The ref of the promise being resolved.
   * @param rejected - True if the promise is being rejected, false if fulfilled.
   * @param value - The value the promise is being fulfilled to or rejected with.
   * @returns An array of queued messages that were waiting on this promise,
   *          each as a tuple of [target, message].
   */
  function resolveKernelPromise(
    kpid: KRef,
    rejected: boolean,
    value: CapData<KRef>,
  ): [KRef, KernelMessage][] {
    const queue = provideStoredQueue(kpid, false);
    // Releasing each queue entry's references as we go: the caller re-enqueues
    // these on the run queue, which takes its own.
    const queuedMessages: [KRef, KernelMessage][] = [];
    for (const message of getKernelPromiseMessageQueue(kpid)) {
      queuedMessages.push([kpid, message]);
      releaseQueuedMessageRefs(kpid, message, 'resolve|dequeue');
    }
    ctx.kv.set(`${kpid}.state`, rejected ? 'rejected' : 'fulfilled');
    ctx.kv.set(`${kpid}.value`, JSON.stringify(value));
    ctx.kv.delete(`${kpid}.decider`);
    ctx.kv.delete(`${kpid}.subscribers`);
    // The promise has been decided, so it is no longer owed a decision.
    decrementRefCount(kpid, 'resolve|decider');
    queue.delete();
    return queuedMessages;
  }

  /**
   * Append a message to a promise's message queue.
   *
   * The queue entry becomes the message's holder, so it takes references on
   * everything the message carries, just as the run queue does.
   *
   * @param kpid - The KRef of the promise to enqueue on.
   * @param message - The message to enqueue.
   */
  function enqueuePromiseMessage(kpid: KRef, message: KernelMessage): void {
    incrementRefCount(kpid, 'promiseQueue|target');
    if (message.result) {
      incrementRefCount(message.result, 'promiseQueue|result');
    }
    for (const slot of message.methargs.slots) {
      incrementRefCount(slot, 'promiseQueue|slot');
    }
    provideStoredQueue(kpid, false).enqueue(message);
  }

  /**
   * Release the references a promise-queue entry held on the message it
   * carried.
   *
   * @param kpid - The promise whose queue the message was on, and hence the
   * message's target.
   * @param message - The message being taken off the queue.
   * @param tag - Tag for refcount logging.
   */
  function releaseQueuedMessageRefs(
    kpid: KRef,
    message: KernelMessage,
    tag: string,
  ): void {
    decrementRefCount(kpid, `${tag}|target`);
    if (message.result) {
      decrementRefCount(message.result, `${tag}|result`);
    }
    for (const slot of message.methargs.slots) {
      decrementRefCount(slot, `${tag}|slot`);
    }
  }

  /**
   * Fetch the messages in a kernel promise's message queue.
   *
   * @param kpid - The KRef of the kernel promise of interest.
   * @returns An array of all the messages in the given promise's message queue.
   */
  function getKernelPromiseMessageQueue(kpid: KRef): KernelMessage[] {
    const result: KernelMessage[] = [];
    const queue = provideStoredQueue(kpid, false);
    for (;;) {
      const message = queue.dequeue() as KernelMessage;
      if (message) {
        result.push(message);
      } else {
        return result;
      }
    }
  }

  /**
   * Generator that yield the promises decided by a given endpoint (vat or remote).
   *
   * @param decider - The endpoint ID (vat ID or remote ID) of interest.
   *
   * @yields the kpids of all the unresolved promises decided by `decider`.
   */
  function* getPromisesByDecider(decider: EndpointId): Generator<KRef> {
    const prefix = getCListPrefix(decider);
    for (const key of getPrefixedKeys(prefix)) {
      // A c-list holds both directions of each pair. Iterate by eref, and only
      // the promise ones: `p+NN`/`p-NN` for a vat, `rp+NN`/`rp-NN` for a remote.
      if (!PROMISE_EREF.test(key.slice(prefix.length))) {
        continue;
      }
      const kpid = ctx.kv.getRequired<KRef>(key);
      const kp = getKernelPromise(kpid);
      if (kp.state === 'unresolved' && kp.decider === decider) {
        yield kpid;
      }
    }
  }

  /**
   * Given a promise that has just been resolved and the value it resolved to,
   * find all promises reachable (recursively) from the new resolution value
   * which are themselves already resolved. This will determine the set of
   * resolutions that subscribers to the original promise will need to be
   * notified of.
   *
   * This is needed because subscription to a promise carries with it an implied
   * subscription to any promises that appear in its resolution value -- these
   * subscriptions must be implied rather than explicit because they are
   * necessarily unknown at the time of the original promise was subscribed to.
   *
   * @param origKpid - The original promise to start from.
   * @param origValue - The value the original promise is resolved to.
   * @returns An array of the kpids of the promises whose values become visible
   * as a consequence of the resolution of `origKpid`.
   */
  function getKpidsToRetire(origKpid: KRef, origValue: CapData<KRef>): KRef[] {
    const seen = new Set<KRef>();
    const scanPromise = (kpid: KRef, value: CapData<KRef>): void => {
      seen.add(kpid);
      if (value) {
        for (const slot of value.slots) {
          if (isPromiseRef(slot)) {
            if (!seen.has(slot)) {
              const promise = getKernelPromise(slot);
              if (promise.state !== 'unresolved') {
                if (promise.value) {
                  scanPromise(slot, promise.value);
                }
              }
            }
          }
        }
      }
    };
    scanPromise(origKpid, origValue);
    return Array.from(seen);
  }

  return {
    initKernelPromise,
    getKernelPromise,
    deleteKernelPromise,
    getNextPromiseId,
    addPromiseSubscriber,
    setPromiseDecider,
    resolveKernelPromise,
    enqueuePromiseMessage,
    getKernelPromiseMessageQueue,
    getPromisesByDecider,
    getKpidsToRetire,
  };
}
