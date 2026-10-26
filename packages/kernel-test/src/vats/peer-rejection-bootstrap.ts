import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

type Peer = { ping: () => unknown };

/**
 * Bootstrap vat for testing peer-rejection propagation.
 * Receives a `peer` root reference that may be a rejected kernel promise
 * (e.g. if the peer vat failed to launch), and logs whether calls resolve
 * or reject so integration tests can inspect the outcome.
 *
 * @returns The root object for this vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  return makeDefaultExo('root', {
    async bootstrap({ peer }: { peer: Peer }) {
      await E(peer)
        .ping()
        // oxlint-disable-next-line no-console
        .then(() => console.log('peer resolved'))
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          // oxlint-disable-next-line no-console
          console.log(`peer rejected: ${message}`);
        });
    },
  });
}
