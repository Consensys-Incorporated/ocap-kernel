import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type Thing = { second: (param: unknown) => string };

type Bob = {
  first: () => Thing;
  loopback: () => undefined;
};

/**
 * Build function for vats that will run various tests.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param vatPowers.logger - The logger for the vat.
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.name - The name of the vat.
 * @param parameters.test - The test to run.
 * @param _baggage - Root of vat's persistent state (not used here).
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  parameters: { name?: string; test?: string } = {},
  _baggage: unknown = null,
) {
  const name = parameters?.name ?? 'anonymous';
  const test = parameters?.test ?? 'unspecified';
  const tlog = unwrapTestLogger(vatPowers, name);

  /**
   * Print a message to the log.
   *
   * @param message - The message to print.
   */
  function log(message: string): void {
    // oxlint-disable-next-line no-console
    console.log(`${name}: ${message}`);
  }

  log(`buildRootObject`);
  log(`configuration parameters: ${JSON.stringify(parameters)}`);

  const thing = makeDefaultExo('thing', {
    second() {
      tlog(`thing.second`);
      return `Bob's second answer`;
    },
  });

  return makeDefaultExo('root', {
    async bootstrap(vats: { bob: Bob }) {
      log(`bootstrap start`);
      tlog(`running test ${test}`);
      const promise1 = E(vats.bob).first();
      const promise2 = E(promise1).second(promise1);
      const doneP = Promise.all([
        promise1.then(
          (res: unknown) => {
            tlog(`first result resolved to ${String(res)}`);
            return 'p1succ';
          },
          (rej: unknown) => {
            tlog(`first result rejected with ${String(rej)}`);
            return 'p1fail';
          },
        ),
        promise2.then(
          (res: unknown) => {
            tlog(`second result resolved to ${String(res)}`);
            return 'p2succ';
          },
          (rej: unknown) => {
            tlog(`second result rejected with ${String(rej)}`);
            return 'p2fail';
          },
        ),
      ]);
      await E(vats.bob).loopback();
      return doneP;
    },

    // This is a hack that effectively does the job of stdout.flush() even
    // though we don't have access to stdout itself here. It makes sure we
    // capture all the log output prior to the return value from `bootstrap`
    // resolving.
    loopback() {
      return undefined;
    },

    first() {
      tlog(`first`);
      return thing;
    },
  });
}
