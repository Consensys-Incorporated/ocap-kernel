import type { MethodSpec, Handler } from '@metamask/kernel-rpc-methods';
import {
  array,
  exactOptional,
  literal,
  object,
  string,
  tuple,
  union,
} from '@metamask/superstruct';
import type { Infer, Struct } from '@metamask/superstruct';

import { VatCheckpointStruct } from './shared.ts';
import { VatConfigStruct } from '../../types.ts';
import type { VatConfig, VatDeliveryResult } from '../../types.ts';
import { AllowedGlobalNameStruct } from '../../vats/endowments.ts';
import type { AllowedGlobalName } from '../../vats/endowments.ts';

const paramsStruct = object({
  vatConfig: VatConfigStruct,
  state: array(tuple([string(), string()])),
  allowedGlobalNames: exactOptional(array(AllowedGlobalNameStruct)),
});

type Params = Infer<typeof paramsStruct>;

/**
 * The result of the vat's first delivery, and the content hash of the bundle
 * the worker loaded for it.
 */
export type InitVatResult = [...VatDeliveryResult, string];

const InitVatResultStruct: Struct<InitVatResult> = tuple([
  VatCheckpointStruct,
  union([string(), literal(null)]),
  string(),
]);

export type InitVatSpec = MethodSpec<'initVat', Params, Promise<InitVatResult>>;

export const initVatSpec: InitVatSpec = {
  method: 'initVat',
  params: paramsStruct,
  result: InitVatResultStruct,
};

export type InitVat = (
  vatConfig: VatConfig,
  state: Map<string, string>,
  allowedGlobalNames: AllowedGlobalName[] | undefined,
) => Promise<InitVatResult>;

type InitVatHooks = {
  initVat: InitVat;
};

export type InitVatHandler = Handler<
  'initVat',
  Params,
  Promise<InitVatResult>,
  InitVatHooks
>;

export const initVatHandler: InitVatHandler = {
  ...initVatSpec,
  hooks: { initVat: true },
  implementation: async ({ initVat }, params) => {
    return await initVat(
      params.vatConfig,
      new Map(params.state),
      params.allowedGlobalNames,
    );
  },
};
