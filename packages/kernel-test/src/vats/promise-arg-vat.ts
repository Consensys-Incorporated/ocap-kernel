import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type Bob = {
  hereIsAPromise: (promise: Promise<unknown>) => Promise<unknown>;
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

  return makeDefaultExo('root', {
    async bootstrap(vats: { bob: Bob }) {
      log(`bootstrap start`);
      tlog(`running test ${test}`);
      let doneP: Promise<unknown> = Promise.resolve('no activity');
      if (!['promiseArg1', 'promiseArg2', 'promiseArg3'].includes(test)) {
        throw Error(`unknown test ${test}`);
      }
      let resolver: ((value: unknown) => void) | undefined;
      const param = new Promise((resolve, _reject) => {
        resolver = resolve;
      });
      if (test === 'promiseArg2') {
        tlog(`resolving the promise that will be sent to Bob`);
        resolver?.(`${name} said hi before send`);
      }
      tlog(`sending the promise to Bob`);
      const responseFromBob = E(vats.bob).hereIsAPromise(param);
      if (test === 'promiseArg1') {
        tlog(`resolving the promise that was sent to Bob`);
        resolver?.(`${name} said hi after send`);
      }
      tlog(`awaiting Bob's response`);
      doneP = responseFromBob.then(
        async (res: unknown) => {
          const [bobDoneP, bobDoneMsg] = res as [Promise<unknown>, string];
          tlog(`Bob's response to hereIsAPromise: '${bobDoneMsg}'`);
          if (test === 'promiseArg3') {
            tlog(`resolving the promise that was sent to Bob`);
            resolver?.(`${name} said hi after Bob's reply`);
          }
          return bobDoneP;
        },
        (rej: unknown) => {
          tlog(`Bob's response to hereIsAPromise rejected as '${String(rej)}'`);
          return 'bobFail';
        },
      );
      await E(vats.bob).loopback();
      return await doneP;
    },

    // This is a hack that effectively does the job of stdout.flush() even
    // though we don't have access to stdout itself here. It makes sure we
    // capture all the log output prior to the return value from `bootstrap`
    // resolving.
    loopback() {
      return undefined;
    },

    async hereIsAPromise(promise: Promise<unknown>) {
      log(`hereIsAPromise start`);
      const doneP = promise.then(
        (res: unknown) => {
          tlog(`the promise parameter resolved to '${String(res)}'`);
          return 'bobPSucc';
        },
        (rej: unknown) => {
          tlog(`the promise parameter rejected as '${String(rej)}'`);
          return 'bobPFail';
        },
      );
      log(`hereIsAPromise done`);
      return [doneP, `${name}.hereIsAPromise done`];
    },
  });
}
