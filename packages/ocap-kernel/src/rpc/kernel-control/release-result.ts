import type { MethodSpec, Handler } from '@metamask/kernel-rpc-methods';
import { literal, tuple } from '@metamask/superstruct';

import type { Kernel } from '../../Kernel.ts';
import type { KRef } from '../../types.ts';
import { KRefStruct } from '../../types.ts';

/**
 * Release the result of a `queueMessage` call, named by its `kpid`.
 */
export const releaseResultSpec: MethodSpec<
  'releaseResult',
  [KRef],
  Promise<null>
> = {
  method: 'releaseResult',
  params: tuple([KRefStruct]),
  result: literal(null),
};

export type ReleaseResultHooks = { kernel: Pick<Kernel, 'releaseResult'> };

export const releaseResultHandler: Handler<
  'releaseResult',
  [KRef],
  Promise<null>,
  ReleaseResultHooks
> = {
  ...releaseResultSpec,
  hooks: { kernel: true },
  implementation: async ({ kernel }, [kpid]): Promise<null> => {
    await kernel.releaseResult({ kpid });
    return null;
  },
};
