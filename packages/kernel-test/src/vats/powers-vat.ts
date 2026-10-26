import { makeDefaultExo } from '@metamask/kernel-utils/exo';

/**
 * Build function for running a test of the vatstore.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param vatPowers.foo - Optional function to call.
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.bar - Optional bar parameter.
 * @param _baggage - Root of vat's persistent state.
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: { foo?: (bar: unknown) => Promise<unknown> },
  parameters: { bar?: unknown } = {},
  _baggage: unknown = null,
) {
  return makeDefaultExo('root', {
    async fizz() {
      return await vatPowers.foo?.(parameters.bar);
    },
  });
}
