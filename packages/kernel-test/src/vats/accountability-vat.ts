import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type {
  AccountabilityRecord,
  Chain,
  Receipt,
  TrackOptions,
} from '@metamask/ocap-kernel';

type Accountability = {
  track(obj: unknown, options?: TrackOptions): Promise<void>;
  untrack(obj: unknown): Promise<void>;
  history(obj: unknown): Promise<AccountabilityRecord[]>;
  chain(obj: unknown): Promise<Chain>;
  receipt(): Promise<Receipt>;
};

type Peer = {
  receive(obj: unknown, accountability: Accountability): Promise<string>;
  receiptFromHeld(): Promise<Receipt>;
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
  let held: unknown;

  const thing = makeDefaultExo('thing', {
    poke(): string {
      return 'poked';
    },
    /**
     * A receipt for this delivery.
     *
     * @returns The receipt.
     */
    async receipt(): Promise<Receipt> {
      return E(accountability).receipt();
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
      return E(holder).receive(thing, accountability);
    },

    async history(): Promise<AccountabilityRecord[]> {
      return E(accountability).history(thing);
    },

    /**
     * The holder's chain of custody for what it was handed.
     *
     * @returns The chain.
     */
    async chain(): Promise<Chain> {
      return E(accountability).chain(held);
    },

    /**
     * Have the holder ask the thing for a receipt, so the delivery the
     * receipt is for crosses vats and the kernel sees it.
     *
     * @returns The receipt.
     */
    async receipt(): Promise<Receipt> {
      return E(holder).receiptFromHeld();
    },

    async receiptFromHeld(): Promise<Receipt> {
      return E(held as { receipt(): Promise<Receipt> }).receipt();
    },

    async receive(
      obj: { poke(): string },
      service: Accountability,
    ): Promise<string> {
      held = obj;
      accountability = service;
      return E(obj).poke();
    },
  });
}
