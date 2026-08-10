import type {
  Baggage,
  Message as SwingsetMessage,
  VatSyscallObject,
  VatSyscallSend,
  VatOneResolution,
} from '@agoric/swingset-liveslots';
import type { CapData } from '@endo/marshal';
import type { PlatformConfig } from '@metamask/kernel-platforms';
import { platformConfigStruct } from '@metamask/kernel-platforms';
import type { VatCheckpoint } from '@metamask/kernel-store';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { CapDataStruct } from '@metamask/kernel-utils';
import type { DuplexStream } from '@metamask/streams';
import {
  assign,
  define,
  is,
  object,
  string,
  array,
  record,
  union,
  tuple,
  literal,
  boolean,
  exactOptional,
  type,
} from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';
import type { Json } from '@metamask/utils';
import { UnsafeJsonStruct } from '@metamask/utils';

import type {
  RemoteMessageHandler,
  SendRemoteMessage,
  StopRemoteComms,
  OnRemoteGiveUp,
  OnIncarnationChange,
  RemoteCommsOptions,
} from './remotes/types.ts';
import { Fail } from './utils/assert.ts';
import { AllowedGlobalNameStruct } from './vats/endowments.ts';
import type { AllowedGlobalName } from './vats/endowments.ts';

/**
 * # Branded types
 *
 * Branded types are validated at creation time via `insist*()` assertions and
 * `makeGCAction()`. After construction, the type system carries the invariant;
 * interior code trusts the brand without re-checking.
 *
 * - **External input** (JSON-RPC params, liveslots syscalls): validated at the
 *   boundary using superstruct definitions (`KRefStruct`, `EndpointIdStruct`,
 *   `EndpointMessageStruct`, etc.).
 * - **Translator layer**: validates endpoint-space refs via `insistERef()`
 *   before translating to kernel-space.
 * - **Persistence reads**: trusted. Data integrity is the responsibility of the
 *   persistence layer (`@metamask/kernel-store`); branded types are applied via
 *   `as` casts on read. See `./store/README.md` for details.
 * - **Internal construction** (counters, template literals): uses `as` casts
 *   where the format is controlled by the constructor (e.g., `"v1" as VatId`).
 *
 * Branded string types intentionally use plain `string &` rather than template
 * literal types (e.g. `v${number}`). The brands already prevent cross-type
 * confusion, and the format is enforced at runtime by `insist*()` / `is*()`
 * validators. Template literals would add friction to the `as` casts used for
 * persistence reads and internal construction without meaningful extra safety.
 */

declare const VatIdBrand: unique symbol;
/**
 * Vat identifier. Format: `v${number}`.
 * E.g. `"v1"`, `"v42"`.
 */
export type VatId = string & { readonly [VatIdBrand]: never };

declare const RemoteIdBrand: unique symbol;
/**
 * Remote identifier. Format: `r${number}`.
 * E.g. `"r0"`, `"r3"`.
 */
export type RemoteId = string & { readonly [RemoteIdBrand]: never };

/** An endpoint is either a vat or a remote. */
export type EndpointId = VatId | RemoteId;

declare const SubclusterIdBrand: unique symbol;
/**
 * Subcluster identifier. Format: `s${number}`.
 * E.g. `"s0"`, `"s5"`.
 */
export type SubclusterId = string & { readonly [SubclusterIdBrand]: never };

declare const KRefBrand: unique symbol;
/**
 * Kernel-space reference. Format: `k${'o'|'p'}${number}`.
 * E.g. `"ko12"`, `"kp3"`.
 */
export type KRef = string & { readonly [KRefBrand]: never };

