import { makeFsSpecification } from './shared.ts';

const notImplemented = (name: string): never => {
  throw new Error(`Capability ${name} is not implemented in the browser`);
};

export const { configStruct, capabilityFactory } = makeFsSpecification({
  promises: {
    makeReadFile: () => notImplemented('readFile'),
    makeAccess: () => notImplemented('access'),
  },
  makePathCaveat: () => () => undefined,
});
