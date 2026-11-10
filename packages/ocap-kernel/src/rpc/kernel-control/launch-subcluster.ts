import type { MethodSpec, Handler } from '@metamask/kernel-rpc-methods';
import { object, nullable, type as structType } from '@metamask/superstruct';

import type { Kernel } from '../../Kernel.ts';
import type {
  ClusterConfig,
  KRef,
  QueueMessageResult,
  SubclusterId,
} from '../../types.ts';
import {
  ClusterConfigStruct,
  QueueMessageResultStruct,
  SubclusterIdStruct,
  KRefStruct,
} from '../../types.ts';

/**
 * JSON-compatible version of SubclusterLaunchResult for RPC.
 * Uses null instead of undefined for JSON serialization.
 */
type LaunchSubclusterRpcResult = {
  subclusterId: SubclusterId;
  rootKref: KRef;
  bootstrapResult: QueueMessageResult | null;
};

const LaunchSubclusterRpcResultStruct = structType({
  subclusterId: SubclusterIdStruct,
  rootKref: KRefStruct,
  bootstrapResult: nullable(QueueMessageResultStruct),
});

export const launchSubclusterSpec: MethodSpec<
  'launchSubcluster',
  { config: ClusterConfig },
  Promise<LaunchSubclusterRpcResult>
> = {
  method: 'launchSubcluster',
  params: object({ config: ClusterConfigStruct }),
  result: LaunchSubclusterRpcResultStruct,
};

export type LaunchSubclusterHooks = {
  kernel: Pick<Kernel, 'launchSubcluster'>;
};

export const launchSubclusterHandler: Handler<
  'launchSubcluster',
  { config: ClusterConfig },
  Promise<LaunchSubclusterRpcResult>,
  LaunchSubclusterHooks
> = {
  ...launchSubclusterSpec,
  hooks: { kernel: true },
  implementation: async (
    { kernel }: LaunchSubclusterHooks,
    params: { config: ClusterConfig },
  ): Promise<LaunchSubclusterRpcResult> => {
    const result = await kernel.launchSubcluster(params.config);
    // Convert undefined to null for JSON compatibility
    return {
      subclusterId: result.subclusterId,
      rootKref: result.rootKref,
      bootstrapResult: result.bootstrapResult ?? null,
    };
  },
};
