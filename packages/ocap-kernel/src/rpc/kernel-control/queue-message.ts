import type { MethodSpec, Handler } from '@metamask/kernel-rpc-methods';
import { tuple, string, array } from '@metamask/superstruct';
import { UnsafeJsonStruct } from '@metamask/utils';
import type { Json } from '@metamask/utils';

import type { Kernel } from '../../Kernel.ts';
import { kslot } from '../../liveslots/kernel-marshal.ts';
import type { KRef, QueueMessageResult } from '../../types.ts';
import {
  insistKRef,
  KRefStruct,
  QueueMessageResultStruct,
} from '../../types.ts';

/**
 * Enqueue a message to a vat via the kernel's crank queue.
 */
export const queueMessageSpec: MethodSpec<
  'queueMessage',
  [KRef, string, Json[]],
  QueueMessageResult
> = {
  method: 'queueMessage',
  params: tuple([KRefStruct, string(), array(UnsafeJsonStruct)]),
  result: QueueMessageResultStruct,
};

export type QueueMessageHooks = {
  kernel: Pick<Kernel, 'queueMessage'>;
};

/**
 * Reference-marker sigil. In the JSON args arriving over this RPC, a
 * string of the form `@@NAME` (where `NAME` is one or more
 * alphanumeric characters) is interpreted as an object-reference
 * marker naming the kernel object with that reference. The marker is
 * expanded to a `kslot` standin so the kernel's serializer (`kser`)
 * encodes it as a real CapData slot in the dispatched message.
 *
 * The sigil convention exists because JSON has no native way to
 * express an object reference. External callers (plugin code
 * speaking JSON over the daemon socket, CLI users typing message
 * sends at a terminal, test harnesses composing RPC calls) can name
 * a live kernel object without having to synthesize a remotable.
 * Internal callers of `Kernel.queueMessage` never traffic in
 * markers and are unaffected.
 *
 * NAME currently must be a well-formed kref (`ko\d+` or `kp\d+`);
 * a future registry mapping symbolic names to krefs could accept
 * richer names here while preserving the sigil syntax.
 *
 * Caveat: a legitimate string argument that begins with `@@`
 * followed by alphanumerics will be misinterpreted as a reference
 * marker. Callers that need to send such a literal string must
 * wrap it inside an object or otherwise structure it so the sigil
 * appears in a context where it isn't the whole string value.
 */
const REF_SIGIL_PATTERN = /^@@([A-Za-z0-9]+)$/u;

/**
 * Walk `value` and replace every reference-marker string
 * (`"@@NAME"`) with a corresponding `kslot(kref)` standin. Arrays
 * and plain object records are walked recursively.
 *
 * The input is guaranteed to be JSON-parsed data at this layer
 * (queueMessage's `params` type is `Json[]`), so there are no live
 * remotables, promises, or other exotic passables to protect: every
 * value is either JSON data or a marker string. Any hardened kslot
 * standins the walker introduces will be hardened again as part of
 * kser's normal serialization pass.
 *
 * @param value - The value to walk.
 * @returns A value with markers expanded to kslot standins.
 */
function expandRefMarkers(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = REF_SIGIL_PATTERN.exec(value);
    if (!match) {
      return value;
    }
    const kref = match[1] as string;
    insistKRef(kref);
    return kslot(kref);
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandRefMarkers(item));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    out[key] = expandRefMarkers(val);
  }
  return out;
}

export const queueMessageHandler: Handler<
  'queueMessage',
  [KRef, string, Json[]],
  Promise<QueueMessageResult>,
  QueueMessageHooks
> = {
  ...queueMessageSpec,
  hooks: { kernel: true },
  implementation: async (
    { kernel }: QueueMessageHooks,
    [target, method, args],
  ): Promise<QueueMessageResult> => {
    const expandedArgs = expandRefMarkers(args) as unknown[];
    return kernel.queueMessage(target, method, expandedArgs);
  },
};
