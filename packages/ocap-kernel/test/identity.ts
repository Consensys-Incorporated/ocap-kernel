import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { KVStore } from '@metamask/kernel-store';
import { toHex } from '@metamask/kernel-utils';

import { attestationSigningBytes } from '../src/accountability/parties.ts';
import type {
  AttestationClaim,
  PartyRef,
} from '../src/accountability/types.ts';

/**
 * Give a kernel store the identity `initRemoteIdentity` would derive from a
 * seed, without initializing remote comms.
 *
 * @param kv - The kernel's kv store.
 * @param seedByte - The byte the 32-byte seed is filled with.
 * @returns The peer ID.
 */
export async function seedIdentity(kv: KVStore, seedByte = 1): Promise<string> {
  const seed = new Uint8Array(32).fill(seedByte);
  const keyPair = await generateKeyPairFromSeed('Ed25519', seed);
  const peerId = peerIdFromPrivateKey(keyPair).toString();
  kv.set('keySeed', toHex(seed));
  kv.set('peerId', peerId);
  return peerId;
}

export type TestParty = {
  party: PartyRef;
  sign(data: Uint8Array): Promise<string>;
  attest<Claim extends Omit<AttestationClaim, 'party'>>(
    claim: Claim,
  ): Promise<Claim & { party: PartyRef; signature: string }>;
};

/**
 * Make a party of the built-in `ed25519` scheme.
 *
 * @param seedByte - The byte the 32-byte seed is filled with.
 * @returns The party and what it can sign.
 */
export async function makeTestParty(seedByte = 2): Promise<TestParty> {
  const keyPair = await generateKeyPairFromSeed(
    'Ed25519',
    new Uint8Array(32).fill(seedByte),
  );
  const party = `ed25519:${toHex(keyPair.publicKey.raw)}`;
  const sign = async (data: Uint8Array): Promise<string> =>
    toHex(await keyPair.sign(data));
  return {
    party,
    sign,
    async attest(claim) {
      const full = { ...claim, party };
      return { ...full, signature: await sign(attestationSigningBytes(full)) };
    },
  };
}
