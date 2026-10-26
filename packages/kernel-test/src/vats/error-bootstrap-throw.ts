import { makeDefaultExo } from '@metamask/kernel-utils/exo';

// oxlint-disable-next-line no-console
console.log('bootstrap throw');

/**
 * Build function for vats that will throw an error during bootstrap.
 *
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  // oxlint-disable-next-line no-console
  console.log('buildRootObject');
  return makeDefaultExo('root', {
    bootstrap: () => {
      // oxlint-disable-next-line no-console
      console.log('bootstrap');
      throw new Error('from bootstrap');
    },
  });
}
