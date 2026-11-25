import type { Handler, MethodSpec } from '@metamask/kernel-rpc-methods';
import {
  tuple,
  literal,
  array,
  number,
  object,
  string,
  record,
  union,
} from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';
import { UnsafeJsonStruct } from '@metamask/utils';

import { VatDeliveryResultStruct } from './shared.ts';
import {
  CapDataStruct,
  EndpointMessageStruct,
  VatOneResolutionStruct,
} from '../../types.ts';
import type { VatDeliveryResult } from '../../types.ts';

const MessageDeliveryStruct = tuple([
  literal('message'),
  string(),
  EndpointMessageStruct,
]);

const NotifyDeliveryStruct = tuple([
  literal('notify'),
  array(VatOneResolutionStruct),
]);

const DropExportsDeliveryStruct = tuple([
  literal('dropExports'),
  array(string()),
]);

const RetireExportsDeliveryStruct = tuple([
  literal('retireExports'),
  array(string()),
]);

const RetireImportsDeliveryStruct = tuple([
  literal('retireImports'),
  array(string()),
]);

const ChangeVatOptionsDeliveryStruct = tuple([
  literal('changeVatOptions'),
  record(string(), UnsafeJsonStruct),
]);

const StartVatDeliveryStruct = tuple([literal('startVat'), CapDataStruct]);

const StopVatDeliveryStruct = tuple([literal('stopVat'), CapDataStruct]);

const BringOutYourDeadDeliveryStruct = tuple([literal('bringOutYourDead')]);

const VatDeliveryParamsStruct = union([
  MessageDeliveryStruct,
  NotifyDeliveryStruct,
  DropExportsDeliveryStruct,
  RetireExportsDeliveryStruct,
  RetireImportsDeliveryStruct,
  ChangeVatOptionsDeliveryStruct,
  StartVatDeliveryStruct,
  StopVatDeliveryStruct,
  BringOutYourDeadDeliveryStruct,
]);

export type VatDeliveryParams = Infer<typeof VatDeliveryParamsStruct>;

/** A delivery, and the crank the kernel makes it in. */
const DeliverParamsStruct = object({
  delivery: VatDeliveryParamsStruct,
  crankNumber: number(),
});

type DeliverParams = Infer<typeof DeliverParamsStruct>;

export type DeliverSpec = MethodSpec<
  'deliver',
  DeliverParams,
  Promise<VatDeliveryResult>
>;

export const deliverSpec: DeliverSpec = {
  method: 'deliver',
  params: DeliverParamsStruct,
  result: VatDeliveryResultStruct,
} as const;

export type HandleDelivery = (
  delivery: VatDeliveryParams,
  crankNumber: number,
) => Promise<VatDeliveryResult>;

type DeliverHooks = {
  handleDelivery: HandleDelivery;
};

export type DeliverHandler = Handler<
  'deliver',
  DeliverParams,
  Promise<VatDeliveryResult>,
  DeliverHooks
>;

export const deliverHandler: DeliverHandler = {
  ...deliverSpec,
  hooks: { handleDelivery: true },
  implementation: async ({ handleDelivery }, { delivery, crankNumber }) => {
    return await handleDelivery(delivery, crankNumber);
  },
} as const;
