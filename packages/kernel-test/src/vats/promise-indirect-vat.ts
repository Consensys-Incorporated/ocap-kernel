import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type Bob = {
  genPromise1: () => string;
  genPromise2: () => Promise<unknown>;
  resolve: (resolution: unknown[]) => void;
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

  let promise: Promise<unknown>;
  let resolve: (value: unknown) => void;

  return makeDefaultExo('root', {
    async bootstrap(vats: { bob: Bob }) {
      log(`bootstrap start`);
      tlog(`running test ${test}`);
      const promise1 = E(vats.bob).genPromise1();
      const promise2 = E(vats.bob).genPromise2();
      await E(vats.bob).resolve([promise1]);

      const resolution = await promise2;
      tlog(`resolution == ${String(resolution)}`);
      await E(vats.bob).loopback();
      return 'done';
    },

    // This is a hack that effectively does the job of stdout.flush() even
    // though we don't have access to stdout itself here. It makes sure we
    // capture all the log output prior to the return value from `bootstrap`
    // resolving.
    loopback() {
      return undefined;
    },

    genPromise1() {
      tlog(`genPromise1`);
      return 'hello';
    },
    async genPromise2() {
      tlog(`genPromise2`);
      const { promise: aPromise, resolve: aResolve } = makePromiseKit();
      promise = aPromise;
      resolve = aResolve;
      return promise;
    },
    resolve(resolution: unknown[]) {
      tlog(`resolve`);
      resolve(resolution[0]);
    },
  });
}
