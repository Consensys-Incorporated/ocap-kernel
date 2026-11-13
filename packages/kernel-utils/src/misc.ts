import { AbortError } from '@metamask/kernel-errors';

/**
 * Return a new object with the undefined values removed.
 * Useful for building options bags with exact optional property types.
 *
 * @param record - The record to filter.
 * @returns The new object with the undefined values removed.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export const ifDefined = (record: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(record).filter(([_, value]) => value !== undefined),
  );

/**
 * A simple counter which increments and returns when called.
 *
 * @param start - One less than the first returned number.
 * @returns A counter.
 */
export const makeCounter = (start: number = 0) => {
  let counter: number = start;
  return () => {
    counter += 1;
    return counter;
  };
};

/**
 * Delay execution by the specified number of milliseconds.
 *
 * @param ms - The number of milliseconds to delay.
 * @returns A promise that resolves after the specified delay.
 */
export const delay = async (ms = 1): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Abortable sleep.
 *
 * @param ms - The number of milliseconds to sleep.
 * @param signal - The abort signal to listen to.
 * @returns A promise that resolves when the sleep is complete.
 */
export async function abortableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new AbortError();
  }
  await new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(id);
      reject(new AbortError());
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Settle as `promise` does, or reject with `signal`'s reason if it aborts
 * first. The operation itself carries on; only the wait ends.
 *
 * @param promise - The operation to wait for.
 * @param signal - The signal that may cut the wait short, if any.
 * @returns What `promise` settles with.
 */
export const raceAbort = async <Value>(
  promise: Promise<Value>,
  signal?: AbortSignal | null,
): Promise<Value> => {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};