declare const VRefBrand: unique symbol;
/**
 * Vat-space reference. Mirrors the vref grammar produced by
 * `@agoric/swingset-liveslots`'s `parseVatSlot`:
 *
 *   - `${'o'|'p'}${'+' | '-'}${number}` for plain refs
 *     (kernel imports, ephemeral exports, promises).
 *     E.g. `"o+0"`, `"o-3"`, `"p-7"`.
 *   - `o+${'d'|'v'}${kindId}/${instanceId}` for vat-allocated
 *     virtual (`v`) or durable (`d`) objects.
 *     E.g. `"o+d10/1"`, `"o+v3/4"`.
 *   - `o+${'d'|'v'}${kindId}/${instanceId}:${facetId}` for the
 *     same with a facet selector.
 *     E.g. `"o+d10/1:0"`.
 *
 * The durability/subid/facet syntax is only valid for `o+`
 * (vat-allocated objects); kernel imports, promises, and remotes
 * never carry it.
 */
export type VRef = string & { readonly [VRefBrand]: never };

declare const RRefBrand: unique symbol;
/**
 * Remote-space reference. Format: `r${'o'|'p'}${'+' | '-'}${number}`.
 * E.g. `"ro+1"`, `"rp-2"`.
 */
export type RRef = string & { readonly [RRefBrand]: never };

/**
 * Endpoint-space reference (vat or remote).
 * E.g. `"o+0"`, `"p-7"`, `"ro+1"`, `"rp-2"`.
 */
export type ERef = VRef | RRef;
/**
 * Any reference (kernel-space or endpoint-space).
 * E.g. `"ko12"`, `"kp3"`, `"o+0"`, `"ro+1"`.
 */
export type Ref = KRef | ERef;

export const ROOT_OBJECT_VREF = 'o+0' as VRef;

export const isVatId = (value: unknown): value is VatId =>
  typeof value === 'string' && /^v\d+$/u.test(value);

export const isRemoteId = (value: unknown): value is RemoteId =>
  typeof value === 'string' && /^r\d+$/u.test(value);

export const isEndpointId = (value: unknown): value is EndpointId =>
  isVatId(value) || isRemoteId(value);

export const isKRef = (value: unknown): value is KRef =>
  typeof value === 'string' && /^k[op]\d+$/u.test(value);

export const isVRef = (value: unknown): value is VRef =>
  typeof value === 'string' &&
  /^(?:p[+-]\d+|o-\d+|o\+(?:\d+|[dv]\d+\/\d+(?::\d+)?))$/u.test(value);

export const isRRef = (value: unknown): value is RRef =>
  typeof value === 'string' && /^r[op][+-]\d+$/u.test(value);

export const isERef = (value: unknown): value is ERef =>
  isVRef(value) || isRRef(value);

/**
 * Assert that a value is a valid vat id.
 *
 * @param value - The value to check.
 * @throws if the value is not a valid vat id.
 */
export function insistVatId(value: unknown): asserts value is VatId {
  isVatId(value) || Fail`not a valid VatId ${value}`;
}

/**
 * Assert that a value is a valid remote id.
 *
 * @param value - The value to check.
 * @throws If the value is not a valid remote id.
 */
export function insistRemoteId(value: unknown): asserts value is RemoteId {
  isRemoteId(value) || Fail`not a valid RemoteId: ${value}`;
}

/**
 * Assert that a value is a valid endpoint id.
 *
 * @param value - The value to check.
 * @throws if the value is not a valid endpoint id.
 */
export function insistEndpointId(value: unknown): asserts value is EndpointId {
  isEndpointId(value) || Fail`not a valid EndpointId`;
}

/**
 * Assert that a value is a valid kernel reference.
 *
 * @param value - The value to check.
 * @throws If the value is not a valid kernel reference.
 */
export function insistKRef(value: unknown): asserts value is KRef {
  isKRef(value) || Fail`not a valid KRef: ${value}`;
}

/**
 * Assert that a value is a valid vat reference.
 *
 * @param value - The value to check.
 * @throws If the value is not a valid vat reference.
 */
export function insistVRef(value: unknown): asserts value is VRef {
  isVRef(value) || Fail`not a valid VRef: ${value}`;
}

/**
 * Assert that a value is a valid remote reference.
 *
 * @param value - The value to check.
 * @throws If the value is not a valid remote reference.
 */
export function insistRRef(value: unknown): asserts value is RRef {
  isRRef(value) || Fail`not a valid RRef: ${value}`;
}

