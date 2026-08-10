import type { CapData } from '@endo/marshal';

import { getBaseMethods } from './base.ts';
import { getPinMethods } from './pinned.ts';
import type { KRef, KernelMessage, RunQueueItem } from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { parseRef } from '../utils/parse-ref.ts';
import { isPromiseRef } from '../utils/promise-ref.ts';
import { parseReachableAndVatSlot } from '../utils/reachable.ts';

/**
 * A kref whose stored reference counts disagree with the counts implied by the
 * references the kernel can actually be seen to hold.
 */
export type RefCountViolation =
  | {
      /** The kref is still counted, just by the wrong amount. */
      kind: 'mismatch';
      kref: KRef;
      /**
       * The counts as stored, in the store's own encoding:
       * `"reachable,recognizable"` for objects, a single number for promises.
       */
      stored: string;
      /** The counts implied by `holders`, in the same encoding as `stored`. */
      expected: string;
      /** One entry per reference found, so a mismatch can be traced to its source. */
      holders: string[];
    }
  | {
      /**
       * The kref has no refcount entry, so each entry in `holders` names
       * something the kernel has already deleted. Rewriting a count cannot
       * repair this.
       */
      kind: 'dangling';
      kref: KRef;
      /** The counts `holders` imply, which there is nothing left to credit. */
      expected: string;
      /** One entry per dangling reference found. */
      holders: string[];
    };

/**
 * The running total of references found for one kref. For a promise, which has
 * only a single count, that count accumulates in `reachable`.
 */
type Tally = {
  reachable: number;
  recognizable: number;
  holders: string[];
};

/** Matches the kref-keyed half of a c-list entry, e.g. `v1.c.ko3`. */
const CLIST_KREF_KEY = /^([vr]\d+)\.c\.(k[op]\d+)$/u;

/** Matches a queue entry (but not the queue's `head`/`tail` bookkeeping). */
const QUEUE_ENTRY_KEY = /^queue\.([^.]+)\.(\d+)$/u;

/** Matches the state record that exists for every live kernel promise. */
const PROMISE_STATE_KEY = /^(kp\d+)\.state$/u;

/** Matches the refcount record that exists for every live kernel object or promise. */
const REFCOUNT_KEY = /^(k[op]\d+)\.refCount$/u;

