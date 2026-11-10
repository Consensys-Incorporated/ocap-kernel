import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type Bob = {
  bobInit: () => Promise<unknown>;
  bobGen: () => undefined;
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
 * @param parameters.limit - The limit for the test.
 * @param _baggage - Root of vat's persistent state (not used here).
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  parameters: { name?: string; test?: string; limit?: string | number } = {},
  _baggage: unknown = null,
) {
  const name = parameters?.name ?? 'anonymous';
  const test = parameters?.test ?? 'unspecified';
  const limit = Number(parameters?.limit ?? 3);
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

  /**
   * Wait for the next promise in the chain.
   *
   * @param who - Who to take the next step.
   * @param prevP - Promise for the previous step.
   * @returns A string at the end.
   */
  async function waitFor(
    who: Bob,
    prevP: Promise<unknown>,
  ): Promise<string | void> {
    tlog(`waitFor start`);
    return prevP.then(
      async (res: unknown) => {
        const [value, nextPrevP] = res as [number, Promise<unknown>];
        if (value < limit) {
          tlog(`count ${value} < ${limit}, recurring...`);
          await E(who).bobGen();
          return waitFor(who, nextPrevP);
        }
        tlog(`finishing chain`);
        return 'end of chain';
      },
      (rej: unknown) => {
        tlog(`Bob rejected, ${String(rej)}`);
      },
    );
  }

  let bobResolve: ((value: unknown) => void) | null = null;
  let bobValue = 0;

  return makeDefaultExo('root', {
    async bootstrap(vats: { bob: Bob }) {
      log(`bootstrap start`);
      tlog(`running test ${test}`);

      const bobReadyP = E(vats.bob).bobInit();
      await E(vats.bob).bobGen();
      const doneP = waitFor(vats.bob, bobReadyP);
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

    async bobInit() {
      log(`bobInit`);
      const { promise, resolve } = makePromiseKit();
      bobResolve = resolve;
      return promise;
    },
    bobGen() {
      log(`bobGen start`);
      const { promise, resolve } = makePromiseKit();
      const next = [bobValue, promise];
      bobValue += 1;
      tlog(`bobGen set value to ${bobValue}`);
      bobResolve?.(next);
      bobResolve = resolve;
      log(`bobGen done`);
    },
  });
}
