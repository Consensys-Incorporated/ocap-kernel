import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type {
  AccountabilityRecord,
  Chain,
  OcapURLIssuerService,
  OcapURLRedemptionService,
  Receipt,
  TrackOptions,
} from '@metamask/ocap-kernel';

type Accountability = {
  track(obj: unknown, options?: TrackOptions): Promise<void>;
  untrack(obj: unknown): Promise<void>;
  history(obj: unknown): Promise<AccountabilityRecord[]>;
  chain(obj: unknown): Promise<Chain>;
  trace(traceId: string): Promise<AccountabilityRecord[]>;
  receipt(): Promise<Receipt>;
};

type Peer = {
  receive(obj: unknown, accountability: Accountability): Promise<string>;
  receiptFromHeld(): Promise<Receipt>;
  adopt(obj: unknown): Promise<void>;
};

/**
 * A service the vat was given, or an error naming it.
 *
 * @param service - The service, if it was given.
 * @param name - What the error names.
 * @returns The service.
 */
const need = <Service>(service: Service | undefined, name: string): Service => {
  if (service === undefined) {
    throw Error(`no ${name}`);
  }
  return service;
};

/**
 * Build function for a vat that tracks an object it exports and reads the
 * record of what was done with it. The same bundle plays the holder, which
 * exercises what it is handed, and a holder on another kernel, reached by
 * ocap URL.
 *
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  let accountability: Accountability;
  let issuer: OcapURLIssuerService | undefined;
  let redeemer: OcapURLRedemptionService | undefined;
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

  const root = makeDefaultExo('root', {
    bootstrap(
      vats: { holder: Peer },
      services: {
        accountability: Accountability;
        ocapURLIssuerService?: OcapURLIssuerService;
        ocapURLRedemptionService?: OcapURLRedemptionService;
      },
    ): void {
      holder = vats.holder;
      accountability = services.accountability;
      issuer = services.ocapURLIssuerService;
      redeemer = services.ocapURLRedemptionService;
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

    async trace(traceId: string): Promise<AccountabilityRecord[]> {
      return E(accountability).trace(traceId);
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

    /**
     * An ocap URL for this vat, for a vat on another kernel to hand things
     * to.
     *
     * @returns The URL.
     */
    async issue(): Promise<string> {
      return E(need(issuer, 'ocapURLIssuerService')).issue(root);
    },

    async adopt(obj: unknown): Promise<void> {
      held = obj;
    },

    async trackHeld(options?: TrackOptions): Promise<void> {
      await E(accountability).track(held, options);
    },

    /**
     * Hand the thing, or what this vat was handed, to a vat on another
     * kernel.
     *
     * @param url - The other vat's ocap URL.
     * @param which - Which to hand over.
     */
    async handOverTo(url: string, which: 'thing' | 'held'): Promise<void> {
      const peer = (await E(need(redeemer, 'ocapURLRedemptionService')).redeem(
        url,
      )) as Peer;
      await E(peer).adopt(which === 'thing' ? thing : held);
    },
  });
  return root;
}