/**
 * Assert that a value is a valid endpoint reference.
 *
 * @param value - The value to check.
 * @throws If the value is not a valid endpoint reference.
 */
export function insistERef(value: unknown): asserts value is ERef {
  isERef(value) || Fail`not a valid ERef: ${value}`;
}

export const VatIdStruct = define<VatId>('VatId', isVatId);
export const RemoteIdStruct = define<RemoteId>('RemoteId', isRemoteId);
export const EndpointIdStruct = define<EndpointId>('EndpointId', isEndpointId);
export const KRefStruct = define<KRef>('KRef', isKRef);
export const ERefStruct = define<ERef>('ERef', isERef);
export { CapDataStruct };

export const VatOneResolutionStruct = tuple([
  string(),
  boolean(),
  CapDataStruct,
]);

/**
 * A single kernel-space promise resolution: [promiseKRef, rejected, data].
 * Kernel-space counterpart of Agoric's `VatOneResolution`.
 */
export type KernelOneResolution = [KRef, boolean, CapData<KRef>];

/**
 * Kernel-space syscall object, mirroring Agoric's `VatSyscallObject` but with
 * branded kernel types (KRef, KernelMessage, KernelOneResolution) instead of
 * plain strings. Produced by `translateSyscallVtoK`.
 */
export type KernelSyscallObject =
  | ['send', KRef, KernelMessage]
  | ['subscribe', KRef]
  | ['resolve', KernelOneResolution[]]
  | ['exit', boolean, CapData<KRef>]
  | ['dropImports', KRef[]]
  | ['retireImports', KRef[]]
  | ['retireExports', KRef[]]
  | ['abandonExports', KRef[]];

// Kernel-space message: refs are KRefs
export const KernelCapDataStruct = object({
  body: string(),
  slots: array(KRefStruct),
});

export const KernelMessageStruct = object({
  methargs: KernelCapDataStruct,
  result: exactOptional(union([KRefStruct, literal(null)])),
});

export type KernelMessage = Infer<typeof KernelMessageStruct>;

// Endpoint-space message: refs are ERefs
export const EndpointCapDataStruct = object({
  body: string(),
  slots: array(ERefStruct),
});

export const EndpointMessageStruct = object({
  methargs: EndpointCapDataStruct,
  result: exactOptional(union([ERefStruct, literal(null)])),
});

export type EndpointMessage = Infer<typeof EndpointMessageStruct>;

/**
 * Coerce a {@link SwingsetMessage} to an {@link EndpointMessage}.
 * Agoric's SwingsetMessage comes from vat syscalls (endpoint-space).
 *
 * @param message - The SwingsetMessage to coerce.
 * @returns The coerced EndpointMessage.
 */
export function coerceEndpointMessage(
  message: SwingsetMessage,
): EndpointMessage {
  if (message.result === undefined) {
    delete (message as EndpointMessage).result;
  }
  insistEndpointMessage(message);
  return message;
}

type JsonVatSyscallObject =
  | Exclude<VatSyscallObject, VatSyscallSend>
  | ['send', string, EndpointMessage];

/**
 * Coerce a {@link VatSyscallObject} to a JSON-RPC-compatible {@link JsonVatSyscallObject}.
 *
 * @param vso - The VatSyscallObject to coerce.
 * @returns The coerced VatSyscallObject.
 */
export function coerceVatSyscallObject(
  vso: VatSyscallObject,
): JsonVatSyscallObject {
  if (vso[0] === 'send') {
    return ['send', vso[1], coerceEndpointMessage(vso[2])];
  }
  return vso as JsonVatSyscallObject;
}

const RunQueueItemSendStruct = object({
  type: literal('send'),
  target: KRefStruct,
  message: KernelMessageStruct,
});

export type RunQueueItemSend = Infer<typeof RunQueueItemSendStruct>;

const RunQueueItemNotifyStruct = object({
  type: literal('notify'),
  endpointId: EndpointIdStruct,
  kpid: KRefStruct,
});

export type RunQueueItemNotify = Infer<typeof RunQueueItemNotifyStruct>;

const GCRunQueueTypeStruct = union([
  literal('dropExports'),
  literal('retireExports'),
  literal('retireImports'),
]);

