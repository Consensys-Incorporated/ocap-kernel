import type { MethodSpec, Handler } from '@metamask/kernel-rpc-methods';
import { string, object } from '@metamask/superstruct';

import type { Kernel } from '../../Kernel.ts';
import type { KRef } from '../../types.ts';
import { KRefStruct } from '../../types.ts';

/**
 * Mint another OCAP URL for a kernel object that already has one issued.
 */
export const getIssuedOcapURLSpec: MethodSpec<
  'getIssuedOcapURL',
  { kref: KRef },
  string
> = {
  method: 'getIssuedOcapURL',
  params: object({ kref: KRefStruct }),
  result: string(),
};

export type GetIssuedOcapURLHooks = {
  kernel: Pick<Kernel, 'getIssuedOcapURL'>;
};

export const getIssuedOcapURLHandler: Handler<
  'getIssuedOcapURL',
  { kref: KRef },
  Promise<string>,
  GetIssuedOcapURLHooks
> = {
  ...getIssuedOcapURLSpec,
  hooks: { kernel: true },
  implementation: async ({ kernel }, { kref }): Promise<string> => {
    return kernel.getIssuedOcapURL(kref);
  },
};
