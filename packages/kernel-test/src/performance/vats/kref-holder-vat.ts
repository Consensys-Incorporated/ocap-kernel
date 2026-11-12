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

    // Mint tokens, use one, and drop them all, leaving garbage in both vats.
    async churn(count: number) {
      const [token] = await E(minter as Minter).mint(count);
      return E(token as Token).ping();
    },

    // Mint a token and hand it to the caller without keeping it.
    async fetch() {
      const [token] = await E(minter as Minter).mint(1);
      return token;
    },
  });
}
