import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type TestService = { getStuff: (obj: unknown, tag: string) => string };

/**
 * Build function for running a test of kernel service objects.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param vatPowers.logger - The logger for the vat.
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.name - The name of the vat.
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  parameters: { name?: string } = {},
) {
  const name = parameters?.name ?? 'anonymous';
  const tlog = unwrapTestLogger(vatPowers, name);
  // oxlint-disable-next-line no-console
  console.log(`buildRootObject "${name}"`);

  const thing = makeDefaultExo('thing', {});
  let testService: TestService;
  tlog(`buildRootObject "${name}"`);

  const mainVatRoot = makeDefaultExo('root', {
    async bootstrap(_vats: unknown, services: { testService: TestService }) {
      tlog(`vat ${name} is bootstrap`);
      testService = services.testService;
    },
    async go() {
      const serviceResult = await E(testService).getStuff(thing, 'hello');
      tlog(`kernel service returns ${serviceResult}`);
      await E(mainVatRoot).loopback();
    },
    async goBadly() {
      try {
        // @ts-expect-error Deliberately calls a method the service lacks.
        const serviceResult = await E(testService).nonexistentMethod(
          thing,
          'hello',
        );
        tlog(`kernel service returns ${serviceResult} and it shouldn't have`);
      } catch (problem) {
        tlog(`kernel service threw: ${(problem as Error).message}`);
      }
      await E(mainVatRoot).loopback();
    },
    loopback() {
      return undefined;
    },
  });
  return mainVatRoot;
}
