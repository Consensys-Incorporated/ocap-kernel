import { makeHttpSpecification } from './shared.ts';
import type { HttpSpecification } from './shared.ts';
import type { HttpConfigStruct } from './types.ts';

const specification: HttpSpecification = makeHttpSpecification({
  makeBaseFetch: () => fetch,
});

// eslint-disable-next-line prefer-destructuring -- annotated for declaration emit
export const configStruct: HttpConfigStruct = specification.configStruct;
export const { capabilityFactory } = specification;
