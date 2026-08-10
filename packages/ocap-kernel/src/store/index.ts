/*
 * Organization of keys in the key value store:
 *
 * Definitions
 *   NN ::= some decimal integer
 *   CAPDATA ::= capdata encoded structure value
 *   JSON(${xx}) ::= JSON encoding of ${xx}
 *
 *   ${koid} ::= ko${NN}                      // kernel object ID
 *   ${kpid} ::= kp${NN}                      // kernel promise ID
 *   ${kref} ::= ${koid} | ${kpid}            // kernel reference
 *   ${dir} ::= + | -                         // direction (for remote and vat references)
 *   ${roid} ::= ro${dir}${NN}                // remote object ID
 *   ${rpid} ::= rp${dir}${NN}                // remote promise ID
 *   ${rref} ::= ${roid} | ${rpid}            // remote reference
 *   ${void} ::= o${dir}${NN}                 // vat object ID
 *   ${vpid} ::= p${dir}${NN}                 // vat promise ID
 *   ${vref} ::= ${void} | ${vpid}            // vat reference
 *   ${eref} ::= ${vref} | ${rref}            // external reference
 *   ${vatid} ::= v${NN}                      // vat ID
 *   ${remid} ::= r${NN}                      // remote ID
 *   ${endid} ::= ${vatid} | ${remid}         // endpoint ID
 *   ${queueName} ::= run | ${kpid}
 *
 * Queues
 *   queue.${queueName}.head = NN             // queue head index
 *   queue.${queueName}.tail = NN             // queue tail index
 *   queue.${queueName}.${NN} = JSON(ITEM)    // queue entry #NN: a RunQueueItem
 *                                            // on `run`, a KernelMessage on a
 *                                            // ${kpid} queue
 *
 * Kernel objects
 *   ${koid}.refCount = NN,NN                 // reachable,recognizable counts
 *   ${koid}.owner = ${endid} | kernel        // owner (where the object is)
 *
 * Kernel promises
 *   ${kpid}.refCount = NN                    // reference count
 *   ${kpid}.state = unresolved | fulfilled | rejected  // current state of settlement
 *   ${kpid}.subscribers = JSON([${endid}])   // array of who is waiting for settlement
 *   ${kpid}.decider = ${endid} | kernel      // who decides on settlement
 *   ${kpid}.value = JSON(CAPDATA)            // value settled to, if settled
 *
 * C-lists (both directions share one prefix; see `getCListPrefix`)
 *   ${endid}.c.${eref} = ${kref}             // ERef->KRef mapping
 *   ${endid}.c.${kref} = R|_ ${eref}         // KRef->ERef mapping, plus the
 *                                            // endpoint's reachable flag
 *
 * Vat bookkeeping
 *   e.nextObjectId.${endid} = NN             // allocation counter for imported object ERefs
 *   e.nextPromiseId.${endid} = NN            // allocation counter for imported promise ERefs
 *   vatConfig.${vatid} = JSON(CONFIG)        // vat's configuration object
 *
 * Remote bookkeeping
 *   remote.${remoteId} = JSON(INFO)          // remote's connection info
 *   remoteSeq.${remoteId}.nextSendSeq = NN   // next outgoing sequence number
 *   remoteSeq.${remoteId}.highestReceivedSeq = NN  // highest received seq (for ACK)
 *   remoteSeq.${remoteId}.startSeq = NN      // seq of first pending message
 *   remotePending.${remoteId}.${seq} = ${messageString}  // pending message
 *
 * Kernel bookkeeping
 *   initialized = true                       // if set, indicates the store has been initialized
 *   nextVatId = NN                           // allocation counter for vat IDs
 *   nextRemoteId = NN                        // allocation counter for remote IDs
 *   nextObjectId = NN                        // allocation counter for object KRefs
 *   nextPromiseId = NN                       // allocation counter for promise KRefs
 *   pinned.${kref} = NN                      // number of pins held on ${kref}
 *   ocapURLObjects.${kref} = NN              // number of ocap URLs naming ${kref}
 *   kernelService.${serviceName} = ${koid}   // kref of kernel service object ${serviceName}
 */

import { Fail } from '@endo/errors';
import type { KernelDatabase, KVStore, VatStore } from '@metamask/kernel-store';
import { Logger } from '@metamask/logger';

