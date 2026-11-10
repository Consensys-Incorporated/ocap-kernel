import type { MethodSpec, Handler } from '@metamask/kernel-rpc-methods';
import { object, string, boolean } from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';

const paramsStruct = object({
  peerId: string(),
  observedIncarnation: string(),
});

type Params = Infer<typeof paramsStruct>;

export type RemoteIncarnationChangeSpec = MethodSpec<
  'remoteIncarnationChange',
  Params,
  boolean
>;

export const remoteIncarnationChangeSpec: RemoteIncarnationChangeSpec = {
  method: 'remoteIncarnationChange',
  params: paramsStruct,
  // Using the boolean struct directly results in `Struct<true> | Struct<false>`,
  // which doesn't unify with `Struct<boolean>`. Cast through the spec type.
  result: boolean(),
} as RemoteIncarnationChangeSpec;

/**
 * Returns true if the kernel knows the peer restarted, including a restart it
 * has yet to record; the transport uses this to suppress stale outbound
 * messages on the same connection.
 */
export type HandleRemoteIncarnationChange = (
  peerId: string,
  observedIncarnation: string,
) => Promise<boolean>;

type RemoteIncarnationChangeHooks = {
  remoteIncarnationChange: HandleRemoteIncarnationChange;
};

export type RemoteIncarnationChangeHandler = Handler<
  'remoteIncarnationChange',
  Params,
  Promise<boolean>,
  RemoteIncarnationChangeHooks
>;

export const remoteIncarnationChangeHandler = {
  ...remoteIncarnationChangeSpec,
  hooks: { remoteIncarnationChange: true },
  implementation: async ({ remoteIncarnationChange }, params) =>
    remoteIncarnationChange(params.peerId, params.observedIncarnation),
} as RemoteIncarnationChangeHandler;
