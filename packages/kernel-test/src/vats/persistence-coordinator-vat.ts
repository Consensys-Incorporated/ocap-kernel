/* global harden */
import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Baggage } from '@metamask/ocap-kernel';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type Worker = { resume: () => string };

/**
 * Build function for a persistent coordinator vat.
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
  const name = parameters?.name ?? 'Coordinator';
  const logger = unwrapTestLogger(vatPowers, name);
  const tlog = (message: string): void => logger(`${name}: ${message}`);

  let workCount: number;
  let workers: { worker1?: Worker; worker2?: Worker };

  if (baggage.has('workCount')) {
    workCount = baggage.get('workCount') as number;
    workers = baggage.get('workers') as {
      worker1?: Worker;
      worker2?: Worker;
    };
    tlog(`resumed with work count: ${workCount}`);
  } else {
    workCount = 0;
    workers = {};
    baggage.init('workCount', workCount);
    tlog(`initialized`);
  }

  return makeDefaultExo('coordinator', {
    async bootstrap(vats: { worker1: Worker; worker2: Worker }) {
      tlog(`bootstrap called`);
      if (!baggage.has('workers')) {
        // Store worker references for persistence
        workers = {
          worker1: vats.worker1,
          worker2: vats.worker2,
        };
        baggage.init('workers', harden(workers));
        tlog(`stored ${Object.keys(workers).length} workers`);
      }
      return `Coordinator initialized with ${Object.keys(workers).length} workers`;
    },

    async resume() {
      tlog(`resume called`);
      if (!workers?.worker1 || !workers.worker2) {
        tlog(`no workers available`);
        return `No workers available`;
      }
      const [result1, result2] = await Promise.all([
        E(workers.worker1).resume(),
        E(workers.worker2).resume(),
      ]);
      workCount += 1;
      baggage.set('workCount', workCount);
      const message = `Work completed: ${result1}, ${result2}`;
      tlog(message);
      return message;
    },
  });
}
