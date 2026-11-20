import type { CapData } from '@endo/marshal';
import {
  boolean,
  exactOptional,
  literal,
  number,
  object,
  refine,
  string,
  union,
} from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';
import { JsonStruct } from '@metamask/utils';

import type { Cause, EndpointId, KRef, Sender } from '../types.ts';

/**
 * An identifier for a party, opaque to the kernel but for its scheme, the
 * part before the first colon, which names the way its signatures are
 * verified: `ed25519:<hex public key>` is built in, and a host supplies the
 * rest.
 */
export const PartyRefStruct = refine(
  string(),
  'PartyRef',
  (value) =>
    value.indexOf(':') > 0 ||
    `Expected a party identifier with a scheme prefix, but received: ${JSON.stringify(value)}`,
);

export type PartyRef = Infer<typeof PartyRefStruct>;

/**
 * A party's signed statement. An `operator` attestation answers for a kernel,
 * named by its peer ID; an `implementer` attestation answers for a bundle,
 * named by its content hash; an `intent` attestation is a party's statement
 * that it meant one act, named by its target, and rides in with the
 * `queueMessage` that performs it. The party signs the canonical JSON of the
 * other four fields.
 */
export const AttestationStruct = object({
  kind: union([literal('operator'), literal('implementer'), literal('intent')]),
  subject: string(),
  party: PartyRefStruct,
  payload: JsonStruct,
  /** Hex, by the party's key. */
  signature: string(),
});

export type Attestation = Infer<typeof AttestationStruct>;

/** What a party signs: an attestation without its signature. */
export type AttestationClaim = Omit<Attestation, 'signature'>;

export const IntentStruct = object({
  ...AttestationStruct.schema,
  kind: literal('intent'),
});

export type Intent = Infer<typeof IntentStruct>;

/**
 * An attestation the kernel holds. One answering for this kernel carries the
 * kernel's countersignature, which proves possession of the key behind the
 * peer ID the party answers for.
 */
export const StoredAttestationStruct = object({
  ...AttestationStruct.schema,
  countersignature: exactOptional(
    object({ signer: string(), incarnationId: string(), signature: string() }),
  ),
});

export type StoredAttestation = Infer<typeof StoredAttestationStruct>;

/**
 * What the host says about an act it performs through `queueMessage`:
 * which party, among those the operator answers for, it was done for, and
 * that party's signed intent, if the act warranted one.
 */
export const AttributionStruct = object({
  onBehalfOf: exactOptional(PartyRefStruct),
  intent: exactOptional(IntentStruct),
});

export type Attribution = Infer<typeof AttributionStruct>;

/** The number of hops a trace records unless told otherwise. */
export const DEFAULT_HOP_LIMIT = 8;

/**
 * What a trace is asked to be when it starts: how many hops to follow the
 * root act for, `DEFAULT_HOP_LIMIT` if unsaid.
 */
export const TraceOptionsStruct = object({
  hopLimit: exactOptional(number()),
});

export type TraceOptions = Infer<typeof TraceOptionsStruct>;

/**
 * A trace in flight: carried by every send and resolution a traced crank
 * issues, one hop further than the delivery that crank handled, until the
 * hop count reaches the limit. The limit travels with the trace, so a trace
 * that crosses to another kernel keeps counting from where it was.
 */
export const TraceContextStruct = object({
  id: string(),
  hop: number(),
  hopLimit: number(),
});

export type TraceContext = Infer<typeof TraceContextStruct>;

/**
 * What the host passes with a `queueMessage`: its attribution of the act,
 * and whether to trace what the act causes.
 */
export const QueueMessageOptionsStruct = object({
  ...AttributionStruct.schema,
  trace: exactOptional(TraceOptionsStruct),
});

export type QueueMessageOptions = Infer<typeof QueueMessageOptionsStruct>;

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

/** The trace a record is part of, if any. */
type Traced = {
  traceId?: string;
  hop?: number;
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

/** A message delivered to a tracked object, attributed by the host, or traced. */
export type DeliveryRecord = AccountabilityRecordBase &
  Traced & {
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
    /** The party the host did this for, if it said. */
    onBehalfOf?: PartyRef;
    /** The party's signed intent, if the host passed one. */
    intent?: Intent;
  };

/** A tracked object carried to an endpoint in a message or a resolution. */
export type ConveyanceRecord = AccountabilityRecordBase &
  Traced & {
    kind: 'conveyance';
    kref: KRef;
    sender: Sender;
    to: EndpointId | 'kernel';
    via: 'message' | 'notify';
    /** The message's target or the resolved promise. */
    carrier: KRef;
  };

/** An endpoint told of a settled promise, on a trace. */
export type ResolutionRecord = AccountabilityRecordBase &
  Required<Traced> & {
    kind: 'resolution';
    kpid: KRef;
    endpoint: EndpointId;
    /** Who settled it. */
    sender: Sender;
    rejected: boolean;
    /** The references the value carried, each once. */
    slots: KRef[];
  };

export type AccountabilityRecord =
  | IntroductionRecord
  | DeliveryRecord
  | ConveyanceRecord
  | ResolutionRecord;

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
 * the one party already entitled to hear them. `trace` has each delivery to
 * the object start a trace, so that what the object does in response is
 * recorded too.
 */
export const TrackOptionsStruct = object({
  recordArgs: exactOptional(boolean()),
  /** Start a trace from each delivery to the object. */
  trace: exactOptional(TraceOptionsStruct),
});

export type TrackOptions = Infer<typeof TrackOptionsStruct>;

/** Which endpoints track an object, and what each asked for. */
export type Trackers = Record<string, TrackOptions>;
