import { IntentionalCloseError } from '../errors/IntentionalCloseError.ts';
import { NetworkStoppedError } from '../errors/NetworkStoppedError.ts';
import { PeerRestartedError } from '../errors/PeerRestartedError.ts';

/**
 * Names of the sentinel errors that mean retransmit/retry should abort —
 * derived from the classes themselves so adding a new terminal class without
 * registering it would be an obvious omission rather than a silent drift.
 *
 * Detection uses `name` (not `instanceof`) because errors cross the
 * platform-services RPC boundary as serialized JSON-RPC error envelopes
 * that don't preserve class identity. The `name` field is preserved.
 */
const TERMINAL_NAMES: ReadonlySet<string> = new Set([
  PeerRestartedError.name,
  IntentionalCloseError.name,
  NetworkStoppedError.name,
]);

/**
 * Whether a thrown send-side error is a terminal verdict from the transport
 * (peer restart, intentional close, network stopped). Recipients should
 * abort retransmit instead of retrying and, for any but a peer restart,
 * reject pending state.
 *
 * @param error - The error thrown by `sendRemoteMessage`.
 * @returns True if the error is a terminal verdict.
 */
export function isTerminalSendError(error: unknown): boolean {
  return error instanceof Error && TERMINAL_NAMES.has(error.name);
}
