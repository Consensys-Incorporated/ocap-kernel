import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { AccountabilityRecord, TrackOptions } from '@metamask/ocap-kernel';

type Accountability = {
  track(obj: unknown, options?: TrackOptions): Promise<void>;
  untrack(obj: unknown): Promise<void>;
  history(obj: unknown): Promise<AccountabilityRecord[]>;
};

type Peer = {
  receive(obj: unknown): Promise<string>;
};

/**
 * Build function for a vat that tracks an object it exports and reads the
 * record of what was done with it. The same bundle plays the holder, which
 * exercises what it is handed.
 *
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  let accountability: Accountability;
  let holder: Peer;

  const thing = makeDefaultExo('thing', {
    poke(): string {
      return 'poked';
    },
  });

  return makeDefaultExo('root', {
    bootstrap(
      vats: { holder: Peer },
      services: { accountability: Accountability },
    ): void {
      holder = vats.holder;
      accountability = services.accountability;
    },

    async track(options?: TrackOptions): Promise<void> {
      await E(accountability).track(thing, options);
    },

    async untrack(): Promise<void> {
      await E(accountability).untrack(thing);
    },

    /**
     * Hand the thing to the holder, which pokes it.
     *
     * @returns What the poke returned.
     */
    async handOver(): Promise<string> {
      return E(holder).receive(thing);
    },

    async history(): Promise<AccountabilityRecord[]> {
      return E(accountability).history(thing);
    },

    async receive(obj: { poke(): string }): Promise<string> {
      return E(obj).poke();
    },
  });
}
