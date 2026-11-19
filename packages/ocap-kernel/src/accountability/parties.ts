import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { hexToBytes } from '@metamask/utils';

import { signingBytes } from './signing.ts';
import type { Attestation, AttestationClaim, PartyRef } from './types.ts';

/**
 * Check a party's signature. Supplied by the host for each scheme of party
 * identifier it supports; the kernel knows only `ed25519`.
 */
export type PartySignatureVerifier = (options: {
  party: PartyRef;
  data: Uint8Array;
  /** Hex. */
  signature: string;
}) => Promise<boolean> | boolean;

export type PartyVerifier = {
  /**
   * Check a party's signature over some bytes.
   *
   * @throws If no verifier is known for the party's scheme.
   */
  verify(options: {
    party: PartyRef;
    data: Uint8Array;
    signature: string;
  }): Promise<boolean>;
  /** Check an attestation's signature against the party it names. */
  verifyAttestation(attestation: Attestation): Promise<boolean>;
};

/**
 * The scheme of a party identifier.
 *
 * @param party - The identifier.
 * @returns The scheme.
 */
export function partyScheme(party: PartyRef): string {
  return party.slice(0, party.indexOf(':'));
}

/**
 * The bytes a party signs to make an attestation.
 *
 * @param claim - The attestation, without its signature.
 * @returns The bytes.
 */
export function attestationSigningBytes(claim: AttestationClaim): Uint8Array {
  const { kind, subject, party, payload } = claim;
  return signingBytes({ kind, subject, party, payload });
}

/**
 * Verify an `ed25519:<hex public key>` party's signature.
 *
 * @param options - Options bag.
 * @param options.party - The party.
 * @param options.data - The signed bytes.
 * @param options.signature - The signature, in hex.
 * @returns Whether the signature is the party's.
 */
const verifyEd25519: PartySignatureVerifier = async ({
  party,
  data,
  signature,
}) => {
  try {
    const publicKey = publicKeyFromRaw(
      hexToBytes(party.slice('ed25519:'.length)),
    );
    return (
      publicKey.type === 'Ed25519' &&
      (await publicKey.verify(data, hexToBytes(signature)))
    );
  } catch {
    return false;
  }
};

/**
 * Make a verifier of party signatures over the host's verifiers and the
 * built-in one.
 *
 * @param verifiers - The host's verifiers, keyed by scheme.
 * @returns The verifier.
 */
export function makePartyVerifier(
  verifiers: Record<string, PartySignatureVerifier> = {},
): PartyVerifier {
  if (Object.hasOwn(verifiers, 'ed25519')) {
    throw Error('the ed25519 scheme is built in');
  }
  const byScheme = new Map<string, PartySignatureVerifier>([
    ['ed25519', verifyEd25519],
    ...Object.entries(verifiers),
  ]);

  const verify: PartyVerifier['verify'] = async ({
    party,
    data,
    signature,
  }) => {
    const scheme = partyScheme(party);
    const verifier = byScheme.get(scheme);
    if (verifier === undefined) {
      throw Error(`no verifier for the party scheme "${scheme}"`);
    }
    return verifier({ party, data, signature });
  };

  return harden({
    verify,
    async verifyAttestation(attestation: Attestation): Promise<boolean> {
      return verify({
        party: attestation.party,
        data: attestationSigningBytes(attestation),
        signature: attestation.signature,
      });
    },
  });
}
