import type { Stream } from '@libp2p/interface';
import type { LengthPrefixedStream } from '@libp2p/utils';
import type { Logger } from '@metamask/logger';

import type { KRef } from '../types.ts';

export type InboundConnectionHandler = (
  channel: Channel,
) => Promise<void> | void;

export type PeerDisconnectHandler = (peerId: string) => void;

export type Channel = {
  msgStream: LengthPrefixedStream<Stream>;
  stream: Stream;
  peerId: string;
};

/** What an outbound handshake found. */
export type OutboundHandshakeResult =
  | { success: false; incarnationChanged: false }
  | { success: true; incarnationChanged: false; remoteIncarnationId?: string }
  | { success: true; incarnationChanged: true; remoteIncarnationId: string };

export type RemoteMessageHandler = (
  from: string,
  message: string,
) => Promise<string | null>;

export type SendRemoteMessage = (to: string, message: string) => Promise<void>;

export type StopRemoteComms = () => Promise<void>;

export type RemoteIdentity = {
  getPeerId: () => string;
  issueOcapURL: (kref: KRef) => Promise<string>;
  redeemLocalOcapURL: (ocapURL: string) => Promise<KRef>;
  addKnownRelays: (relays: string[]) => void;
};

export type RemoteComms = RemoteIdentity & {
  sendRemoteMessage: SendRemoteMessage;
  registerLocationHints: (peerId: string, hints: string[]) => Promise<void>;
};

export type OnRemoteGiveUp = (peerId: string) => void;

/**
 * Callback invoked after every successful handshake with a remote peer,
 * carrying the incarnationId the peer just reported.
 *
 * Fires unconditionally (not only on detected change) so the kernel layer can
 * compare the observed value against persisted state and detect a peer
 * restart even when the in-memory PeerStateManager has been rebuilt empty
 * (e.g. after a receiver restart or stale-peer cleanup).
 *
 * Resolves `true` if the kernel knows the peer restarted. The transport
 * awaits this and uses the verdict to suppress stale outbound messages on the
 * same connection — the in-memory PSM check is unreliable across
 * receiver-side state loss.
 *
 * The kernel resets its RemoteHandle state and records the new incarnation in
 * a crank of its own, so a handshake that completes before that crank records
 * it reports the restart again.
 *
 * @param peerId - The peer ID that completed the handshake.
 * @param observedIncarnation - The incarnationId the peer reported.
 * @returns Whether the kernel knows the peer restarted.
 */
export type OnIncarnationChange = (
  peerId: string,
  observedIncarnation: string,
) => Promise<boolean>;

/**
 * Options for initializing remote communications.
 */
