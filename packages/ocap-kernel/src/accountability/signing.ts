import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
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
 * keys in sorted order at every depth, and properties that are undefined
 * left out, as `JSON.stringify` leaves them out.
 *
 * @param value - The value.
 * @returns Its canonical JSON.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
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
  let publicKey;
  try {
    publicKey = peerIdFromString(signer).publicKey;
  } catch {
    return false;
  }
  if (!publicKey) {
    return false;
  }
  return publicKey.verify(
    signingBytes({ payload, signer, incarnationId }),
    hexToBytes(signature),
  );
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
  let key: { privateKey: PrivateKey; peerId: string } | undefined;

  /**
   * Derive the identity key from the store, initializing the identity if the
   * store has none.
   *
   * @returns The key and the peer ID it belongs to.
   */
  async function getKey(): Promise<{ privateKey: PrivateKey; peerId: string }> {
    if (key) {
      return key;
    }
    if (kernelStore.getRemoteIdentityValue('keySeed') === undefined) {
      await ensureIdentity();
    }
    const seed = kernelStore.getRemoteIdentityValueRequired('keySeed');
    const peerId = kernelStore.getRemoteIdentityValueRequired('peerId');
    key = {
      privateKey: await generateKeyPairFromSeed('Ed25519', fromHex(seed)),
      peerId,
    };
    return key;
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
