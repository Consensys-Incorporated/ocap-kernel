import { assert, Fail } from '@endo/errors';
import { passStyleOf, makeMarshal } from '@endo/marshal';
import type { CapData } from '@endo/marshal';
import type { Passable } from '@endo/pass-style';
import type {
  ExpectedKernelErrorCode,
  FatalKernelErrorCode,
} from '@metamask/kernel-errors';
import { makeDefaultExo } from '@metamask/kernel-utils';

import { insistKRef } from '../types.ts';
import type { KRef } from '../types.ts';

// Simple wrapper for serializing and unserializing marshalled values inside the
// kernel, where we don't actually want to use clists nor actually allocate real
// objects, but instead to stay entirely within the domain of krefs.  This is
// used to enable syntactic manipulation of serialized values while remaining
// agnostic about the internal details of the serialization encoding.

type ObjectStandin = {
  getKref: () => KRef;
  iface: () => string;
};
export type SlotValue = ObjectStandin | Promise<unknown>;

const { toStringTag } = Symbol;

/**
 * Create a promise as a standin object for a kpid. This is never actually used
 * as a promise; its job is just to carry the kref as a tag while at the same
 * time looking to passStyleOf as if it's a Promise.
 *
 * @param kref - A KRef string to tag the result with.
 *
 * @returns A nominal Promise object tagged with `kref`.
 */
// oxlint-disable-next-line typescript/promise-function-async
function makeStandinPromise(kref: KRef): Promise<unknown> {
  const standinP = Promise.resolve(`${kref} stand in`);
  // oxlint-disable-next-line typescript/no-floating-promises
  Object.defineProperty(standinP, toStringTag, {
    value: kref,
    enumerable: false,
  });
  return harden(standinP);
}

/**
 * Extract the tagged `kref` from a standin promise.
 *
 * @param promise - A promise that has previously been labelled via `makeStandinPromise`.
 *
 * @returns The KRef tag that `promise` carries.
 */
function getStandinPromiseTag(promise: Promise<unknown>): KRef {
  const desc = Object.getOwnPropertyDescriptor(promise, toStringTag);
  assert(desc !== undefined, 'promise lacks own @@toStringTag property');
  const kref = desc.value;
  insistKRef(kref);
  return kref;
}

/**
 * Obtain a value serializable via `kser` for a given KRef.
 *
 * @param kref - The KRef string to get a value for.
 * @param iface - Option interface type descriptor string.
 *
 * @returns A `kser` serializable value for `kref`.
 */
export function kslot(kref: KRef, iface: string = 'undefined'): SlotValue {
  insistKRef(kref);
  if (iface?.startsWith('Alleged: ')) {
    // Encoder prepends "Alleged: " to iface string, but the decoder doesn't strip it
    // Unclear whether it's the decoder or me who is wrong
    // oxlint-disable-next-line no-param-reassign
    iface = iface.slice(9);
  }
  if (kref.startsWith('kp')) {
    return makeStandinPromise(kref);
  }
  const standinObject = makeDefaultExo(iface, {
    iface: () => iface,
    getKref: () => kref,
  });
  return standinObject;
}

/**
 * Obtain the KRef associated with a value that was serialized with `kser`.
 *
 * @param obj - The value of interest.
 *
 * @returns a KRef string for `obj`.
 */
export function krefOf(obj: SlotValue): KRef {
  switch (passStyleOf(obj) as string) {
    case 'promise': {
      return getStandinPromiseTag(obj as Promise<unknown>);
    }
    case 'remotable': {
      const { getKref } = obj as ObjectStandin;
      assert.typeof(getKref, 'function', 'object lacks getKref function');
      return getKref.apply(obj, []);
    }
    default:
      // When krefOf() is called as part of kmarshal.serialize, marshal
      // will only give it things that are 'remotable' (Promises and the
      // Exo objects created by kslot()).  When krefOf() is called by
      // kernel code, it ought to throw if 'obj' is not one of the
      // objects created by our kslot().
      return Fail`krefOf requires a promise or remotable`;
  }
}

const kmarshal = makeMarshal(krefOf, kslot, {
  serializeBodyFormat: 'smallcaps',
  errorTagging: 'off',
});

/**
 * Serialize a value in kernel space.
 *
 * @param value - The value to be serialized.
 *
 * @returns a capdata object that can be deserialized with `kunser`.
 */
export function kser(value: unknown): CapData<KRef> {
  return kmarshal.toCapData(harden(value as Passable));
}

/**
 * Deserialize a value that was serialized with `kser`.
 *
 * @param serializedValue -- The value to deserialize.
 *
 * @returns the deserialization of `serializedValue`.
 */
export function kunser(serializedValue: CapData<KRef>): unknown {
  return kmarshal.fromCapData(serializedValue);
}

/**
 * Produce a serialized expected kernel error with a machine-readable code.
 * The resulting error message has the format `[KERNEL:<CODE>] <detail>`.
 *
 * @param code - The expected kernel error code.
 * @param detail - A human-readable description.
 * @returns The serialized error.
 */
export function makeKernelError(
  code: ExpectedKernelErrorCode,
  detail: string,
): CapData<KRef> {
  return kser(Error(`[KERNEL:${code}] ${detail}`));
}

/**
 * Produce a serialized fatal kernel error with a machine-readable code.
 * The resulting error message has the format `[KERNEL:VAT_FATAL:<CODE>] <detail>`.
 *
 * @param code - The fatal kernel error code.
 * @param detail - A human-readable description.
 * @returns The serialized error.
 */
export function makeFatalKernelError(
  code: FatalKernelErrorCode,
  detail: string,
): CapData<KRef> {
  return kser(Error(`[KERNEL:VAT_FATAL:${code}] ${detail}`));
}
