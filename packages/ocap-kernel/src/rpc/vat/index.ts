import type { Infer } from '@metamask/superstruct';

import { deliverSpec, deliverHandler } from './deliver.ts';
import { initVatSpec, initVatHandler } from './initVat.ts';
import { pingSpec, pingHandler } from './ping.ts';
import type { PingSpec } from './ping.ts';

export const vatHandlers = {
  deliver: deliverHandler,
  initVat: initVatHandler,
  ping: pingHandler,
};

export const vatMethodSpecs = {
  deliver: deliverSpec,
  initVat: initVatSpec,
  ping: pingSpec,
};

type Handlers = (typeof vatHandlers)[keyof typeof vatHandlers];

export type VatMethod = Handlers['method'];

export type PingVatResult = Infer<PingSpec['result']>;
