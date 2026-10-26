import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type Bob = {
  genPromise1: () => Promise<unknown>;
  genPromise2: () => Promise<unknown>;
  resolveBoth: (resolutionX: unknown, resolutionY: unknown) => void;
  resolve1: (resolution: unknown) => void;
  resolve2: (resolution: unknown) => void;
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

  /**
   * Test if a value is a promise.
   *
   * @param value - The value to test.
   * @returns True iff `value` is a promise.
   */
  function isPromise(value: unknown): boolean {
    return Promise.resolve(value) === value;
  }

  log(`buildRootObject`);
  log(`configuration parameters: ${JSON.stringify(parameters)}`);

  let promise1: Promise<unknown>;
  let resolve1: (value: unknown) => void;
  let promise2: Promise<unknown>;
  let resolve2: (value: unknown) => void;

  return makeDefaultExo('root', {
    async bootstrap(vats: { bob: Bob }) {
      log(`bootstrap start`);
      tlog(`running test ${test}`);
      const promiseX = E(vats.bob).genPromise1();
      const promiseY = E(vats.bob).genPromise2();
      if (test === 'promiseCycle') {
        await E(vats.bob).resolveBoth([promiseX], [promiseY]);
      } else if (test === 'promiseCycleMultiCrank') {
        await E(vats.bob).resolve1([promiseY]);
        await E(vats.bob).resolve2([promiseX]);
      } else {
        throw Error(`unknown test ${test}`);
      }

      const resolutionX = (await promiseX) as unknown[];
      const resolutionY = (await promiseY) as unknown[];
      tlog(`isPromise(resolutionX[0]): ${isPromise(resolutionX[0])}`);
      tlog(`isPromise(resolutionY[0]): ${isPromise(resolutionY[0])}`);
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

    async genPromise1() {
      tlog(`genPromise1`);
      const { promise, resolve } = makePromiseKit();
      promise1 = promise;
      resolve1 = resolve;
      return promise1;
    },
    async genPromise2() {
      tlog(`genPromise2`);
      const { promise, resolve } = makePromiseKit();
      promise2 = promise;
      resolve2 = resolve;
      return promise2;
    },
    resolveBoth(resolutionX: unknown, resolutionY: unknown) {
      tlog(`resolveBoth`);
      resolve1(resolutionY);
      resolve2(resolutionX);
    },
    resolve1(resolution: unknown) {
      tlog(`resolve1`);
      resolve1(resolution);
    },
    resolve2(resolution: unknown) {
      tlog(`resolve2`);
      resolve2(resolution);
    },
  });
}
