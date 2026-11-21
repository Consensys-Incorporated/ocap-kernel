import { toHex } from '@metamask/kernel-utils';

import { DEFAULT_HOP_LIMIT } from './types.ts';
import type { TraceContext, TraceOptions } from './types.ts';

/**
 * Start a trace at a root act.
 *
 * @param options - What the trace is asked to be.
 * @returns The trace, at its first hop.
 */
export function startTrace(options: TraceOptions = {}): TraceContext {
  return harden({
    id: toHex(globalThis.crypto.getRandomValues(new Uint8Array(16))),
    hop: 0,
    hopLimit: options.hopLimit ?? DEFAULT_HOP_LIMIT,
  });
}

/**
 * The trace a crank's sends and resolutions carry: the one its delivery
 * carried, one hop further, unless that reaches the limit.
 *
 * @param trace - The delivery's trace, if any.
 * @returns The trace to carry on, or undefined if there is none or it has
 * reached its limit.
 */
export function nextHop(
  trace: TraceContext | undefined,
): TraceContext | undefined {
  if (trace === undefined || trace.hop + 1 >= trace.hopLimit) {
    return undefined;
  }
  return harden({ ...trace, hop: trace.hop + 1 });
}
