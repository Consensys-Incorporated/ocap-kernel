import type {
  AccountabilityRecordFilter,
  AccountabilityRecordRow,
} from '@metamask/kernel-store';

import { getBaseMethods } from './base.ts';
import { getPinMethods } from './pinned.ts';
import type {
  AccountabilityRecord,
  AccountabilityRecordInput,
  Attribution,
  ConveyanceRecord,
  DeliveryRecord,
  IntroductionRecord,
  ResolutionRecord,
  StoredAttestation,
  TraceContext,
  TrackOptions,
  Trackers,
} from '../../accountability/types.ts';
import type { Segment } from '../../accountability/segments.ts';
import type { EndpointId, KRef, KernelMessage, Sender } from '../../types.ts';
import type { StoreContext } from '../types.ts';

const ATTESTATION_BASE = 'attestation.';
const SEGMENT_BASE = 'segment.';

/**
 * Create an accountability records store object that provides functionality
 * for the kernel's accountability records and the set of tracked objects.
 *
 * @param ctx - The store context.
 * @returns An accountability records store object.
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
    } else if (input.kind === 'resolution') {
      [kref, endpoint] = [input.kpid, input.endpoint];
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
      trace: input.kind === 'introduction' ? null : (input.traceId ?? null),
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
   * The trace fields of a record on a trace.
   *
   * @param trace - The trace, if any.
   * @returns The fields, or none.
   */
  function traced(trace: TraceContext): { traceId: string; hop: number };
  function traced(
    trace: TraceContext | undefined,
  ): { traceId: string; hop: number } | Record<string, never>;
  // eslint-disable-next-line ocap/require-jsdoc
  function traced(
    trace: TraceContext | undefined,
  ): { traceId: string; hop: number } | Record<string, never> {
    return trace === undefined ? {} : { traceId: trace.id, hop: trace.hop };
  }

  /**
   * Record a message delivered to a tracked object, one the host attributed
   * to a party, or one on a trace. The arguments are kept if any tracker
   * asked for them.
   *
   * @param options - Options bag.
   * @param options.target - The object.
   * @param options.targetEndpoint - The endpoint it was delivered to.
   * @param options.sender - Who sent the message.
   * @param options.cause - The crank the message was issued in.
   * @param options.method - The method invoked.
   * @param options.message - The message.
   * @param options.attribution - What the host said about the act, if anything.
   * @param options.trace - The trace the message carried, if any.
   */
  function recordDelivery({
    target,
    targetEndpoint,
    sender,
    cause,
    method,
    message,
    attribution,
    trace,
  }: Pick<DeliveryRecord, 'target' | 'targetEndpoint' | 'sender' | 'cause'> & {
    method: string;
    message: KernelMessage;
    attribution?: Attribution | undefined;
    trace?: TraceContext | undefined;
  }): void {
    const recordArgs = Object.values(getTrackers(target)).some(
      (options) => options.recordArgs,
    );
    appendAccountabilityRecord({
      kind: 'delivery',
      ...traced(trace),
      target,
      targetEndpoint,
      sender,
      cause,
      method,
      slots: [...new Set(message.methargs.slots)],
      result: message.result ?? null,
      ...(recordArgs ? { args: message.methargs } : {}),
      wallClock: Date.now(),
      ...(attribution?.onBehalfOf === undefined
        ? {}
        : { onBehalfOf: attribution.onBehalfOf }),
      ...(attribution?.intent === undefined
        ? {}
        : { intent: attribution.intent }),
    });
  }

  /**
   * Record a tracked object carried to an endpoint.
   *
   * @param conveyance - The conveyance.
   * @param conveyance.trace - The trace it rode on, if any.
   */
  function recordConveyance({
    trace,
    ...conveyance
  }: Omit<
    AccountabilityRecordInput<ConveyanceRecord>,
    'kind' | 'traceId' | 'hop'
  > & { trace?: TraceContext | undefined }): void {
    appendAccountabilityRecord({
      kind: 'conveyance',
      ...traced(trace),
      ...conveyance,
    });
  }

  /**
   * Record an endpoint being told of a settled promise, on a trace.
   *
   * @param resolution - The resolution.
   * @param resolution.trace - Its trace.
   */
  function recordResolution({
    trace,
    ...resolution
  }: Omit<
    AccountabilityRecordInput<ResolutionRecord>,
    'kind' | 'traceId' | 'hop'
  > & { trace: TraceContext }): void {
    appendAccountabilityRecord({
      kind: 'resolution',
      ...traced(trace),
      ...resolution,
    });
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

  /**
   * Keep an attestation. One the kernel already holds, by its signature, is
   * not kept twice.
   *
   * @param attestation - The attestation.
   */
  function addAttestation(attestation: StoredAttestation): void {
    const key = `${ATTESTATION_BASE}${attestation.kind}.${attestation.subject}`;
    const held = getAttestations({
      kind: attestation.kind,
      subject: attestation.subject,
    });
    if (held.some(({ signature }) => signature === attestation.signature)) {
      return;
    }
    ctx.kv.set(key, JSON.stringify([...held, attestation]));
  }

  /**
   * Read attestations.
   *
   * @param filter - Which attestations; all of them if omitted.
   * @param filter.kind - Of this kind.
   * @param filter.subject - About this subject.
   * @returns The attestations.
   */
  function getAttestations({
    kind,
    subject,
  }: {
    kind?: StoredAttestation['kind'];
    subject?: string;
  } = {}): StoredAttestation[] {
    const parse = (key: string): StoredAttestation[] => {
      const raw = ctx.kv.get(key);
      return raw === undefined ? [] : (JSON.parse(raw) as StoredAttestation[]);
    };
    if (kind !== undefined && subject !== undefined) {
      return parse(`${ATTESTATION_BASE}${kind}.${subject}`);
    }
    const prefix =
      kind === undefined ? ATTESTATION_BASE : `${ATTESTATION_BASE}${kind}.`;
    return [...getPrefixedKeys(prefix)]
      .flatMap(parse)
      .filter(
        (attestation) =>
          subject === undefined || attestation.subject === subject,
      );
  }

  /**
   * Keep the segments an object came with from the peer that owns it,
   * replacing any it came with before.
   *
   * @param kref - The object.
   * @param segments - The segments, as verified.
   */
  function setSegments(kref: KRef, segments: Segment[]): void {
    ctx.kv.set(`${SEGMENT_BASE}${kref}`, JSON.stringify(segments));
  }

  /**
   * Read the segments an object came with.
   *
   * @param kref - The object.
   * @returns The segments, from the peer's own back to the origin's; none
   * for an object that came with none, or did not come from a peer.
   */
  function getSegments(kref: KRef): Segment[] {
    const raw = ctx.kv.get(`${SEGMENT_BASE}${kref}`);
    return raw === undefined ? [] : (JSON.parse(raw) as Segment[]);
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
    recordResolution,
    getAccountabilityRecords,
    pruneAccountabilityRecords,
    setIntroductionRecording,
    addAttestation,
    getAttestations,
    setSegments,
    getSegments,
  };
}
