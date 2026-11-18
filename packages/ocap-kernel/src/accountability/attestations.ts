import { assert } from '@metamask/superstruct';

import type { PartyVerifier } from './parties.ts';
import { verifyKernelSignature } from './signing.ts';
import type { KernelSigner } from './signing.ts';
import { AttestationStruct } from './types.ts';
import type { StoredAttestation } from './types.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import type { KernelStore } from '../store/index.ts';

export type AttestationFilter = {
  kind?: StoredAttestation['kind'];
  /** Needs `kind`. */
  subject?: string;
};

export type AttestationKeeper = {
  /**
   * Keep an operator or implementer attestation, once its signature checks.
   * An operator attestation for this kernel is countersigned with the
   * kernel's key; one for another kernel must already carry that kernel's
   * countersignature.
   *
   * @throws If the attestation is malformed, its party's scheme has no
   * verifier, or a signature does not check.
   */
  attest(attestation: StoredAttestation): Promise<void>;
  /** Read the attestations the kernel holds. */
  getAttestations(filter?: AttestationFilter): Promise<StoredAttestation[]>;
};

/**
 * Make the keeper of the kernel's attestations.
 *
 * @param options - Options bag.
 * @param options.kernelStore - The kernel's store.
 * @param options.kernelQueue - The kernel's run queue.
 * @param options.signer - The kernel's signer.
 * @param options.partyVerifier - The verifier of party signatures.
 * @returns The keeper.
 */
export function makeAttestationKeeper({
  kernelStore,
  kernelQueue,
  signer,
  partyVerifier,
}: {
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
  signer: KernelSigner;
  partyVerifier: PartyVerifier;
}): AttestationKeeper {
  /**
   * Countersign an operator attestation for this kernel, or check the
   * countersignature on one for another.
   *
   * @param attestation - The attestation.
   * @returns The attestation, countersigned.
   */
  async function countersign(
    attestation: StoredAttestation,
  ): Promise<StoredAttestation> {
    const { kind, subject, party, payload, signature, countersignature } =
      attestation;
    const claim = { kind, subject, party, payload };
    if (subject === (await signer.getPeerId())) {
      const signed = await signer.sign(claim);
      return {
        ...claim,
        signature,
        countersignature: {
          signer: signed.signer,
          incarnationId: signed.incarnationId,
          signature: signed.signature,
        },
      };
    }
    if (
      countersignature === undefined ||
      countersignature.signer !== subject ||
      !(await verifyKernelSignature({ payload: claim, ...countersignature }))
    ) {
      throw Error(
        `an operator attestation for ${subject} needs that kernel's countersignature`,
      );
    }
    return { ...claim, signature, countersignature };
  }

  return harden({
    async attest(attestation: StoredAttestation): Promise<void> {
      const { countersignature: _countersignature, ...bare } = attestation;
      assert(bare, AttestationStruct);
      if (bare.kind === 'intent') {
        throw Error(
          'an intent is attested by the queueMessage it is passed to',
        );
      }
      if (!(await partyVerifier.verifyAttestation(bare))) {
        throw Error(
          `the signature on the ${bare.kind} attestation by ${bare.party} does not check`,
        );
      }
      const kept =
        bare.kind === 'operator' ? await countersign(attestation) : bare;
      await kernelQueue.writeOutsideCrank(() => {
        kernelStore.addAttestation(kept);
      });
    },

    async getAttestations(
      filter?: AttestationFilter,
    ): Promise<StoredAttestation[]> {
      return kernelQueue.writeOutsideCrank(() =>
        harden(kernelStore.getAttestations(filter)),
      );
    },
  });
}