export type GCRunQueueType = Infer<typeof GCRunQueueTypeStruct>;

export type GCActionType = 'dropExport' | 'retireExport' | 'retireImport';
export const actionTypePriorities: GCActionType[] = [
  'dropExport',
  'retireExport',
  'retireImport',
];

const RunQueueItemGCActionStruct = object({
  type: GCRunQueueTypeStruct,
  endpointId: EndpointIdStruct,
  krefs: array(KRefStruct),
});

export type RunQueueItemGCAction = Infer<typeof RunQueueItemGCActionStruct>;

const RunQueueItemBringOutYourDeadStruct = object({
  type: literal('bringOutYourDead'),
  endpointId: EndpointIdStruct,
});

export type RunQueueItemBringOutYourDead = Infer<
  typeof RunQueueItemBringOutYourDeadStruct
>;

/**
 * A request to replace a vat's worker, queued so the run loop performs it.
 *
 * Queued rather than done where it is asked for, because the run loop is then the
 * only thing that takes a vat out of the kernel's reach: no crank can observe the
 * vat mid-replacement, and the vat is idle when it happens, since the crank doing
 * the work is the one that would otherwise be delivering to it.
 */
const RunQueueItemRestartVatStruct = object({
  type: literal('restartVat'),
  vatId: VatIdStruct,
});

export type RunQueueItemRestartVat = Infer<typeof RunQueueItemRestartVatStruct>;

export const RunQueueItemStruct = union([
  RunQueueItemSendStruct,
  RunQueueItemNotifyStruct,
  RunQueueItemGCActionStruct,
  RunQueueItemBringOutYourDeadStruct,
  RunQueueItemRestartVatStruct,
]);

export type RunQueueItem = Infer<typeof RunQueueItemStruct>;

/**
 * Assert that a value is a valid kernel message.
 *
 * @param value - The value to check.
 * @throws if the value is not a valid kernel message.
 */
export function insistKernelMessage(
  value: unknown,
): asserts value is KernelMessage {
  is(value, KernelMessageStruct) || Fail`not a valid kernel message`;
}

/**
 * Assert that a value is a valid endpoint message.
 *
 * @param value - The value to check.
 * @throws If the value is not a valid endpoint message.
 */
export function insistEndpointMessage(
  value: unknown,
): asserts value is EndpointMessage {
  is(value, EndpointMessageStruct) || Fail`not a valid endpoint message`;
}

// Per-endpoint persistent state
type EndpointState<IdType> = {
  name: string;
  id: IdType;
  nextExportObjectIdCounter: number;
  nextExportPromiseIdCounter: number;
  eRefToKRef: Map<ERef, KRef>;
  kRefToERef: Map<KRef, ERef>;
};

type KernelVatState = {
  messagePort: typeof MessagePort;
  state: EndpointState<VatId>;
  source: string;
  kvTable: Map<string, string>;
};

type RemoteState = {
  state: EndpointState<RemoteId>;
  connectToURL: string;
  // more here about maintaining connection...
};

// Kernel persistent state

export type PromiseState = 'unresolved' | 'fulfilled' | 'rejected';

export type KernelPromise = {
  state: PromiseState;
  decider?: EndpointId | 'kernel';
  subscribers?: EndpointId[];
  value?: CapData<KRef>;
};

export type KernelState = {
  vats: Map<VatId, KernelVatState>;
  remotes: Map<RemoteId, RemoteState>;
  kernelPromises: Map<KRef, KernelPromise>;
};

export const isSubclusterId = (value: unknown): value is SubclusterId =>
  typeof value === 'string' && /^s\d+$/u.test(value);

export const SubclusterIdStruct = define<SubclusterId>(
  'SubclusterId',
  isSubclusterId,
);

/**
 * Assert that a value is a valid subcluster id.
 *
 * @param value - The value to check.
 * @throws If the value is not a valid subcluster id.
 */
export function insistSubclusterId(
  value: unknown,
): asserts value is SubclusterId {
  isSubclusterId(value) || Fail`not a valid SubclusterId: ${value}`;
}

