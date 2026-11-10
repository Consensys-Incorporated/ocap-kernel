/* global harden */
import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Baggage } from '@metamask/ocap-kernel';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type Peer = {
  intro: (bootVat: unknown) => void;
  greet: (greeting: string) => string;
  loopback: () => undefined;
};

/**
 * Build function for generic test vat.
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
  const name = parameters?.name ?? 'anonymous';
  const logger = unwrapTestLogger(vatPowers, name);
  const tlog = (message: string): void => logger(`${name}: ${message}`);

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

  let startCount: number;
  if (baggage.has('name')) {
    const savedName = baggage.get('name') as string;
    tlog(`saved name is ${savedName}`);

    startCount = (baggage.get('startCount') as number) + 1;
    baggage.set('startCount', startCount);
  } else {
    baggage.init('name', name);
    tlog(`saving name`);

    baggage.init('startCount', 1);
    startCount = 1;
  }
  tlog(`start count: ${startCount}`);

  const me = makeDefaultExo('root', {
    async bootstrap(vats: { bob: Peer; carol: Peer }) {
      tlog(`bootstrap()`);
      // Explanation for the following bit of gymnastics: we'd like to save
      // `vats` itself in the baggage, but we can't because the entry for our
      // own root is a local reference and thus not durable, and we can't remove
      // this entry from `vats` directly because, being a parameter object, it
      // arrived hardened.  So instead we have to copy it sans the unwritable element.
      const writeVats: Record<string, unknown> = {};
      for (const [prop, value] of Object.entries(vats)) {
        if (value !== me) {
          writeVats[prop] = value;
        }
      }
      baggage.init('vats', harden(writeVats));

      const pIntroB = E(vats.bob).intro(me);
      const pIntroC = E(vats.carol).intro(me);
      const pGreetB = E(vats.bob).greet(`hello from ${name}`);
      const pGreetC = E(vats.carol).greet(`hello from ${name}`);
      const results = await Promise.all([pIntroB, pIntroC, pGreetB, pGreetC]);
      const [, , greetB, greetC] = results;
      tlog(`Bob answers greeting: '${greetB}'`);
      tlog(`Carol answers greeting: '${greetC}'`);
      tlog(`end bootstrap`);
      await E(vats.bob).loopback();
      return `bootstrap ${name}`;
    },
    intro(bootVat: unknown) {
      tlog(`intro()`);
      baggage.init('bootVat', bootVat);
    },
    greet(greeting: string) {
      tlog(`greet('${greeting}')`);
      return `${name} returns your greeting '${greeting}'`;
    },
    async resume() {
      tlog(`resume()`);
      if (baggage.has('vats')) {
        // I am the bootstrap vat
        tlog(`resumed vat is bootstrap`);
        const vats = baggage.get('vats') as { bob: Peer; carol: Peer };
        const pGreetB = E(vats.bob).greet(`hello again from ${name}`);
        const pGreetC = E(vats.carol).greet(`hello again from ${name}`);
        const [greetB, greetC] = await Promise.all([pGreetB, pGreetC]);
        tlog(`Bob answers greeting: '${greetB}'`);
        tlog(`Carol answers greeting: '${greetC}'`);
        await E(vats.bob).loopback();
      }
      if (baggage.has('bootVat')) {
        // I am Bob or Carol
        tlog(`resumed vat is not bootstrap`);
        const bootVat = baggage.get('bootVat') as Peer;
        const greetBack = await E(bootVat).greet(`hello boot vat from ${name}`);
        tlog(`boot vat returns greeting with '${greetBack}'`);
        await E(bootVat).loopback();
      }
      tlog(`end resume`);
      return `resume ${name}`;
    },
    loopback() {
      return undefined;
    },
  });
  return me;
}
