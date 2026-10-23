import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

type Token = { ping: () => string };
type Minter = { mint: (count: number) => Token[] };

/**
 * Build function for a vat that imports and holds the minter's objects, which
 * keeps every one of them reachable and thus a live kref.
 *
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  let minter: Minter | undefined;
  const held: Token[] = [];

  return makeDefaultExo('root', {
    bootstrap({ minter: minterRoot }: { minter: Minter }) {
      minter = minterRoot;
    },

    async grow(count: number) {
      const batch = await E(minter as Minter).mint(count);
      held.push(...batch);
      return held.length;
    },

    ping() {
      return 'pong';
    },

    async pingHeld(index: number) {
      return E(held[index] as Token).ping();
    },
  });
}