declare const VatMessageIdBrand: unique symbol;
/**
 * Vat message identifier. Format: `m${number}`.
 * E.g. `"m0"`, `"m15"`.
 */
export type VatMessageId = string & { readonly [VatMessageIdBrand]: never };

export const isVatMessageId = (value: unknown): value is VatMessageId =>
  typeof value === 'string' && /^m\d+$/u.test(value);

export const VatMessageIdStruct = define<VatMessageId>(
  'VatMessageId',
  isVatMessageId,
);

/**
 * A service for things the kernel worker can't do itself. Abstracts platform-specific details of
 * how vat workers are launched, terminated, and connected to the kernel, and for network communications.
 */
export type PlatformServices = {
  /**
   * Launch a new worker with a specific vat id.
   *
   * @param vatId - The vat id of the worker to launch.
   * @param vatConfig - Configuration object describing vat.
   * @returns A promise for a duplex stream connected to the worker
   * which rejects if a worker with the given vat id already exists.
   */
  launch: (
    vatId: VatId,
    vatConfig: VatConfig,
  ) => Promise<DuplexStream<JsonRpcMessage, JsonRpcMessage>>;
  /**
   * Terminate a worker identified by its vat id.
   *
   * @param vatId - The vat id of the worker to terminate.
   * @param error - An optional error to terminate the worker with.
   * @returns A promise that resolves when the worker has terminated
   * or rejects if that worker does not exist.
   */
  terminate: (vatId: VatId, error?: Error) => Promise<void>;
  /**
   * Terminate all workers managed by the service.
   *
   * @returns A promise that resolves after all workers have terminated
   * or rejects if there was an error during termination.
   */
  terminateAll: () => Promise<void>;

  /**
   * Send a message over the network to another kernel.
   *
   * @param to - The network peer to whom to send the message.
   * @param message - The message itself.
   * @returns A promise that resolves when the message has been transmitted or
   *   rejects if there is some problem doing so.
   */
  sendRemoteMessage: SendRemoteMessage;
  /**
   * Initialize network communications.
   *
   * @param keySeed - The seed for generating this kernel's secret key.
   * @param options - Options for remote communications initialization.
   * @param options.relays - Array of the peerIDs of relay nodes that can be used to listen for incoming
   *   connections from other kernels.
   * @param options.maxRetryAttempts - Maximum number of reconnection attempts. 0 = infinite (default).
   * @param options.maxQueue - Maximum number of messages to queue per peer while reconnecting (default: 200).
   * @param remoteMessageHandler - A handler function to receive remote messages.
   * @param onRemoteGiveUp - Optional callback to be called when we give up on a remote.
   * @param incarnationId - Unique identifier for this kernel instance.
   * @param onIncarnationChange - Optional callback when a remote peer's incarnation changes.
   * @returns A promise that resolves once network access has been established
   *   or rejects if there is some problem doing so.
   */
  initializeRemoteComms: (
    keySeed: string,
    options: RemoteCommsOptions,
    remoteMessageHandler: RemoteMessageHandler,
    onRemoteGiveUp?: OnRemoteGiveUp,
    incarnationId?: string,
    onIncarnationChange?: OnIncarnationChange,
  ) => Promise<void>;
  /**
   * Stop network communications.
   *
   * @returns A promise that resolves when network access has been stopped
   *   or rejects if there is some problem doing so.
   */
  stopRemoteComms: StopRemoteComms;
  /**
   * Explicitly close a connection to a peer.
   * Marks the peer as intentionally closed to prevent automatic reconnection.
   *
   * @param peerId - The peer ID to close the connection for.
   * @returns A promise that resolves when the connection is closed.
   */
  closeConnection: (peerId: string) => Promise<void>;
  /**
   * Take note of where a peer might be.
   *
   * @param peerId - The peer ID to which this information applies
   * @param hints - Location hints for the peer.
   */
  registerLocationHints: (peerId: string, hints: string[]) => Promise<void>;
  /**
   * Manually reconnect to a peer after intentional close.
   * Clears the intentional close flag and initiates reconnection.
   *
   * @param peerId - The peer ID to reconnect to.
   * @param hints - Optional hints for reconnection.
   * @returns A promise that resolves when reconnection is initiated.
   */
  reconnectPeer: (peerId: string, hints?: string[]) => Promise<void>;
  /**
   * Reset all reconnection backoffs.
   * Called after detecting a cross-incarnation wake to avoid unnecessary delays.
   *
   * @returns A promise that resolves when backoffs have been reset.
   */
  resetAllBackoffs: () => Promise<void>;
  /**
   * Get the listen addresses of the libp2p node.
   * Returns multiaddr strings that other peers can use to dial this node directly.
   * Returns an empty array if remote comms is not initialized.
   *
   * @returns The listen address strings.
   */
  getListenAddresses: () => string[];
};

