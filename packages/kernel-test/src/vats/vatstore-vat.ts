import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Baggage } from '@metamask/ocap-kernel';

type Peer = {
  bump: (bumper: string) => void;
  go: (from: string, bumpee: Peer) => string;
  loopback: () => undefined;
};

type BaggageWithDelete = Baggage & {
  delete(key: string): void;
};

/**
 * Build function for running a test of the vatstore.
 *
 * @param _vatPowers - Special powers granted to this vat (not used here).
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.name - The name of the vat.
 * @param baggage - Root of vat's persistent state.
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  _vatPowers: unknown,
  parameters: { name?: string },
  baggage: BaggageWithDelete,
) {
  const name = parameters?.name ?? 'anonymous';
  // oxlint-disable-next-line no-console
  console.log(`buildRootObject "${name}"`);

  const testKey1 = 'thing';
  const testKey2 = 'goAway';

  return makeDefaultExo('root', {
    async bootstrap(vats: { bob: Peer; carol: Peer; alice: Peer }) {
      // oxlint-disable-next-line no-console
      console.log(`vat ${name} is bootstrap`);
      if (!baggage.has(testKey1)) {
        baggage.init(testKey1, 1);
      }
      baggage.init(testKey2, 'now you see me');
      const pb = E(vats.bob).go(name, vats.alice);
      const pc = E(vats.carol).go(name, vats.alice);
      // oxlint-disable-next-line no-console
      console.log(`vat ${name} got "go" answer from Bob: '${await pb}'`);
      // oxlint-disable-next-line no-console
      console.log(`vat ${name} got "go" answer from Carol: '${await pc}'`);
      baggage.delete(testKey2);
      await E(vats.bob).loopback();
    },
    bump(bumper: string) {
      const value = baggage.get(testKey1) as number;
      baggage.set(testKey1, value + 1);
      // oxlint-disable-next-line no-console
      console.log(`${bumper} bumps ${testKey1} from ${value} to ${value + 1}`);
    },
    go(from: string, bumpee: Peer) {
      const message = `vat ${name} got "go" from ${from}`;
      // oxlint-disable-next-line no-console
      console.log(message);
      // oxlint-disable-next-line typescript/no-floating-promises -- `go` does not wait for the bump
      E(bumpee).bump(name);
      return message;
    },
    loopback() {
      return undefined;
    },
  });
}