/**
 * Get the methods that audit reference counts against ground truth.
 *
 * The kernel's reference counts are a cache: every unit of every count is owed
 * to some reference the kernel is holding somewhere else in the store — a
 * c-list entry, a queued message, a promise's resolution value, a pin. This
 * module recomputes those counts from the references themselves and reports
 * where the cache has drifted, in either direction. Counts that are too low
 * let a live capability be collected; counts that are too high leak it.
 *
 * Only references the kernel can see in its own state are checkable, so a
 * holder that keeps a kref outside them is invisible here and the audit will
 * pronounce its target unreferenced. Anything of that shape has to take a pin
 * to be counted at all — see `retainForOcapURL`, where an issued URL's
 * encrypted kref does exactly that.
 *
 * @param ctx - The store context.
 * @returns The reference count audit methods.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getRefCountAuditMethods(ctx: StoreContext) {
  const { getPrefixedKeys, refCountKey } = getBaseMethods(ctx.kv);
  const { getPinCount, getPinnedObjects } = getPinMethods(ctx);

  /**
   * Render a tally the way the store encodes it, so expected and stored values
   * can be compared and reported as like for like.
   *
   * @param kref - The kref the counts belong to.
   * @param counts - The counts to render.
   * @param counts.reachable - The reachable count (the only count, for a promise).
   * @param counts.recognizable - The recognizable count (ignored for a promise).
   * @returns The encoded counts.
   */
  function renderCounts(
    kref: KRef,
    counts: { reachable: number; recognizable: number },
  ): string {
    return isPromiseRef(kref)
      ? `${counts.reachable}`
      : `${counts.reachable},${counts.recognizable}`;
  }

  /**
   * Read the slots a settled promise's resolution value carries, tolerating a
   * value that is missing or unreadable.
   *
   * @param kpid - The settled promise.
   * @returns Its resolution slots, or none if the value cannot be read.
   */
  function readResolutionSlots(kpid: KRef): KRef[] {
    const raw = ctx.kv.get(`${kpid}.value`);
    if (raw === undefined) {
      return [];
    }
    try {
      // `Array.isArray` rather than a cast asserting `slots` is there: a row
      // that parses but carries no slots array would otherwise return
      // `undefined` for the caller to iterate, throwing outside this `try` —
      // the very crash this exists to prevent — and a row whose `slots` is a
      // string would be iterated character by character, crediting krefs that
      // were never there. A wrong audit is worse than a loud one.
      const { slots } = JSON.parse(raw) as Partial<CapData<KRef>>;
      return Array.isArray(slots) ? slots : [];
    } catch {
      return [];
    }
  }

  /**
   * Walk the whole store and total up, for every kref, the references the
   * kernel is holding to it.
   *
   * The credits below mirror `incrementRefCount` case for case; when that
   * function's rules change, these have to change with it. Two of the rules
   * mirrored here live elsewhere: the unsettled-promise unit is written
   * directly by `initKernelPromise`, and an object import's reachable half is
   * carried by `setReachableFlag`/`clearReachableFlag`, which is why this reads
   * each import entry's flag rather than assuming it.
   *
   * @returns A tally per kref that anything refers to.
   */
  function computeExpectedRefCounts(): Map<KRef, Tally> {
    const tallies = new Map<KRef, Tally>();
    // `retireKernelObjects` deletes an object and queues a `retireImport` for
    // each importer in the same breath, so between then and the delivery an
    // importer's c-list entry legitimately names a kref the kernel has already
    // dropped. Those entries are scheduled for teardown and are not holders.
    const retiring = new Set(
      (JSON.parse(ctx.gcActions.get() ?? '[]') as string[]).filter((action) =>
        action.includes(' retireImport '),
      ),
    );

    const credit = (
      kref: KRef,
      holder: string,
      { onlyRecognizable = false }: { onlyRecognizable?: boolean } = {},
    ): void => {
      let tally = tallies.get(kref);
      if (!tally) {
        tally = { reachable: 0, recognizable: 0, holders: [] };
        tallies.set(kref, tally);
      }
      tally.holders.push(holder);
      if (isPromiseRef(kref)) {
        // Promises have a single count and no reachable/recognizable split.
        tally.reachable += 1;
        return;
      }
      if (!onlyRecognizable) {
        tally.reachable += 1;
      }
      tally.recognizable += 1;
    };

    /**
     * A queued message holds its result promise and every slot it carries.
     *
     * @param message - The queued message.
     * @param holder - Description of the queue entry holding it.
     */
    const creditMessage = (message: KernelMessage, holder: string): void => {
      if (message.result) {
        credit(message.result, `${holder} result`);
      }
      for (const slot of message.methargs.slots) {
        credit(slot, `${holder} slot`);
      }
    };

    for (const key of getPrefixedKeys('')) {
      const clistMatch = CLIST_KREF_KEY.exec(key);
      if (clistMatch) {
        const [, endpointId, kref] = clistMatch as unknown as [
          string,
          string,
          KRef,
        ];
        const { isReachable, vatSlot } = parseReachableAndVatSlot(
          ctx.kv.getRequired(key),
        );
        const { direction } = parseRef(vatSlot);
        const holder = `${endpointId} c-list ${direction} ${vatSlot}`;
        if (isPromiseRef(kref)) {
          // Both directions count for a promise.
          credit(kref, holder);
        } else if (
          direction === 'import' &&
          !retiring.has(`${endpointId} retireImport ${kref}`)
        ) {
          // An object export is the owner's own entry and carries no count;
          // an object import always recognizes and, while flagged, reaches.
          credit(kref, holder, { onlyRecognizable: !isReachable });
        }
        continue;
      }

      const queueMatch = QUEUE_ENTRY_KEY.exec(key);
      if (queueMatch) {
        const [, queueName, seq] = queueMatch as unknown as [
          string,
          string,
          string,
        ];
        const entry = ctx.kv.getRequired(key);
        if (queueName === 'run') {
          const item = JSON.parse(entry) as RunQueueItem;
          if (item.type === 'send') {
            credit(item.target, `run queue #${seq} send target`);
            creditMessage(item.message, `run queue #${seq} send`);
          } else if (item.type === 'notify') {
            credit(item.kpid, `run queue #${seq} notify`);
          }
        } else {
          const kpid = queueName as KRef;
          const message = JSON.parse(entry) as KernelMessage;
          credit(kpid, `${kpid} queue #${seq} target`);
          creditMessage(message, `${kpid} queue #${seq}`);
        }
        continue;
      }

      const promiseMatch = PROMISE_STATE_KEY.exec(key);
      if (promiseMatch) {
        const kpid = promiseMatch[1] as KRef;
        if (ctx.kv.getRequired(key) === 'unresolved') {
          // The unit `initKernelPromise` mints, released when the promise settles.
          credit(kpid, 'unsettled promise');
        } else {
          // A settled promise's stored value is what holds its resolution
          // slots. Read it the way the rest of the kernel does — `gc.ts` and
          // `getKpidsToRetire` both allow a settled promise to have lost its
          // value — rather than requiring it: this exists to report drift, not
          // to die on it, and `getRequired` here would take the whole sweep
          // down over one row. With nothing to credit, whatever those slots
          // still hold is reported as a count too high, which is what it is.
          for (const slot of readResolutionSlots(kpid)) {
            credit(slot, `${kpid} resolution slot`);
          }
        }
      }
    }

    for (const kref of getPinnedObjects()) {
      // One unit per pin: each `pinObject` call increments once, and the
      // object's count is how many of those calls are outstanding.
      for (let pins = getPinCount(kref); pins > 0; pins -= 1) {
        credit(kref, 'pin');
      }
    }

    return tallies;
  }

  /**
   * Collect every kref the store has a refcount entry for.
   *
   * @returns The krefs with refcount entries.
   */
  function getCountedKrefs(): KRef[] {
    const krefs: KRef[] = [];
    for (const key of getPrefixedKeys('')) {
      const match = REFCOUNT_KEY.exec(key);
      if (match) {
        krefs.push(match[1] as KRef);
      }
    }
    return krefs;
  }

  /**
   * Compare every kref's stored reference counts against the references the
   * kernel can be seen to hold.
   *
   * What this can and cannot find is worth being precise about, because the
   * ground truth here *is* the holder set. A count that disagrees with its
   * holders is caught in either direction: too low, and a live capability can be
   * collected; too high with no holder left, and the count itself is orphaned.
   * But a holder that should have been torn down and wasn't justifies its own
   * count — at any value — so a leaked *reference* is invisible to this by
   * construction. A c-list entry that outlives what it names is the case that
   * matters: see the settled-promise TODO in `KernelRouter`.
   *
   * @returns The krefs whose counts disagree with ground truth, in kref order.
   */
  function auditRefCounts(): RefCountViolation[] {
    const expected = computeExpectedRefCounts();
    const violations: RefCountViolation[] = [];
    const krefs = new Set<KRef>([...expected.keys(), ...getCountedKrefs()]);

    for (const kref of [...krefs].sort()) {
      const tally = expected.get(kref) ?? {
        reachable: 0,
        recognizable: 0,
        holders: [],
      };
      const expectedText = renderCounts(kref, tally);
      const raw = ctx.kv.get(refCountKey(kref));
      if (raw === undefined) {
        // The kref has been deleted from the kernel, so anything still
        // pointing at it is a dangling reference.
        if (tally.holders.length > 0) {
          violations.push({
            kind: 'dangling',
            kref,
            expected: expectedText,
            holders: tally.holders,
          });
        }
        continue;
      }
      // The raw row, not `getObjectRefCount`: that `Fail`s on `reachable >
      // recognizable`, which is one of the drifts this exists to report, and
      // would take the whole sweep down with it. Objects store the same
      // `"reachable,recognizable"` encoding `renderCounts` produces, so a
      // malformed row is reported as it stands.
      const storedText = raw;
      if (storedText !== expectedText) {
        violations.push({
          kind: 'mismatch',
          kref,
          stored: storedText,
          expected: expectedText,
          holders: tally.holders,
        });
      }
    }
    return violations;
  }

  /**
   * Overwrite stored reference counts with the counts implied by ground truth.
   *
   * A repair tool for a store whose counts have drifted, offered to embedders
   * and never run automatically: nothing calls it, and opening an existing
   * store does not migrate it. Krefs that are referenced but have already been
   * deleted cannot be repaired this way and are reported instead.
   *
   * Ground truth here means the references the kernel can see in its own
   * state. A holder the store cannot see — an issued ocap URL names its target
   * only inside an encrypted bearer token — is not among them, which is why
   * such a target is pinned when the URL is issued rather than left for this to
   * infer.
   *
   * @returns The violations that were corrected and those that could not be.
   */
  function recomputeRefCounts(): {
    corrected: RefCountViolation[];
    unfixable: RefCountViolation[];
  } {
    const corrected: RefCountViolation[] = [];
    const unfixable: RefCountViolation[] = [];
    for (const violation of auditRefCounts()) {
      if (violation.kind === 'dangling') {
        unfixable.push(violation);
        continue;
      }
      ctx.kv.set(refCountKey(violation.kref), violation.expected);
      if (violation.expected.startsWith('0')) {
        ctx.maybeFreeKrefs.add(violation.kref);
      }
      corrected.push(violation);
    }
    return { corrected, unfixable };
  }

  /**
   * Render violations as a human-readable report.
   *
   * @param violations - The violations to describe.
   * @returns A newline-separated report, one line per violation.
   */
  function formatRefCountViolations(violations: RefCountViolation[]): string {
    return violations
      .map((violation) => {
        const { kref, expected, holders } = violation;
        const stored =
          violation.kind === 'dangling' ? '(deleted)' : violation.stored;
        const held = holders.length > 0 ? holders.join(', ') : 'nothing';
        return `${kref}: stored ${stored}, expected ${expected} (held by: ${held})`;
      })
      .join('\n');
  }

  /**
   * Audit reference counts and throw if any have drifted. Enabled per kernel
   * via the `auditRefCounts` option, and run at the end of every crank.
   */
  function assertRefCountsIfAuditing(): void {
    if (!ctx.refCountAuditingEnabled) {
      return;
    }
    const violations = auditRefCounts();
    if (violations.length > 0) {
      const report = formatRefCountViolations(violations);
      // Logged as well as thrown: if this is the last crank before the kernel
      // goes idle, nobody sends another message and the log is the only record.
      ctx.logger?.error(`reference count invariant violated:\n${report}`);
      throw Error(`reference count invariant violated:\n${report}`);
    }
  }

  /**
   * Turn the per-crank reference count audit on or off.
   *
   * @param enabled - Whether to audit after every crank.
   */
  function setRefCountAuditing(enabled: boolean): void {
    ctx.refCountAuditingEnabled = enabled;
  }

  return {
    auditRefCounts,
    recomputeRefCounts,
    formatRefCountViolations,
    assertRefCountsIfAuditing,
    setRefCountAuditing,
  };
}