// Cluster configuration

/**
 * Per-vat network configuration. Present only when the vat opts into the
 * `fetch` endowment via {@link VatConfig.globals}; an absent or missing
 * `allowedHosts` is treated as a denial of all hosts (there is no implicit
 * allow-all).
 */
export type VatNetworkConfig = {
  allowedHosts: string[];
};

export const vatNetworkConfigStruct = object({
  allowedHosts: array(string()),
});

export type VatConfig = UserCodeSpec & {
  creationOptions?: Record<string, Json>;
  parameters?: Record<string, Json>;
  platformConfig?: Partial<PlatformConfig>;
  globals?: AllowedGlobalName[];
  network?: VatNetworkConfig;
};

const UserCodeSpecStruct = union([
  object({
    sourceSpec: string(),
  }),
  object({
    bundleSpec: string(),
  }),
  object({
    bundleName: string(),
  }),
]);

type UserCodeSpec = Infer<typeof UserCodeSpecStruct>;

export const VatConfigStruct = define<VatConfig>('VatConfig', (value) => {
  if (!value) {
    return false;
  }

  const {
    creationOptions,
    parameters,
    platformConfig,
    globals,
    network,
    ...specOnly
  } = value as Record<string, unknown>;

  return (
    is(specOnly, UserCodeSpecStruct) &&
    (!creationOptions || is(creationOptions, UnsafeJsonStruct)) &&
    (!parameters || is(parameters, UnsafeJsonStruct)) &&
    (!platformConfig || is(platformConfig, platformConfigStruct)) &&
    (!globals || is(globals, array(AllowedGlobalNameStruct))) &&
    (!network || is(network, vatNetworkConfigStruct))
  );
});

export const isVatConfig = (value: unknown): value is VatConfig =>
  is(value, VatConfigStruct);

export type VatConfigTable = Record<string, VatConfig>;

// IO configuration types

const ConsoleIOSpecStruct = object({ type: literal('console') });
const ListenIOSpecStruct = object({
  type: literal('listen'),
  hostport: string(),
});
const NetworkIOSpecStruct = object({
  type: literal('network'),
  hostport: string(),
});
const FileIOSpecStruct = object({ type: literal('file'), path: string() });
const SocketIOSpecStruct = object({ type: literal('socket'), path: string() });

export type IOSpec =
  | Infer<typeof ConsoleIOSpecStruct>
  | Infer<typeof ListenIOSpecStruct>
  | Infer<typeof NetworkIOSpecStruct>
  | Infer<typeof FileIOSpecStruct>
  | Infer<typeof SocketIOSpecStruct>;

const IODirectionStruct = union([
  literal('in'),
  literal('out'),
  literal('inout'),
]);
const IOUnitStruct = union([
  literal('line'),
  literal('string'),
  literal('chars'),
  literal('bytes'),
]);

const IOExtraStruct = object({
  direction: exactOptional(IODirectionStruct),
  unit: exactOptional(IOUnitStruct),
});

const IOConfigStruct = union([
  assign(ConsoleIOSpecStruct, IOExtraStruct),
  assign(ListenIOSpecStruct, IOExtraStruct),
  assign(NetworkIOSpecStruct, IOExtraStruct),
  assign(FileIOSpecStruct, IOExtraStruct),
  assign(SocketIOSpecStruct, IOExtraStruct),
]);

