import { makePromiseKit } from '@endo/promise-kit';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

// oxlint-disable-next-line no-console
console.log('global uncaught rejection');

const { reject } = makePromiseKit();

reject('from global scope');

/**
 * Build function for vats that will reject a promise in global scope.
 *
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  // oxlint-disable-next-line no-console
  return makeDefaultExo('root', { bootstrap: () => console.log('bootstrap') });
}
