import { capabilityFactory as fsCapabilityFactory } from './capabilities/fs/nodejs.ts';
import { capabilityFactory as httpCapabilityFactory } from './capabilities/http/default.ts';
import { makePlatformFactory } from './factory.ts';

export const makePlatform = makePlatformFactory({
  http: httpCapabilityFactory,
  fs: fsCapabilityFactory,
});
