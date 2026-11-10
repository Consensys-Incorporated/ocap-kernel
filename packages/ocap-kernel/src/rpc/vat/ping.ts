import type { MethodSpec, Handler } from '@metamask/kernel-rpc-methods';
import { EmptyJsonArray } from '@metamask/kernel-utils';
import { string } from '@metamask/superstruct';

export type PingSpec = MethodSpec<'ping', EmptyJsonArray, string>;

export const pingSpec: PingSpec = {
  method: 'ping',
  params: EmptyJsonArray,
  result: string(),
} as const;

// oxlint-disable-next-line typescript/no-empty-object-type
export type PingHandler = Handler<'ping', EmptyJsonArray, string, {}>;

export const pingHandler: PingHandler = {
  ...pingSpec,
  hooks: {},
  implementation: () => 'pong',
};
