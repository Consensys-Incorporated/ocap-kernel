import { E } from '@endo/eventual-send';
import { makeAccounting } from '@metamask/kernel-utils/accountable';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type {
  AccountabilityRecordView,
  Chain,
  TrackOptions,
} from '@metamask/ocap-kernel';

type Accountability = {
  track(obj: unknown, options?: TrackOptions): Promise<void>;
  history(obj: unknown): Promise<AccountabilityRecordView[]>;
  chain(obj: unknown): Promise<Chain>;
  trace(traceId: string): Promise<AccountabilityRecordView[]>;
  exercise(obj: unknown, method: string): Promise<void>;
  convey(obj: unknown, to: unknown): Promise<void>;
};

type Peer = {
  receive(obj: unknown, accountability: Accountability): Promise<string>;
  ping(): Promise<string>;
};

/** What liveslots gives a vat for durable kinds. */
type VatData = {
  makeKindHandle: (tag: string) => unknown;
  defineDurableKind: <Init extends (...args: never[]) => unknown>(
    kindHandle: unknown,
    init: Init,
    behavior: Record<string, unknown>,
  ) => (...args: Parameters<Init>) => unknown;
};

/**
 * Long enough that the delivery a callback is scheduled in has ended before
 * it runs, since one that runs during the delivery is the delivery's work.
 */
const AFTER_DELIVERY = 100;

/**
 * Build function for a vat that accounts for its objects below the kernel:
 * one that wraps an object with `accountable`, declares a hand-off with
 * `convey`, keeps what it is handed in durable state, and sends from timer
 * callbacks. The same bundle plays the holder.
 *
 * @param vatPowers - The vat's powers.
 * @param vatPowers.VatData - Durable kinds.
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject({ VatData }: { VatData: VatData }) {
  let accountability: Accountability;
  let holder: Peer;
  let convey: (obj: unknown, to: unknown) => Promise<void>;
  let held: { poke(): string };
  let thing: { poke(): string };
  let pinged: Promise<string> | undefined;

  const makeKeeper = VatData.defineDurableKind(
    VatData.makeKindHandle('keeper'),
    (kept: unknown) => ({ kept }),
    {
      keep({ state }: { state: { kept: unknown } }, kept: unknown): void {
        state.kept = kept;
      },
    },
  ) as (kept: unknown) => { keep(kept: unknown): void };
  let keeper: { keep(kept: unknown): void } | undefined;

  const root = makeDefaultExo('root', {
    bootstrap(
      vats: { holder: Peer },
      services: { accountability: Accountability },
    ): void {
      holder = vats.holder;
      accountability = services.accountability;
      const accounting = makeAccounting(accountability);
      ({ convey } = accounting);
      const { accountable } = accounting;
      thing = accountable(
        makeDefaultExo('thing', {
          /**
           * Poke the thing, which pings the holder from a timer callback.
           *
           * @returns What a poke returns.
           */
          poke(): string {
            pinged = new Promise((resolve) => {
              setTimeout(() => resolve(E(holder).ping()), AFTER_DELIVERY);
            });
            return 'poked';
          },
        }),
      );
    },

    async track(options?: TrackOptions): Promise<void> {
      await E(accountability).track(thing, options);
    },

    /**
     * Hand the thing to the holder, which pokes it.
     *
     * @returns What the poke returned.
     */
    async handOver(): Promise<string> {
      return E(holder).receive(thing, accountability);
    },

    /**
     * Declare the thing handed to the holder, without handing it over.
     */
    async declare(): Promise<void> {
      await convey(thing, holder);
    },

    async history(): Promise<AccountabilityRecordView[]> {
      return E(accountability).history(thing);
    },

    async trace(traceId: string): Promise<AccountabilityRecordView[]> {
      return E(accountability).trace(traceId);
    },

    /**
     * What the ping the last poke scheduled returned.
     *
     * @returns What a ping returns.
     */
    async awaitPing(): Promise<string | undefined> {
      return pinged;
    },

    async receive(
      obj: { poke(): string },
      service: Accountability,
    ): Promise<string> {
      held = obj;
      accountability = service;
      return E(obj).poke();
    },

    ping(): string {
      return 'pinged';
    },

    async pokeHeld(): Promise<string> {
      return E(held).poke();
    },

    /**
     * Poke what this vat was handed from a timer callback, outside any
     * delivery.
     *
     * @returns What the poke returned.
     */
    async pokeHeldLater(): Promise<string> {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(E(held).poke());
        }, AFTER_DELIVERY);
      });
    },

    /**
     * Keep what this vat was handed in the state of a durable object.
     */
    keep(): void {
      if (keeper === undefined) {
        keeper = makeKeeper(held);
      } else {
        keeper.keep(held);
      }
    },

    /**
     * This vat's chain of custody for what it was handed.
     *
     * @returns The chain.
     */
    async chainOfHeld(): Promise<Chain> {
      return E(accountability).chain(held);
    },
  });
  return root;
}
