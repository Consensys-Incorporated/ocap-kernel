import type {
  AccountabilityRecordFilter,
  AccountabilityRecordRow,
} from '@metamask/kernel-store';

import { getBaseMethods } from './base.ts';
import { getPinMethods } from './pinned.ts';
import type {
  AccountabilityRecord,
  AccountabilityRecordInput,
  ConveyanceRecord,
  DeliveryRecord,
  IntroductionRecord,
  TrackOptions,
  Trackers,
} from '../../accountability/types.ts';
import type { EndpointId, KRef, KernelMessage, Sender } from '../../types.ts';
import type { StoreContext } from '../types.ts';

/**
 * Create a records store object that provides functionality for the kernel's
 * accountability records and the set of tracked objects.
 *
 * @param ctx - The store context.
 * @returns A records store object.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getAccountabilityRecordMethods(ctx: StoreContext) {
  const { getTrackedKey, getTrackerPrefix, getTrackerKey, getPrefixedKeys } =
    getBaseMethods(ctx.kv);
  const { pinObject, unpinObject } = getPinMethods(ctx);

  /**
   * Get who tracks an object.
   *
   * @param kref - The object.
   * @returns The trackers, keyed by endpoint, with what each asked for.
   */
  function getTrackers(kref: KRef): Trackers {
    const raw = ctx.kv.get(getTrackedKey(kref));
    return raw === undefined ? {} : (JSON.parse(raw) as Trackers);
  }

  /**
   * Check whether anyone tracks an object.
   *
   * @param kref - The object.
   * @returns True if it is tracked.
   */
  function isTracked(kref: KRef): boolean {
    return ctx.kv.get(getTrackedKey(kref)) !== undefined;
  }

  /**
   * Start recording what is done with an object, on behalf of one of its
   * holders. A holder tracking it again replaces what it asked for.
   *
   * Tracking pins the object. The owner's own export counts for nothing, so
   * an object only its owner holds is collected, and its next export gets a
   * new kref, under which it is not tracked. The pin lasts no longer than the
   * trackers and the owner: a deleted endpoint's tracking goes with it, and
   * an orphaned object's with its owner.
   *
   * @param kref - The object.
   * @param tracker - The holder.
   * @param options - What to record.
   */
  function trackObject(
    kref: KRef,
    tracker: Sender,
    options: TrackOptions = {},
  ): void {
    const trackers = getTrackers(kref);
    if (Object.keys(trackers).length === 0) {
      pinObject(kref);
    }
    trackers[tracker] = options;
    ctx.kv.set(getTrackedKey(kref), JSON.stringify(trackers));
    ctx.kv.set(getTrackerKey(tracker, kref), '1');
  }

  /**
   * Stop recording what is done with an object on behalf of one of its
   * holders. The object stays tracked while any other holder tracks it.
   *
   * @param kref - The object.
   * @param tracker - The holder.
   * @returns True if the holder was tracking it.
   */
  function untrackObject(kref: KRef, tracker: Sender): boolean {
    const trackers = getTrackers(kref);
    if (!(tracker in trackers)) {
      return false;
    }
    delete trackers[tracker];
    ctx.kv.delete(getTrackerKey(tracker, kref));
    if (Object.keys(trackers).length === 0) {
      ctx.kv.delete(getTrackedKey(kref));
      unpinObject(kref);
    } else {
      ctx.kv.set(getTrackedKey(kref), JSON.stringify(trackers));
    }
    return true;
  }

  /**
   * Stop tracking an object on behalf of everyone, when its owner is being
   * cleaned up. The records stay.
   *
   * @param kref - The object.
   */
  function untrackAll(kref: KRef): void {
    for (const tracker of Object.keys(getTrackers(kref))) {
      untrackObject(kref, tracker as Sender);
    }
  }

  /**
   * Stop tracking everything an endpoint tracks, when it is being deleted.
   *
   * @param endpoint - The endpoint.
   */
  function untrackEndpoint(endpoint: EndpointId): void {
    const prefix = getTrackerPrefix(endpoint);
    // Snapshot the keys: untracking deletes them while they are walked.
    for (const key of [...getPrefixedKeys(prefix)]) {
      untrackObject(key.slice(prefix.length) as KRef, endpoint);
    }
  }

  /**
   * Write a record, stamped with the current crank and the kernel as witness.
   *
   * @param input - The record.
   * @returns Its sequence number.
   */
  function appendAccountabilityRecord(
    input: AccountabilityRecordInput,
  ): number {
    let kref: KRef;
    let endpoint: string;
    if (input.kind === 'delivery') {
      [kref, endpoint] = [input.target, input.targetEndpoint];
    } else if (input.kind === 'conveyance') {
      [kref, endpoint] = [input.kref, input.to];
    } else {
      [kref, endpoint] = [input.kref, input.endpoint];
    }
    const crankNumber = Number(ctx.crankNumber.get());
    return ctx.accountabilityRecords.append({
      kind: input.kind,
      witness: 'kernel',
      crank: crankNumber,
      kref,
      endpoint,
      sender: input.sender,
      trace: null,
      data: JSON.stringify({ ...input, witness: 'kernel', crankNumber }),
    });
  }

  /**
   * Record an endpoint's first acquisition of an object, as carried by the
   * crank in progress.
   *
   * @param options - Options bag.
   * @param options.kref - The object.
   * @param options.endpoint - The endpoint acquiring it.
   */
  function recordIntroduction({
    kref,
    endpoint,
  }: {
    kref: KRef;
    endpoint: EndpointId;
  }): void {
    const delivery = ctx.currentDelivery;
    const record: AccountabilityRecordInput<IntroductionRecord> =
      delivery === undefined || delivery.via === 'ocap-url'
        ? {
            kind: 'introduction',
            kref,
            endpoint,
            sender: null,
            via: delivery?.via ?? 'unknown',
          }
        : {
            kind: 'introduction',
            kref,
            endpoint,
            sender: delivery.sender,
            via: delivery.via,
          };
    appendAccountabilityRecord(record);
  }

  /**
   * Record a message delivered to a tracked object. The arguments are kept if
   * any tracker asked for them.
   *
   * @param options - Options bag.
   * @param options.target - The object.
   * @param options.targetEndpoint - The endpoint it was delivered to.
   * @param options.sender - Who sent the message.
   * @param options.cause - The crank the message was issued in.
   * @param options.method - The method invoked.
   * @param options.message - The message.
   */
  function recordDelivery({
    target,
    targetEndpoint,
    sender,
    cause,
    method,
    message,
  }: Pick<DeliveryRecord, 'target' | 'targetEndpoint' | 'sender' | 'cause'> & {
    method: string;
    message: KernelMessage;
  }): void {
    const recordArgs = Object.values(getTrackers(target)).some(
      (options) => options.recordArgs,
    );
    appendAccountabilityRecord({
      kind: 'delivery',
      target,
      targetEndpoint,
      sender,
      cause,
      method,
      slots: [...new Set(message.methargs.slots)],
      result: message.result ?? null,
      ...(recordArgs ? { args: message.methargs } : {}),
      wallClock: Date.now(),
    });
  }

  /**
   * Record a tracked object carried to an endpoint.
   *
   * @param conveyance - The conveyance.
   */
  function recordConveyance(
    conveyance: Omit<AccountabilityRecordInput<ConveyanceRecord>, 'kind'>,
  ): void {
    appendAccountabilityRecord({ kind: 'conveyance', ...conveyance });
  }

  /**
   * Read records, in the order written.
   *
   * @param filter - Which records; all of them if omitted.
   * @returns The records.
   */
  function getAccountabilityRecords(
    filter?: AccountabilityRecordFilter,
  ): AccountabilityRecord[] {
    return ctx.accountabilityRecords
      .query(filter)
      .map((row: AccountabilityRecordRow): AccountabilityRecord => ({
        ...(JSON.parse(row.data) as AccountabilityRecord),
        seq: row.seq,
      }));
  }

  /**
   * Delete records. Nothing else does.
   *
   * @param filter - Which records; all of them if omitted.
   * @returns How many were deleted.
   */
  function pruneAccountabilityRecords(
    filter?: AccountabilityRecordFilter,
  ): number {
    return ctx.accountabilityRecords.delete(filter);
  }

  /**
   * Turn the recording of introductions on or off.
   *
   * @param enabled - Whether to record them.
   */
  function setIntroductionRecording(enabled: boolean): void {
    ctx.recordIntroductions = enabled;
  }

  return {
    getTrackers,
    isTracked,
    trackObject,
    untrackObject,
    untrackAll,
    untrackEndpoint,
    recordIntroduction,
    recordDelivery,
    recordConveyance,
    getAccountabilityRecords,
    pruneAccountabilityRecords,
    setIntroductionRecording,
  };
}
