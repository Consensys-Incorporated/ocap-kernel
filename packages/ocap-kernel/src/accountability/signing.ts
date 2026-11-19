import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import type { PrivateKey, PublicKey } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { fromHex, toHex } from '@metamask/kernel-utils';
import { hexToBytes } from '@metamask/utils';

import type { KernelStore } from '../store/index.ts';

/**
 * A statement the kernel signed with its identity key. The signer is the
 * kernel's peer ID, and the incarnation names which life of the kernel's
 * store made the statement: a crank number names a delivery only within one
 * incarnation, since a reset under the same key starts the count again.
 */
export type Signed<Payload = unknown> = {
  payload: Payload;
  signer: string;
  incarnationId: string;
  /** Hex, over `signingBytes` of the other three fields. */
  signature: string;
};

export type KernelSigner = {
  /**
   * Sign a statement with the kernel's identity key, initializing the
   * identity if the kernel has none yet.
   */
  sign<Payload>(payload: Payload): Promise<Signed<Payload>>;
  /** The kernel's peer ID, initializing the identity if it has none yet. */
  getPeerId(): Promise<string>;
};

/**
 * Serialize a value so that equal values give equal bytes: JSON with object
 * keys in sorted order at every depth, and undefined treated as
 * `JSON.stringify` treats it: left out of objects, null in arrays.
 *
 * @param value - The value.
 * @returns Its canonical JSON.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The bytes a signature covers.
 *
 * @param value - What is signed.
 * @returns The bytes.
 */
export function signingBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/**
 * Check a kernel's signature on a statement against the peer ID that claims
 * to have made it.
 *
 * @param signed - The statement.
 * @returns Whether the signature is that peer's.
 */
export async function verifyKernelSignature(signed: Signed): Promise<boolean> {
  const { payload, signer, incarnationId, signature } = signed;
  let publicKey: PublicKey | undefined;
  try {
    publicKey = peerIdFromString(signer).publicKey;
    if (!publicKey) {
      return false;
    }
    return await publicKey.verify(
      signingBytes({ payload, signer, incarnationId }),
      hexToBytes(signature),
    );
  } catch {
    return false;
  }
}

/**
 * Make a signer over the kernel's identity key, which `remote-comms` derives
 * from the seed in the store.
 *
 * @param options - Options bag.
 * @param options.kernelStore - The kernel's store.
 * @param options.ensureIdentity - Initialize the kernel's identity if it has
 * none.
 * @returns The signer.
 */
export function makeKernelSigner({
  kernelStore,
  ensureIdentity,
}: {
  kernelStore: KernelStore;
  ensureIdentity: () => Promise<void>;
}): KernelSigner {
  type Key = { privateKey: PrivateKey; peerId: string };
  let cached: { seed: string; key: Promise<Key> } | undefined;
  let initializing: Promise<void> | undefined;

  /**
   * The identity key: derived from the seed in the store, once per seed, so
   * that a cleared store gives a new key; the identity is initialized first
   * if the store has none, once however many callers ask at a time.
   *
   * @returns The key and the peer ID it belongs to.
   */
  async function getKey(): Promise<Key> {
    if (kernelStore.getRemoteIdentityValue('keySeed') === undefined) {
      initializing ??= ensureIdentity().finally(() => {
        initializing = undefined;
      });
      await initializing;
    }
    const seed = kernelStore.getRemoteIdentityValueRequired('keySeed');
    if (cached?.seed !== seed) {
      const peerId = kernelStore.getRemoteIdentityValueRequired('peerId');
      const key = generateKeyPairFromSeed('Ed25519', fromHex(seed)).then(
        (privateKey) => ({ privateKey, peerId }),
      );
      cached = { seed, key };
    }
    return cached.key;
  }

  return harden({
    async sign<Payload>(payload: Payload): Promise<Signed<Payload>> {
      const { privateKey, peerId } = await getKey();
      const incarnationId = kernelStore.provideIncarnationId();
      const signature = toHex(
        await privateKey.sign(
          signingBytes({ payload, signer: peerId, incarnationId }),
        ),
      );
      return harden({ payload, signer: peerId, incarnationId, signature });
    },

    async getPeerId(): Promise<string> {
      return (await getKey()).peerId;
    },
  });
}
