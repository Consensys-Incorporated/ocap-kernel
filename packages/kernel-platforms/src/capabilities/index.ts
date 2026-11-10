import { object, exactOptional } from '@metamask/superstruct';

import { fsConfigStruct } from './fs/types.ts';
import type { FsCapability, FsConfig } from './fs/types.ts';
import { httpConfigStruct } from './http/types.ts';
import type { HttpCapability, HttpConfig } from './http/types.ts';

/**
 * Registry of all platform capabilities (platform-agnostic)
 */
export type PlatformCapabilityRegistry = {
  http: {
    config: HttpConfig;
    capability: HttpCapability;
  };
  fs: {
    config: FsConfig;
    capability: FsCapability;
  };
};

// Create validation struct for PlatformConfig
export const platformConfigStruct = object({
  http: exactOptional(httpConfigStruct),
  fs: exactOptional(fsConfigStruct),
});