export type RemoteCommsOptions = {
  /**
   * Array of relay peer IDs/multiaddrs to use for remote communications.
   */
  relays?: string[] | undefined;
  /**
   * Maximum number of reconnection attempts. 0 = infinite (default).
   * If not provided, uses DEFAULT_MAX_RETRY_ATTEMPTS.
   */
  maxRetryAttempts?: number | undefined;
  /**
   * Maximum number of pending messages awaiting ACK per peer.
   * New messages are rejected when this limit is reached.
   * If not provided, uses DEFAULT_MAX_QUEUE (200).
   */
  maxQueue?: number | undefined;
  /**
   * Maximum number of concurrent connections (default: 100).
   * When the limit is reached, new outbound connections are rejected with
   * ResourceLimitError and inbound connections are closed immediately.
   */
  maxConcurrentConnections?: number | undefined;
  /**
   * Maximum message size in bytes (default: 1MB).
   * Messages exceeding this limit are immediately rejected with ResourceLimitError
   * before any connection or queuing attempt.
   */
  maxMessageSizeBytes?: number | undefined;
  /**
   * Interval in milliseconds between stale peer cleanup runs (default: 15 minutes).
   * Controls how often the system checks for and removes stale peer data.
   */
  cleanupIntervalMs?: number | undefined;
  /**
   * Time in milliseconds before a disconnected peer is considered stale (default: 1 hour).
   * When a peer has been disconnected for longer than this duration and is not
   * actively reconnecting, its data is cleaned up including: message queues,
   * location hints, connection timestamps, and reconnection state.
   */
  stalePeerTimeoutMs?: number | undefined;
  /**
   * BIP39 mnemonic phrase (12, 15, 18, 21, or 24 words) for seed recovery.
   * When provided, derives the kernel identity seed from this mnemonic instead of
   * generating a random seed. The same mnemonic will always produce the same peer ID.
   * If the kernel already has a stored identity, an error is thrown. Use
   * `resetStorage: true` when creating the kernel to clear existing identity first.
   */
  mnemonic?: string | undefined;
  /**
   * Maximum messages per second per peer (default: 100).
   * Messages exceeding this rate are rejected with ResourceLimitError.
   * Uses a sliding 1-second window.
   */
  maxMessagesPerSecond?: number | undefined;
  /**
   * Maximum connection attempts per minute per peer (default: 10).
   * Connection attempts exceeding this rate are rejected with ResourceLimitError.
   * Uses a sliding 1-minute window.
   */
  maxConnectionAttemptsPerMinute?: number | undefined;
  /**
   * Base delay in milliseconds for the exponential backoff of reconnection and
   * of a send's dial retries (default: 500ms).
   * Used as the starting delay that doubles with each subsequent attempt.
   * A send's dial retries skip `maxConnectionAttemptsPerMinute`, so with low
   * delays a send to an unreachable peer re-dials it that fast, for as long as
   * `maxRetryAttempts` allows (forever by default).
   */
  reconnectionBaseDelayMs?: number | undefined;
  /**
   * Maximum delay in milliseconds for the exponential backoff of reconnection
   * and of a send's dial retries (default: 10s).
   * The backoff delay is capped at this value regardless of attempt count.
   */
  reconnectionMaxDelayMs?: number | undefined;
  /**
   * Timeout in milliseconds for handshake operations (default: 10s).
   * Controls how long to wait for a handshake or handshakeAck response.
   */
  handshakeTimeoutMs?: number | undefined;
  /**
   * Timeout in milliseconds for channel write operations (default: 10s).
   * Controls how long to wait for a message to be written to a channel.
   */
  writeTimeoutMs?: number | undefined;
  /**
   * Timeout in milliseconds for ACK before retransmitting a message (default: 10s).
   * When a sent message is not acknowledged within this timeout, it will be retransmitted.
   */
  ackTimeoutMs?: number | undefined;
  /**
   * Timeout in milliseconds for stream inactivity (default: 120s).
   * If no data flows in either direction for this duration, the stream is
   * automatically aborted with an InactivityTimeoutError.
   */
  streamInactivityTimeoutMs?: number | undefined;
  /**
   * Maximum number of relay hints embedded in a single OCAP URL (default: 3).
   * Higher values produce longer URLs but improve connectivity resilience for
   * peers with stale relay information.
   */
  maxUrlRelayHints?: number | undefined;
  /**
   * Maximum number of relay entries stored in the kernel's relay pool
   * (default: 20). Bootstrap relays are prioritized during eviction; when
   * the cap is reached, the oldest non-bootstrap (learned) entries are
   * evicted first. If bootstrap relays alone exceed the cap, the pool is
   * truncated to the cap.
   */
  maxKnownRelays?: number | undefined;
  /**
   * Hostnames or IP addresses permitted for plain ws:// relay connections,
   * in addition to RFC 1918 / loopback addresses which are always allowed.
   * Defaults to [] (private/loopback addresses only).
   */
  allowedWsHosts?: string[] | undefined;
  /**
   * Direct listen addresses for non-relay transports (e.g. QUIC, TCP).
   * Example: `['/ip4/0.0.0.0/udp/0/quic-v1', '/ip4/0.0.0.0/tcp/4001']`
   *
   * The platform layer detects the required transports from the address strings
   * and injects them automatically. Users never need to import transport packages.
   */
  directListenAddresses?: string[] | undefined;
  /**
   * Internal option injected by platform services. Bundles direct transport
   * implementations with their listen addresses. Users should use
   * `directListenAddresses` instead.
   *
   * @internal
   */
  directTransports?: DirectTransport[];
};

/**
 * A direct transport implementation bundled with its listen addresses.
 */
export type DirectTransport = {
  transport: unknown;
  listenAddresses: string[];
};

/**
 * Options for creating a ConnectionFactory instance.
 */
export type ConnectionFactoryOptions = {
  keySeed: string;
  knownRelays: string[];
  logger: Logger;
  signal: AbortSignal;
  maxRetryAttempts?: number | undefined;
  reconnectionBaseDelayMs?: number | undefined;
  reconnectionMaxDelayMs?: number | undefined;
  /**
   * Maximum inbound message payload size in bytes. Used as `maxDataLength`
   * on every `lpStream` constructed for a channel — must match the
   * sender-side validator's limit (`maxMessageSizeBytes` on
   * `RemoteCommsOptions`) so that a deployment which raises one also raises
   * the other. Defaults to `DEFAULT_MAX_MESSAGE_SIZE_BYTES` (1 MB).
   */
  maxMessageSizeBytes?: number | undefined;
  directTransports?: DirectTransport[] | undefined;
  allowedWsHosts?: string[] | undefined;
};

export type RemoteInfo = {
  peerId: string;
  hints?: string[];
};
