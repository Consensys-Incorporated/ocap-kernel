import type { KVStore, VatStore } from '@metamask/kernel-store';

const storeFaults = new WeakSet<object>();

/**
 * Make a call, marking what it throws as a store fault.
 *
 * @param call - The call.
 * @returns What it returns.
 */
function marking<Result>(call: () => Result): Result {
  try {
    return call();
  } catch (error) {
    if (typeof error === 'object' && error !== null) {
      storeFaults.add(error);
    }
    throw error;
  }
}

/**
 * Wrap the kernel's KV store so that what it throws can be told apart, by
 * {@link isStoreFault}, from what the kernel's own checks throw.
 *
 * @param kv - The KV store.
 * @returns The wrapped store.
 */
export function markStoreFaults(kv: KVStore): KVStore {
  return harden({
    get: <Value extends string = string>(key: string) =>
      marking(() => kv.get<Value>(key)),
    // By way of `get`, so a missing key is not taken for a store fault.
    getRequired: <Value extends string = string>(key: string) => {
      const value = marking(() => kv.get<Value>(key));
      // Falsy, not just missing: the databases' own `getRequired` refuse an
      // empty value too.
      if (!value) {
        throw Error(`no record matching key '${key}'`);
      }
      return value;
    },
    getNextKey: (previousKey: string) =>
      marking(() => kv.getNextKey(previousKey)),
    set: (key: string, value: string) => marking(() => kv.set(key, value)),
    delete: (key: string) => marking(() => kv.delete(key)),
  });
}

/**
 * Wrap a vat's store as {@link markStoreFaults} wraps the kernel's.
 *
 * @param vatStore - The vat's store.
 * @returns The wrapped store.
 */
export function markVatStoreFaults(vatStore: VatStore): VatStore {
  return harden({
    getKVData: () => marking(() => vatStore.getKVData()),
    updateKVData: (sets, deletes) =>
      marking(() => vatStore.updateKVData(sets, deletes)),
  });
}

/**
 * Whether an error, or one in its `cause` chain, was thrown by the kernel's
 * stores.
 *
 * @param error - The error.
 * @returns True if so.
 */
export function isStoreFault(error: unknown): boolean {
  const seen = new Set<object>();
  for (
    let current = error;
    typeof current === 'object' && current !== null && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    if (storeFaults.has(current)) {
      return true;
    }
    seen.add(current);
  }
  return false;
}
