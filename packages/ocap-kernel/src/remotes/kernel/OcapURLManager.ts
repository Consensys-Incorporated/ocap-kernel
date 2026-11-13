import { Far } from '@endo/marshal';

import { parseOcapURL } from './remote-comms.ts';
import type { RemoteManager } from './RemoteManager.ts';
import { kslot, krefOf } from '../../liveslots/kernel-marshal.ts';
import type { SlotValue } from '../../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../../store/index.ts';
import type { KRef } from '../../types.ts';

/**
 * The vat-facing shape of the `ocapURLIssuerService` kernel-service
 * endowment: accepts a remotable and returns an OCAP URL that resolves to
 * that remotable when redeemed elsewhere.
 */
export type OcapURLIssuerService = {
  issue: (obj: unknown) => Promise<string>;
};

/**
 * The vat-facing shape of the `ocapURLRedemptionService` kernel-service
 * endowment: accepts an OCAP URL and returns the referenced remotable.
 */
export type OcapURLRedemptionService = {
  redeem: (url: string) => Promise<unknown>;
};

type OcapURLManagerConstructorProps = {
  remoteManager: RemoteManager;
  kernelStore: KernelStore;
};

/**
 * Manages OCAP URL issuing and redemption.
 */
export class OcapURLManager {
  /** Remote manager for handling remote connections */
  readonly #remoteManager: RemoteManager;

  /** The kernel's store, for retaining the objects issued URLs name */
  readonly #kernelStore: KernelStore;

  /** OCAP URL issuer service object */
  readonly #ocapURLIssuerService: object;

  /** OCAP URL redemption service object */
  readonly #ocapURLRedemptionService: object;

  /**
   * Creates a new OcapURLManager instance.
   *
   * @param options - Constructor options.
   * @param options.remoteManager - The remote manager for handling cross-kernel communications.
   * @param options.kernelStore - The kernel's store.
   */
  constructor({ remoteManager, kernelStore }: OcapURLManagerConstructorProps) {
    this.#remoteManager = remoteManager;
    this.#kernelStore = kernelStore;

    // Create the OCAP URL issuer service
    this.#ocapURLIssuerService = Far('ocapURLIssuerService', {
      issue: async (obj: SlotValue): Promise<string> => {
        let kref: KRef;
        try {
          kref = krefOf(obj);
        } catch {
          throw Error('Argument must be a remotable');
        }
        return await this.issueOcapURL(kref);
      },
    });

    // Create the OCAP URL redemption service
    this.#ocapURLRedemptionService = Far('ocapURLRedemptionService', {
      redeem: async (url: string): Promise<SlotValue> => {
        return kslot(await this.redeemOcapURL(url));
      },
    });
  }

  /**
   * Get the OCAP URL services for registration.
   * This should be called during kernel initialization.
   *
   * @returns An object containing the services with their names.
   */
  getServices(): {
    issuerService: { name: string; service: OcapURLIssuerService };
    redemptionService: { name: string; service: OcapURLRedemptionService };
  } {
    return {
      issuerService: {
        name: 'ocapURLIssuerService',
        service: this.getIssuerService(),
      },
      redemptionService: {
        name: 'ocapURLRedemptionService',
        service: this.getRedemptionService(),
      },
    };
  }

  /**
   * Get the issuer service object.
   *
   * @returns the issuer service object.
   */
  getIssuerService(): OcapURLIssuerService {
    return this.#ocapURLIssuerService as OcapURLIssuerService;
  }

  /**
   * Get the redemption service object.
   *
   * @returns the redemption service object.
   */
  getRedemptionService(): OcapURLRedemptionService {
    return this.#ocapURLRedemptionService as OcapURLRedemptionService;
  }

  /**
   * Issue an OCAP URL for a kernel reference.
   *
   * @param kref - The kref of the object to issue an OCAP URL for.
   * @returns a promise for the OCAP URL.
   * @throws if remote identity is not initialized.
   */
  async issueOcapURL(kref: KRef): Promise<string> {
    const identity = this.#remoteManager.getRemoteIdentity();
    // Before minting the token, not after: the URL is unretractable once it
    // exists, so the target must already be retained. Minting also awaits, and
    // a collection crank can run in that window. See `retainForOcapURL`.
    this.#kernelStore.retainForOcapURL(kref);
    try {
      return await identity.issueOcapURL(kref);
    } catch (error) {
      // Nothing else undoes this. A rejected kernel-service call is reported to
      // the caller rather than thrown out of the crank, so the crank commits
      // and the pin outlives the kernel that took it, naming a URL that never
      // existed. This unwinds exactly the one retention above took, so the
      // retentions of URLs that were minted — including any issued for this
      // same kref while this one was in flight — are left alone.
      this.#kernelStore.undoOcapURLRetention(kref);
      throw error;
    }
  }

  /**
   * Redeem an OCAP URL to get the kernel reference it represents.
   *
   * @param url - The OCAP URL to redeem.
   * @returns a promise for the kref of the object referenced by the OCAP URL.
   * @throws if the URL is invalid or remote identity is not initialized.
   */
  async redeemOcapURL(url: string): Promise<KRef> {
    const identity = this.#remoteManager.getRemoteIdentity();
    const { host, hints } = parseOcapURL(url);

    if (host === identity.getPeerId()) {
      // This is a local OCAP URL
      return identity.redeemLocalOcapURL(url);
    }

    // This is a remote OCAP URL — requires full remote comms
    // Add relay hints to our own relay pool so future URLs embed them
    identity.addKnownRelays(hints);
    return this.#remoteManager.withRemote(host, {
      hints,
      use: async (remote) => remote.redeemOcapURL(url),
    });
  }
}
