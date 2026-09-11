import type { KVStore } from '@metamask/kernel-store';
import type { Logger } from '@metamask/logger';
import { object, string, number, boolean, refine } from '@metamask/superstruct';

import type { KRef, RunQueueItemNotify, RunQueueItemSend } from '../types.ts';

export type CrankBufferItem = RunQueueItemSend | RunQueueItemNotify;

export type StoreContext = {
  kv: KVStore;
  runQueue: StoredQueue; // Holds RunAction[]
  runQueueLengthCache: number; // Holds number
  refreshRunQueue: () => void;
  refreshCachedValues: () => void;
  nextObjectId: StoredValue; // Holds string
  nextPromiseId: StoredValue; // Holds string
  nextVatId: StoredValue; // Holds string
  nextRemoteId: StoredValue; // Holds string
  maybeFreeKrefs: Set<KRef>;
  gcActions: StoredValue; // Holds GCAction[]
  reapQueue: StoredValue; // Holds ReapAction[]
  terminatedVats: StoredValue; // Holds VatId[]
  inCrank: boolean;
  crankSettled?: Promise<void>;
  resolveCrank?: (() => void) | undefined;
  savepoints: string[];
  crankBuffer: CrankBufferItem[]; // Buffer for sends and notifications during crank
  subclusters: StoredValue; // Holds Subcluster[]
  nextSubclusterId: StoredValue; // Holds string
  vatToSubclusterMap: StoredValue; // Holds Record<VatId, SubclusterId>
  auditRefCounts: boolean; // If set, verify refcounts against ground truth every crank
  logger?: Logger | undefined;
};

export type StoredValue = {
  get(): string | undefined;
  set(newValue: string): void;
  delete(): void;
};

export type StoredQueue = {
  enqueue(item: object): void;
  dequeue(): object | undefined;
  delete(): void;
};

export type VatCleanupWork = {
  exports: number;
  imports: number;
  promises: number;
  kv: number;
};

/**
 * Superstruct schema for {@link RelayEntry}, used for runtime validation on
 * both read and write paths of the relay store.
 */
export const RelayEntryStruct = object({
  addr: refine(string(), 'non-empty string', (value) => value.length > 0),
  lastSeen: refine(
    number(),
    'non-negative finite number',
    (value) => Number.isFinite(value) && value >= 0,
  ),
  isBootstrap: boolean(),
});

/**
 * A relay entry with metadata for prioritized selection and bounded storage.
 *
 * Migration from the legacy `string[]` format is handled by `getRelayEntries()`
 * in `store/methods/relay.ts`. The migration path can be removed once all
 * deployed kernels have been initialized at least once on a version that
 * includes RelayEntry support.
 */
export type RelayEntry = {
  /** Relay multiaddr string. */
  addr: string;
  /**
   * Epoch ms when the relay was last added or re-observed. A value of `0`
   * indicates a legacy-migrated entry with unknown observation time; these
   * sort last during recency-based eviction.
   */
  lastSeen: number;
  /** True if provided at kernel initialization (prioritized during eviction). */
  isBootstrap: boolean;
};
