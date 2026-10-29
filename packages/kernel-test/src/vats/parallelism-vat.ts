import { makeDefaultExo } from '@metamask/kernel-utils/exo';

/**
 * Build a vat that spends time in two ways: computing, which holds its
 * delivery (and so the crank) open, and waiting on a timer, which ends the
 * delivery and settles the result later.
 *
 * @returns The root object for the new vat.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function buildRootObject() {
  return makeDefaultExo('root', {
    bootstrap: () => undefined,

    spin: (iterations: number) => {
      let value = 0;
      for (let i = 0; i < iterations; i += 1) {
        value = (value * 31 + i) % 1_000_003;
      }
      return value;
    },

    sleep: async (ms: number) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(ms), ms);
      }),
  });
}
