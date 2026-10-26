import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Baggage } from '@metamask/ocap-kernel';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

/**
 * Build function for a persistent counter vat.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param vatPowers.logger - The logger for the vat.
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.name - The name of the vat.
 * @param baggage - Root of vat's persistent state.
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  parameters: { name?: string },
  baggage: Baggage,
) {
  const name = parameters?.name ?? 'Counter';
  const logger = unwrapTestLogger(vatPowers, name);
  const tlog = (message: string): void => logger(`${name}: ${message}`);

  let count: number;
  if (baggage.has('count')) {
    // Resume from persistent state
    count = baggage.get('count') as number;
    tlog(`resumed with count: ${count}`);
  } else {
    // Initialize new counter
    count = 1;
    baggage.init('count', count);
    tlog(`initialized with count: ${count}`);
  }

  return makeDefaultExo('counter', {
    async bootstrap() {
      tlog(`bootstrap called`);
      return `Counter initialized with count: ${count}`;
    },

    async resume() {
      tlog(`resume called`);
      // Increment the counter when resume is called
      count += 1;
      baggage.set('count', count);
      tlog(`incremented to: ${count}`);
      return `Counter incremented to: ${count}`;
    },
  });
}