export type IOConfig = Infer<typeof IOConfigStruct>;

export const ClusterConfigStruct = object({
  bootstrap: string(),
  forceReset: exactOptional(boolean()),
  services: exactOptional(array(string())),
  io: exactOptional(record(string(), IOConfigStruct)),
  vats: record(string(), VatConfigStruct),
  bundles: exactOptional(record(string(), VatConfigStruct)),
});

export type ClusterConfig = Infer<typeof ClusterConfigStruct>;

export const isClusterConfig = (value: unknown): value is ClusterConfig =>
  is(value, ClusterConfigStruct);

export const SubclusterStruct = object({
  id: SubclusterIdStruct,
  config: ClusterConfigStruct,
  vats: record(string(), VatIdStruct),
});

export type Subcluster = Infer<typeof SubclusterStruct>;

/**
 * Result of launching a subcluster.
 */
export type SubclusterLaunchResult = {
  /** The ID of the launched subcluster. */
  subclusterId: SubclusterId;
  /** The kref of the bootstrap vat's root object. */
  rootKref: KRef;
  /** The CapData result of calling bootstrap() on the root object, if any. */
  bootstrapResult: CapData<KRef> | undefined;
  /** Map from vat name to root kref for all successfully launched vats. */
  vatRootKrefs: Record<string, KRef>;
};

const RemoteCommsDisconnectedStruct = object({
  state: literal('disconnected'),
});

const RemoteCommsIdentityOnlyStruct = object({
  state: literal('identity-only'),
  peerId: string(),
});

const RemoteCommsConnectedStruct = object({
  state: literal('connected'),
  peerId: string(),
  listenAddresses: array(string()),
});

/**
 * Whether the kernel is capable of processing its run queue. `idle` means the
 * run loop was never started, not that it has nothing to do — a loop parked on
 * an empty queue reports `running`. `failed` means nothing will ever be
 * processed again and the kernel must be restarted.
 */
// The arms are `type()`, not `object()`, so a client shipped against them
// tolerates a newer kernel adding a field to an arm. Note the limit of that:
// a newer kernel adding a whole new *state* is rejected by the union either
// way, so adding an arm here is a breaking wire change for older clients.
export const RunLoopStatusStruct = union([
  type({ state: literal('idle') }),
  type({ state: literal('running') }),
  // Two strings because one cannot be both: `error` is the message, `detail` the
  // cause chain. When a crank dies and its rollback then fails, the message names
  // the rollback and only the chain names what killed the kernel.
  type({ state: literal('failed'), error: string(), detail: string() }),
]);

export type RunLoopStatus = Infer<typeof RunLoopStatusStruct>;

/**
 * Notified when the kernel's run loop dies. Should not be async: the kernel is
 * reporting a failure it cannot recover from, so there is nothing to await. An
 * async handler's rejection is logged rather than awaited.
 */
export type OnRunLoopFailure = (error: Error) => void;

export const KernelStatusStruct = type({
  subclusters: array(SubclusterStruct),
  vats: array(
    object({
      id: VatIdStruct,
      config: VatConfigStruct,
      subclusterId: SubclusterIdStruct,
    }),
  ),
  // Required, in the type as well as on the wire. `exactOptional` would make the
  // type say "may be absent" while validation still demanded the key, since
  // `exactOptional` only permits an absent key inside `object()` and this is a
  // `type()`. `optional` would agree with the type but cannot be used: it widens
  // the inferred property to `| undefined`, and `KernelStatus` is an RPC result,
  // so it must satisfy `Json`. Required is the only self-consistent option — at
  // the cost that a reply from a kernel predating this field fails validation
  // outright, which `remoteComms` already implies for older kernels too.
  runLoop: RunLoopStatusStruct,
  remoteComms: exactOptional(
    union([
      RemoteCommsDisconnectedStruct,
      RemoteCommsIdentityOnlyStruct,
      RemoteCommsConnectedStruct,
    ]),
  ),
});

export type KernelStatus = Infer<typeof KernelStatusStruct>;

