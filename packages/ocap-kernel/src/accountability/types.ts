import type { CapData } from '@endo/marshal';
import { boolean, exactOptional, object } from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';

import type { Cause, EndpointId, KRef, Sender } from '../types.ts';

/**
 * The layer vouching for a record. The kernel saw what a kernel-witnessed
 * record describes on its own paths. Liveslots runs in the vat process, where
 * the vat could in principle have interfered with it. A vat-witnessed record
 * is the vat's own assertion.
 */
export type Witness = 'kernel' | 'liveslots' | 'vat';

type AccountabilityRecordBase = {
  /** The record's place in the kernel's records, in the order written. */
  seq: number;
  witness: Witness;
  /** The crank the record was written in. */
  crankNumber: number;
};

/** An endpoint's first acquisition of an object. */
export type IntroductionRecord = AccountabilityRecordBase & {
  kind: 'introduction';
  kref: KRef;
  endpoint: EndpointId;
  /**
   * Who conveyed it. Null for an ocap URL redemption, which has no sender,
   * and for an acquisition on a path that does not say how it hands out
   * references, which is `'unknown'`.
   */
  sender: Sender | null;
  via: 'message' | 'notify' | 'ocap-url' | 'unknown';
};

/** A message delivered to a tracked object. */
export type DeliveryRecord = AccountabilityRecordBase & {
  kind: 'delivery';
  target: KRef;
  targetEndpoint: EndpointId | 'kernel';
  sender: Sender;
  cause: Cause;
  method: string;
  /** The references the message carried, each once. */
  slots: KRef[];
  result: KRef | null;
  /** The message's arguments, if a tracker asked for them. */
  args?: CapData<KRef>;
  /** When the kernel delivered it, in epoch milliseconds. */
  wallClock: number;
};

/** A tracked object carried to an endpoint in a message or a resolution. */
export type ConveyanceRecord = AccountabilityRecordBase & {
  kind: 'conveyance';
  kref: KRef;
  sender: Sender;
  to: EndpointId | 'kernel';
  via: 'message' | 'notify';
  /** The message's target or the resolved promise. */
  carrier: KRef;
};

export type AccountabilityRecord =
  | IntroductionRecord
  | DeliveryRecord
  | ConveyanceRecord;

/** A record as written, before the store numbers and stamps it. */
export type AccountabilityRecordInput<
  Kind extends AccountabilityRecord = AccountabilityRecord,
> = Kind extends AccountabilityRecord
  ? Omit<Kind, 'seq' | 'witness' | 'crankNumber'>
  : never;

/**
 * What a tracker asks to have recorded. `recordArgs` keeps the arguments of
 * each message delivered to the object, and only the owner may ask for it:
 * the arguments are what other holders say to the object, and the owner is
 * the one party already entitled to hear them.
 */
export const TrackOptionsStruct = object({
  recordArgs: exactOptional(boolean()),
});

export type TrackOptions = Infer<typeof TrackOptionsStruct>;

/** Which endpoints track an object, and what each asked for. */
export type Trackers = Record<string, TrackOptions>;
