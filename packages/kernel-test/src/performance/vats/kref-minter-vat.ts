import { defineExoClass } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

const TokenI = M.interface('Token', {
  ping: M.call().returns(M.string()),
});

/**
 * Build function for a vat that exports objects in bulk, so that each one it
 * mints becomes a kref once it leaves the vat.
 *
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  // One class for every token: `makeDefaultExo` defines a class per call,
  // which at a million objects would dominate the cost of exporting them.
  const makeToken = defineExoClass(
    'Token',
    TokenI,
    (serial: number) => ({ serial }),
    {
      ping() {
        return 'pong';
      },
    },
  );

  let nextSerial = 0;

  return makeDefaultExo('root', {
    mint(count: number) {
      return harden(
        Array.from({ length: count }, () => {
          nextSerial += 1;
          return makeToken(nextSerial);
        }),
      );
    },
  });
}