import type { KRef, VatId } from '../types.ts';
import { getActivityMethods } from './methods/activity.ts';
import { getBaseMethods } from './methods/base.ts';
import { getCListMethods } from './methods/clist.ts';
import { getCrankMethods } from './methods/crank.ts';
import { getGCMethods } from './methods/gc.ts';
import { getIdMethods } from './methods/id.ts';
import { getObjectMethods } from './methods/object.ts';
import { getPinMethods } from './methods/pinned.ts';
import { getPromiseMethods } from './methods/promise.ts';
import { getQueueMethods } from './methods/queue.ts';
import { getReachableMethods } from './methods/reachable.ts';
import { getRefCountAuditMethods } from './methods/refcount-audit.ts';
import { getRefCountMethods } from './methods/refcount.ts';
import { getRelayMethods } from './methods/relay.ts';
import { getRemoteMethods } from './methods/remote.ts';
import { getRevocationMethods } from './methods/revocation.ts';
import { getSubclusterMethods } from './methods/subclusters.ts';
import { getTranslators } from './methods/translators.ts';
import { getVatMethods } from './methods/vat.ts';
import type { StoreContext, StoredValue } from './types.ts';

/**
 * The prefix shared by the issuance count of every object an ocap URL names,
 * for iterating over them. A count per object, rather than one row listing
 * every issuance, because the number of URLs a kernel hands out is bounded by
 * nothing the kernel controls.
 */
const OCAP_URL_PREFIX = 'ocapURLObjects.';

