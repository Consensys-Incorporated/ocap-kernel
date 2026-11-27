import type { KernelMessage, PromiseQueueEntry } from '../../types.ts';

/**
 * Read a promise-queue entry as written now, with its provenance, or as a
 * kernel from before provenance was kept wrote it: the message alone. The
 * kernel answers for such a message as its sender, with no cause.
 *
 * @param entry - The entry, as stored.
 * @returns The entry, with its provenance.
 */
export const asPromiseQueueEntry = (
  entry: PromiseQueueEntry | KernelMessage,
): PromiseQueueEntry =>
  'message' in entry
    ? entry
    : { message: entry, sender: 'kernel', cause: 'async' };
