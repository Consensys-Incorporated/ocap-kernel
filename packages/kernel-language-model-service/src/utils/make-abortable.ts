/**
 * Wrap a promise so that, once `abort()` runs, `read()` rejects instead of
 * settling as the promise does, even if the promise has already settled.
 * The operation behind the promise carries on; only the wait ends.
 *
 * Unlike `raceAbort` from `@metamask/kernel-utils`, this needs no
 * `AbortController`, which a vat has only if it requests that endowment.
 *
 * @param promise - The operation to wait for.
 * @returns The read and abort functions.
 */
export const makeAbortable = <Value>(
  promise: Promise<Value>,
): { read: () => Promise<Value>; abort: () => Promise<void> } => {
  // read() reports a rejection; an unread one must not go unhandled.
  promise.catch(() => undefined);
  let aborted = false;
  let rejectAborted = (): void => undefined;
  const abortion = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(new Error('Operation aborted.'));
  });
  abortion.catch(() => undefined);
  return harden({
    read: async () => {
      if (aborted) {
        throw new Error('Operation aborted.');
      }
      return Promise.race([promise, abortion]);
    },
    abort: async () => {
      aborted = true;
      rejectAborted();
    },
  });
};
