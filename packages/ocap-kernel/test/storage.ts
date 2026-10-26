import type { KVStore, KernelDatabase, VatStore } from '@metamask/kernel-store';

import { keySearch } from '../src/utils/key-search.ts';

/* oxlint-disable no-lonely-if, no-else-return */ // stupid rules that encourage unclear code

/**
 * A mock key/value store realized as a Map<string, string>.
 *
 * @returns The mock {@link KVStore}.
 */
export function makeMapKVStore(): KVStore {
  return makeMapKVStoreInternal(new Map<string, string>());
}

/**
 * Internal helper function to build mock key/value stores, where the backing
 * map is injected so it can be manipulated externally.
 *
 * @param map - The Map that will hold the mock store's state.
 *
 * @returns The mock {@link KVStore}.
 */
function makeMapKVStoreInternal(map: Map<string, string>): KVStore {
  let keyCache: string[] | null = null;
  let lastNextKey: string | null = null;
  let lastNextKeyIndex: number = -1;

  return {
    get<Value extends string = string>(key: string): Value | undefined {
      return map.get(key) as Value | undefined;
    },
    getNextKey(key: string): string | undefined {
      keyCache ??= Array.from(map.keys()).sort();
      const index =
        lastNextKey === key ? lastNextKeyIndex : keySearch(keyCache, key);
      if (index < 0) {
        lastNextKey = null;
        lastNextKeyIndex = -1;
        return undefined;
      }
      lastNextKey = keyCache[index] as string;
      if (key < lastNextKey) {
        lastNextKeyIndex = index;
        return lastNextKey;
      } else {
        if (index + 1 >= keyCache.length) {
          lastNextKey = null;
          lastNextKeyIndex = -1;
          return undefined;
        } else {
          lastNextKey = keyCache[index + 1] as string;
          lastNextKeyIndex = index + 1;
          return lastNextKey;
        }
      }
    },
    getRequired<Value extends string = string>(key: string): Value {
      const result = map.get(key);
      if (result === undefined) {
        throw Error(`No value found for key ${key}.`);
      }
      return result as Value;
    },
    set(key: string, value: string): void {
      map.set(key, value);
      keyCache = null;
    },
    delete(key: string): void {
      map.delete(key);
      keyCache = null;
    },
  };
}

type ClearableVatStore = VatStore & {
  clear: () => void;
};

/**
 * Make a mock VatStore backed by a Map.
 *
 * @param _vatID - The vat ID of the vat whose store this will be (not used here).
 *
 * @returns the mock {@link VatStore}.
 */
function makeMapVatStore(_vatID: string): ClearableVatStore {
  const kvData: Map<string, string> = new Map();
  return {
    getKVData: () => Array.from(kvData.entries()),
    updateKVData: (sets: [string, string][], deletes: string[]) => {
      for (const [key, value] of sets) {
        kvData.set(key, value);
      }
      for (const key of deletes) {
        kvData.delete(key);
      }
    },
    clear: () => {
      kvData.clear();
    },
  };
}

/**
 * Make a mock Kernel database using Maps.
 *
 * @returns the mock {@link KernelDatabase}.
 */
export function makeMapKernelDatabase(): KernelDatabase {
  const map = new Map<string, string>();
  const vatStores = new Map<string, ClearableVatStore>();
  return {
    kernelKVStore: makeMapKVStoreInternal(map),
    clear: () => {
      map.clear();
      for (const vs of vatStores.values()) {
        vs.clear();
      }
    },
    executeQuery: () => [],
    makeVatStore: (vatID: string) => {
      const store = makeMapVatStore(vatID);
      vatStores.set(vatID, store);
      return store;
    },
    deleteVatStore: (vatID: string) => {
      vatStores.delete(vatID);
    },
    close: () => {
      // noop
    },
    createSavepoint: () => {
      // noop
    },
    rollbackSavepoint: () => {
      // noop
    },
    releaseSavepoint: () => {
      // noop
    },
  };
}
