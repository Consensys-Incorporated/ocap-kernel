import {
  assert,
  literal,
  never,
  object,
  optional,
} from '@metamask/superstruct';

import { BaseError } from '../BaseError.ts';
import { marshaledErrorSchema, ErrorCode } from '../constants.ts';
import type { ErrorOptionsWithStack, MarshaledOcapError } from '../types.ts';

/**
 * Sentinel error thrown by `sendRemoteMessage` when the outbound handshake
 * detects the peer has restarted. The peer is reachable but its incarnation
 * changed; the freshly dialed channel is closed without registration to
 * keep stale payloads off the wire. Recipients use this to abort retransmit;
 * the kernel rejects the traffic generated against the now-dead session once
 * it has recorded the restart.
 */
export class PeerRestartedError extends BaseError {
  /**
   * Creates a new PeerRestartedError.
   *
   * @param options - Additional error options including cause and stack.
   * @param options.cause - The underlying error that caused the peer restart.
   * @param options.stack - The stack trace of the error.
   */
  constructor(options?: ErrorOptionsWithStack) {
    super(
      ErrorCode.PeerRestartedError,
      'Remote peer restarted: message not sent to avoid stale delivery',
      { ...options },
    );
    harden(this);
  }

  /**
   * A superstruct struct for validating marshaled {@link PeerRestartedError} instances.
   */
  public static struct = object({
    ...marshaledErrorSchema,
    code: literal(ErrorCode.PeerRestartedError),
    data: optional(never()),
  });

  /**
   * Unmarshals a {@link MarshaledError} into a {@link PeerRestartedError}.
   *
   * @param marshaledError - The marshaled error to unmarshal.
   * @param unmarshalErrorOptions - The function to unmarshal the error options.
   * @returns The unmarshaled error.
   */
  public static unmarshal(
    marshaledError: MarshaledOcapError,
    unmarshalErrorOptions: (
      marshaledError: MarshaledOcapError,
    ) => ErrorOptionsWithStack,
  ): PeerRestartedError {
    assert(marshaledError, this.struct);
    return new PeerRestartedError(unmarshalErrorOptions(marshaledError));
  }
}
harden(PeerRestartedError);