export type UserCodeStartFn = (parameters?: Record<string, Json>) => object;

/**
 * Capabilities provided to a vat. The contents vary by vat configuration.
 * Note: A logger is available via the `console` endowment.
 */
export type VatPowers = Record<string, unknown>;

/** Persistent storage for a vat's durable state (from @agoric/swingset-liveslots). */
export type { Baggage };

/**
 * A mapping of GC action type to queue event type.
 */
export const queueTypeFromActionType = new Map<GCActionType, GCRunQueueType>([
  // Note: From singular to plural
  ['dropExport', 'dropExports'],
  ['retireExport', 'retireExports'],
  ['retireImport', 'retireImports'],
]);

export const isGCActionType = (value: unknown): value is GCActionType =>
  actionTypePriorities.includes(value as GCActionType);

/**
 * Assert that a value is a valid GC action type.
 *
 * @param value - The value to check.
 * @throws if the value is not a valid GC action type.
 */
export function insistGCActionType(
  value: unknown,
): asserts value is GCActionType {
  isGCActionType(value) || Fail`not a valid GCActionType ${value}`;
}

declare const GCActionBrand: unique symbol;
/**
 * GC action key. Format: `${EndpointId} ${GCActionType} ${KRef}`.
 * E.g. `"v1 dropExport ko5"`.
 */
export type GCAction = string & { readonly [GCActionBrand]: never };

export const GCActionStruct = define<GCAction>('GCAction', (value: unknown) => {
  if (typeof value !== 'string') {
    return false;
  }
  const [endpointId, actionType, kref] = value.split(' ');
  if (!isEndpointId(endpointId)) {
    return false;
  }
  if (!isGCActionType(actionType)) {
    return false;
  }
  if (!isKRef(kref) || !kref.startsWith('ko')) {
    return false;
  }
  return true;
});

export const isGCAction = (value: unknown): value is GCAction =>
  is(value, GCActionStruct);

/**
 * Assert that a value is a valid GC action.
 *
 * @param value - The value to check.
 * @throws If the value is not a valid GC action.
 */
export function insistGCAction(value: unknown): asserts value is GCAction {
  isGCAction(value) || Fail`not a valid GCAction: ${value}`;
}

/**
 * Create a validated GCAction string from its components.
 *
 * @param endpointId - The endpoint that owns the object.
 * @param actionType - The type of GC action.
 * @param kref - The kernel object reference (must start with 'ko').
 * @returns The branded GCAction string.
 */
export function makeGCAction(
  endpointId: EndpointId,
  actionType: GCActionType,
  kref: KRef,
): GCAction {
  kref.startsWith('ko') || Fail`GC actions only apply to objects: ${kref}`;
  return `${endpointId} ${actionType} ${kref}` as GCAction;
}

export type CrankResult = {
  didDelivery?: EndpointId | 'kernel'; // the endpoint to which we made a delivery
  abort?: boolean; // changes should be discarded, not committed
  terminate?: { vatId: VatId; reject: boolean; info: CapData<KRef> };
};

export type VatDeliveryResult = [VatCheckpoint, string | null];

export type EndpointHandle = {
  deliverMessage: (
    target: ERef,
    message: EndpointMessage,
  ) => Promise<CrankResult>;
  deliverNotify: (resolutions: VatOneResolution[]) => Promise<CrankResult>;
  deliverDropExports: (erefs: ERef[]) => Promise<CrankResult>;
  deliverRetireExports: (erefs: ERef[]) => Promise<CrankResult>;
  deliverRetireImports: (erefs: ERef[]) => Promise<CrankResult>;
  deliverBringOutYourDead: () => Promise<CrankResult>;
};

/**
 * Configuration for a system subcluster.
 * System subclusters are statically declared at kernel initialization and can
 * receive powerful kernel services not available to normal subclusters.
 * They persist across kernel restarts, just like regular subclusters.
 */
export type SystemSubclusterConfig = {
  /** Unique name for this system subcluster (used for retrieval via `getSystemSubclusterRoot`) */
  name: string;
  /** The cluster configuration */
  config: ClusterConfig;
};
