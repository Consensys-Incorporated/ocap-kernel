import { Far } from '@endo/marshal';

import { parseOcapURL } from './remote-comms.ts';
import type { RemoteManager } from './RemoteManager.ts';
import { attempt } from '../../KernelQueue.ts';
import type { KernelQueue } from '../../KernelQueue.ts';
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
  kernelQueue: KernelQueue;
};

/**
 * Manages OCAP URL issuing and redemption.
 */
export class OcapURLManager {
  /** Remote manager for handling remote connections */
  readonly #remoteManager: RemoteManager;

  /** The kernel's store, for retaining the objects issued URLs name */
  readonly #kernelStore: KernelStore;

  /** The kernel's run queue, whose inbox takes each issue's write */
  readonly #kernelQueue: KernelQueue;

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
   * @param options.kernelQueue - The kernel's run queue.
   */
  constructor({
    remoteManager,
    kernelStore,
    kernelQueue,
  }: OcapURLManagerConstructorProps) {
    this.#remoteManager = remoteManager;
    this.#kernelStore = kernelStore;
    this.#kernelQueue = kernelQueue;

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
   * Issue an OCAP URL for a kernel reference, in a crank of its own: the
   * target is retained and the token minted together, so a mint that fails
   * takes its retention back with it.
   *
   * @param kref - The kref of the object to issue an OCAP URL for.
   * @returns a promise for the OCAP URL.
   * @throws if remote identity is not initialized.
   */
  async issueOcapURL(kref: KRef): Promise<string> {
    const identity = this.#remoteManager.getRemoteIdentity();
    return this.#kernelQueue.enqueueInbox('issue an ocap URL', async () =>
      attempt(async () => {
        this.#kernelStore.retainForOcapURL(kref);
        return identity.issueOcapURL(kref);
      }),
    );
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

    // This is a remote OCAP URL — requires full remote comms. The relay hints
    // are added inside `use`, so they are written in the remote's crank along
    // with the request, and future URLs embed them.
    return this.#remoteManager.withRemote(host, {
      hints,
      use: async (remote) => {
        identity.addKnownRelays(hints);
        return remote.redeemOcapURL(url);
      },
    });
  }
}