/**
 * Create a new KernelStore object wrapped around a raw kernel database. The
 * resulting object provides a variety of operations for accessing various
 * kernel-relevent persistent data structure abstractions on their own terms,
 * without burdening the kernel with the particular details of how they are
 * represented in storage.  It is our hope that these operations may be later
 * reimplemented on top of a more sophisticated database layer that can realize
 * them more directly (and thus, one hopes, more efficiently) without requiring
 * the kernel itself to be any the wiser.
 *
 * @param kdb - The kernel database this store is based on.
 * @param logger - The logger to use.
 * @returns A KernelStore object that maps various persistent kernel data
 * structures onto `kdb`.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function makeKernelStore(kdb: KernelDatabase, logger?: Logger) {
  // Initialize core state

  /** KV store in which all the kernel's own state is kept. */
  const kv: KVStore = kdb.kernelKVStore;

  const { getPrefixedKeys, provideCachedStoredValue, provideStoredQueue } =
    getBaseMethods(kv);

  /**
   * Every cached stored value the context holds, as `field: [key, initial]`.
   * Declared once so that initialization and `refreshCachedValues` cannot
   * disagree about which values exist: adding one here does both.
   */
  const CACHED_VALUES = {
    /** Counter for allocating kernel object IDs */
    nextObjectId: ['nextObjectId', '1'],
    /** Counter for allocating kernel promise IDs */
    nextPromiseId: ['nextPromiseId', '1'],
    /** Counter for allocating VatIDs */
    nextVatId: ['nextVatId', '1'],
    /** Counter for allocating RemoteIDs */
    nextRemoteId: ['nextRemoteId', '1'],
    // Garbage collection
    gcActions: ['gcActions', '[]'],
    reapQueue: ['reapQueue', '[]'],
    terminatedVats: ['vats.terminated', '[]'],
    // Subclusters
    subclusters: ['subclusters', '[]'],
    nextSubclusterId: ['nextSubclusterId', '1'],
    vatToSubclusterMap: ['vatToSubclusterMap', '{}'],
  } as const satisfies Record<string, readonly [key: string, init: string]>;

  /**
   * Provide a fresh stored value for each of {@link CACHED_VALUES}, reading its
   * current setting out of the database.
   *
   * @returns The stored values, keyed by the context field that holds each.
   */
  function provideCachedValues(): Record<
    keyof typeof CACHED_VALUES,
    StoredValue
  > {
    return Object.fromEntries(
      Object.entries(CACHED_VALUES).map(([field, [key, init]]) => [
        field,
        provideCachedStoredValue(key, init),
      ]),
    ) as Record<keyof typeof CACHED_VALUES, StoredValue>;
  }

  const context: StoreContext = {
    kv,
    /** The kernel's run queue. */
    runQueue: provideStoredQueue('run', true),
    /** Cache of the run queue's current length */
    runQueueLengthCache: -1,
    /** Recreate the run queue from DB state (used after rollback to clear stale caches). */
    refreshRunQueue: () => {
      context.runQueue = provideStoredQueue('run', true);
    },
    ...provideCachedValues(),
    /**
     * Re-read every cached stored value from the database. Each one closes over
     * the last value written through it (see `provideCachedStoredValue`), so
     * reverting the database alone is not enough: the closure would still hold
     * the abandoned value and the next `set` would write it straight back.
     */
    refreshCachedValues: () => {
      Object.assign(context, provideCachedValues());
    },
    // As refcounts are decremented, we accumulate a set of krefs for which
    // action might need to be taken:
    //   * promises which are now resolved and unreferenced can be deleted
    //   * objects which are no longer reachable: export can be dropped
    //   * objects which are no longer recognizable: export can be retired
    // This set is ephemeral: it lives in RAM, grows as deliveries and syscalls
    // cause decrefs, and will be harvested by processRefcounts(). This needs to be
    // called in the same transaction window as the syscalls/etc which prompted
    // the change, else removals might be lost (not performed during the next
    // replay).
    maybeFreeKrefs: new Set<KRef>(),
    inCrank: false,
    savepoints: [],
    crankBuffer: [],
    auditRefCounts: false,
    // Logging
    logger: logger?.subLogger({ tags: ['kernel-store'] }),
  };

  const id = getIdMethods(context);
  const refCount = getRefCountMethods(context);
  const refCountAudit = getRefCountAuditMethods(context);
  const object = getObjectMethods(context);
  const promise = getPromiseMethods(context);
  const revocation = getRevocationMethods(context);
  const gc = getGCMethods(context);
  const cList = getCListMethods(context);
  const queue = getQueueMethods(context);
  const vat = getVatMethods(context);
  const remote = getRemoteMethods(context);
  const reachable = getReachableMethods(context);
  const translators = getTranslators(context);
  const pinned = getPinMethods(context);
  const crank = getCrankMethods(context, kdb);
  const subclusters = getSubclusterMethods(context);
  const activity = getActivityMethods(kv);
  const relay = getRelayMethods({ kv, logger: context.logger });

  /**
   * Create a new VatStore for a vat.
   *
   * @param vatID - The vat for which this is being done.
   *
   * @returns a a VatStore object for the given vat.
   */
  function makeVatStore(vatID: string): VatStore {
    return kdb.makeVatStore(vatID);
  }

  /**
   * Delete all persistent state associated with a vat.
   *
   * @param vatId - The vat whose state is to be deleted.
   */
  function deleteVat(vatId: VatId): void {
    vat.deleteVatConfig(vatId);
    kdb.deleteVatStore(vatId);
    subclusters.removeVatFromSubcluster(vatId);
  }

  /**
   * Reset the kernel's persistent state and reset all counters.
   *
   * @param options - Options for the reset.
   * @param options.except - Keys to not reset. If not provided, all keys will be reset.
   */
  function reset({ except }: { except?: string[] } = {}): void {
    const preservedState = except?.map((key) => ({
      key,
      value: context.kv.get(key),
    }));
    kdb.clear();
    context.maybeFreeKrefs.clear();
    context.refreshRunQueue();
    context.refreshCachedValues();
    crank.releaseAllSavepoints();
    context.crankBuffer.length = 0;
    preservedState?.forEach(({ key, value }) => {
      if (value) {
        context.kv.set(key, value);
      }
    });
  }

  /**
   * Delete everything from the database.
   */
  function clear(): void {
    kdb.clear();
  }

  /**
   * Provide the kernel's incarnation ID.
   * The incarnation ID is persisted so it survives kernel restarts,
   * but is regenerated when storage is cleared (when state is actually lost).
   *
   * @returns The incarnation ID (existing or newly generated).
   */
  function provideIncarnationId(): string {
    const existing = context.kv.get('incarnationId');
    if (existing) {
      return existing;
    }
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    const newId = globalThis.crypto.randomUUID();
    context.kv.set('incarnationId', newId);
    return newId;
  }

  /**
   * Create a savepoint for atomic operations on persistent storage.
   *
   * @param name - The savepoint name.
   */
  function createSavepoint(name: string): void {
    kdb.createSavepoint(name);
  }

  /**
   * Release (commit) a savepoint.
   *
   * @param name - The savepoint name.
   */
  function releaseSavepoint(name: string): void {
    kdb.releaseSavepoint(name);
  }

  /**
   * Rollback to a savepoint.
   *
   * @param name - The savepoint name.
   */
  function rollbackSavepoint(name: string): void {
    kdb.rollbackSavepoint(name);
  }

  return harden({
    ...id,
    ...queue,
    ...refCount,
    ...refCountAudit,
    ...object,
    ...promise,
    ...revocation,
    ...gc,
    ...reachable,
    ...cList,
    ...vat,
    ...remote,
    ...translators,
    ...pinned,
    ...crank,
    ...subclusters,
    ...activity,
    ...relay,
    makeVatStore,
    deleteVat,
    clear,
    reset,
    provideIncarnationId,
    createSavepoint,
    releaseSavepoint,
    rollbackSavepoint,
    // NOTE: kv is intentionally NOT exposed here. All KV access should go
    // through typed store methods to preserve branded type safety.

    // Initialization
    isInitialized(): boolean {
      return kv.get('initialized') === 'true';
    },
    markInitialized(): void {
      kv.set('initialized', 'true');
    },

    // Kernel service krefs
    getKernelServiceKref(name: string): KRef | undefined {
      return kv.get<KRef>(`kernelService.${name}`);
    },
    setKernelServiceKref(name: string, kref: KRef): void {
      kv.set(`kernelService.${name}`, kref);
    },
    deleteKernelServiceKref(name: string): void {
      kv.delete(`kernelService.${name}`);
    },

    // Anonymous kernel-hosted objects
    //
    // Recorded so they can be swept at kernel init. Unlike a named service,
    // an anonymous object has no name to be re-registered under on boot, so
    // one surviving a restart is unreachable but still pinned — and a
    // delivery to it would find nothing registered and kill the run loop.
    // They are used for things like accepted IO connections, which cannot
    // outlive the process anyway.
    getAnonymousKernelObjects(): KRef[] {
      const raw = kv.get('anonymousKernelObjects');
      return raw ? (raw.split(',') as KRef[]) : [];
    },
    addAnonymousKernelObject(kref: KRef): void {
      const krefs = new Set(this.getAnonymousKernelObjects());
      krefs.add(kref);
      kv.set('anonymousKernelObjects', [...krefs].sort().join(','));
    },
    removeAnonymousKernelObject(kref: KRef): void {
      const krefs = new Set(this.getAnonymousKernelObjects());
      if (!krefs.delete(kref)) {
        return;
      }
      if (krefs.size === 0) {
        kv.delete('anonymousKernelObjects');
      } else {
        kv.set('anonymousKernelObjects', [...krefs].sort().join(','));
      }
    },

    // Objects named by an issued ocap URL
    //
    // An ocap URL is a durable bearer token: it carries an encrypted kref and
    // nothing else, so the kernel cannot discover from its own state that a
    // holder exists. Retaining the target is therefore the only thing keeping
    // the URL redeemable, and it has to outlive every other reference — the
    // token is persistent, unexpiring, and may be redeemed by a peer that was
    // not running when it was issued.
    //
    // The ledger counts, per target, how many URLs name it, and holds one pin
    // for as long as that count is nonzero. Counting is what makes overlapping
    // issuances safe: minting awaits, so a second `issue` for the same target
    // can run to completion while the first is still in flight, and the first's
    // failure must then unwind its own issuance without disturbing the
    // retention the second's live URL depends on.
    //
    // Ending a retention comes in two kinds, so it comes in two methods.
    // `undoOcapURLRetention` unwinds one issuance whose URL was never minted
    // and leaves the others standing; `releaseOcapURLRetentions` drops the
    // target's whole retention at once, for disavowing every URL naming it.
    // Revocation is neither: it writes only the revoked flag, so a revoked
    // object's URLs stay retained, redeemable, and undeliverable.
    getOcapURLObjects(): KRef[] {
      return [...getPrefixedKeys(OCAP_URL_PREFIX)].map(
        (key) => key.slice(OCAP_URL_PREFIX.length) as KRef,
      );
    },
    getOcapURLIssuanceCount(kref: KRef): number {
      return Number(kv.get(`${OCAP_URL_PREFIX}${kref}`) ?? 0);
    },
    retainForOcapURL(kref: KRef): void {
      // Refuse to mint a token for something already collected: the URL would
      // name a capability that can never be delivered to. Refusing here names
      // what was attempted, and does it before anything has been written.
      this.kernelRefExists(kref) ||
        Fail`cannot issue an ocap URL for deleted kref ${kref}`;
      const issuances = this.getOcapURLIssuanceCount(kref);
      if (issuances === 0) {
        this.pinObject(kref);
      }
      kv.set(`${OCAP_URL_PREFIX}${kref}`, `${issuances + 1}`);
    },
    undoOcapURLRetention(kref: KRef): void {
      const issuances = this.getOcapURLIssuanceCount(kref);
      if (issuances > 1) {
        kv.set(`${OCAP_URL_PREFIX}${kref}`, `${issuances - 1}`);
        return;
      }
      // The last issuance, or none at all: either way, what is left of the
      // retention is exactly what a release drops.
      this.releaseOcapURLRetentions(kref);
    },
    releaseOcapURLRetentions(kref: KRef): void {
      if (this.getOcapURLIssuanceCount(kref) === 0) {
        return;
      }
      // Spend the pin before forgetting the retention, so a failure to release
      // it leaves a ledger that still says the retention is held.
      this.unpinObject(kref);
      kv.delete(`${OCAP_URL_PREFIX}${kref}`);
    },
  });
}

export type KernelStore = ReturnType<typeof makeKernelStore>;
export type { RelayEntry } from './types.ts';
export type { RefCountViolation } from './methods/refcount-audit.ts';
