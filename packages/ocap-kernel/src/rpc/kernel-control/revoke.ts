import type { MethodSpec, Handler } from '@metamask/kernel-rpc-methods';
import { literal, object } from '@metamask/superstruct';

import type { Kernel } from '../../Kernel.ts';
import type { KRef } from '../../types.ts';
import { KRefStruct } from '../../types.ts';

/**
 * Revoke a kernel object.
 */
export const revokeSpec: MethodSpec<'revoke', { kref: KRef }, null> = {
  method: 'revoke',
  params: object({ kref: KRefStruct }),
  result: literal(null),
};

export type RevokeHooks = {
  kernel: Pick<Kernel, 'revoke'>;
};

export const revokeHandler: Handler<
  'revoke',
  { kref: KRef },
  Promise<null>,
  RevokeHooks
> = {
  ...revokeSpec,
  hooks: { kernel: true },
  implementation: async (
    { kernel }: RevokeHooks,
    { kref }: { kref: KRef },
  ): Promise<null> => {
    await kernel.revoke(kref);
    return null;
  },
};
