import type { RunQueueItem } from '../../types.ts';
import type { StoreContext } from '../types.ts';

/**
 * Get a queue store object that provides functionality for managing queues.
 *
 * @param ctx - The store context.
 * @returns A queue store object that maps various persistent kernel data
 * structures onto `kv`.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getQueueMethods(ctx: StoreContext) {
  /**
   * Find out how long some queue is.
   *
   * @param queueName - The name of the queue of interest.
   *
   * @returns the number of items in the given queue.
   */
  function getQueueLength(queueName: string): number {
    const qk = `queue.${queueName}`;
    const head = ctx.kv.get(`${qk}.head`);
    const tail = ctx.kv.get(`${qk}.tail`);
    if (head === undefined || tail === undefined) {
      throw Error(`unknown queue ${queueName}`);
    }
    return Number(head) - Number(tail);
  }

  /**
   * Append a message to the kernel's run queue.
   *
   * @param message - The message to enqueue.
   */
  function enqueueRun(message: RunQueueItem): void {
    // Materialize the cache from the database before adjusting it. A
    // negative cache means "unknown"; incrementing it blindly would turn
    // that sentinel into a concrete (and wrong) count, and since the
    // result is no longer negative it would never be re-read.
    runQueueLength();
    ctx.runQueue.enqueue(message);
    // Counted only once written, so that a write that fails leaves the count
    // right.
    ctx.runQueueLengthCache += 1;
  }

  /**
   * Fetch the next message on the kernel's run queue.
   *
   * @returns The next message on the run queue, or undefined if the queue is
   * empty.
   */
  function dequeueRun(): RunQueueItem | undefined {
    // Materialize the cache before adjusting it, for the same reason as
    // in `enqueueRun`.
    runQueueLength();
    ctx.runQueueLengthCache -= 1;
    return ctx.runQueue.dequeue() as RunQueueItem | undefined;
  }

  /**
   * Obtain the number of entries in the run queue.
   *
   * @returns the number of items in the run queue.
   */
  function runQueueLength(): number {
    if (ctx.runQueueLengthCache < 0) {
      ctx.runQueueLengthCache = getQueueLength('run');
    }
    return ctx.runQueueLengthCache;
  }

  return {
    getQueueLength,
    enqueueRun,
    dequeueRun,
    runQueueLength,
  };
}
