import { makeFsSpecification } from './shared.ts';
import type { FsPlatformOptions, FsSpecification } from './shared.ts';
import type {
  Access,
  FsConfigStruct,
  PathSegments,
  ReadFile,
} from './types.ts';

// The operations exist so the browser's exo carries the same guards as any other
// platform's; they refuse when called rather than when constructed, since the
// capability now builds every method and narrows to the configured ones.
const notImplemented = (name: string) => async (): Promise<never> => {
  throw new Error(`Capability ${name} is not implemented in the browser`);
};

// Exported so the tests can build the same base the specification narrows.
// Nothing here carries authority: both operations only throw.
export const browserFsOptions: FsPlatformOptions = {
  makeReadFile: () => notImplemented('readFile') as unknown as ReadFile,
  makeAccess: () => notImplemented('access') as unknown as Access,
  makePathCaveat: () => () => undefined,
  toPath: (segments: PathSegments) => `/${segments.join('/')}`,
};

const specification: FsSpecification = makeFsSpecification(browserFsOptions);

// eslint-disable-next-line prefer-destructuring -- annotated for declaration emit
export const configStruct: FsConfigStruct = specification.configStruct;
export const { capabilityFactory } = specification;
