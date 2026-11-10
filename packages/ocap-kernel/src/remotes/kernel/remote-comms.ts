import { AES_GCM } from '@libp2p/crypto/ciphers';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toHex, fromHex } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import { base58btc } from 'multiformats/bases/base58';

import type { KernelStore, RelayEntry } from '../../store/index.ts';
import { insistKRef } from '../../types.ts';
import type { KRef, PlatformServices } from '../../types.ts';
import { mnemonicToSeed } from '../../utils/bip39.ts';
import type {
  RemoteIdentity,
  RemoteComms,
  RemoteMessageHandler,
  OnRemoteGiveUp,
  OnIncarnationChange,
  RemoteCommsOptions,
} from '../types.ts';

export type OcapURLParts = {
  oid: string;
  host: string;
  hints: string[];
};

/**
 * Default maximum number of relay hints embedded in a single OCAP URL.
 * 3 balances URL length against connectivity resilience — most relay
 * topologies have fewer than 3 distinct relays available to a peer.
 */
export const DEFAULT_MAX_URL_RELAY_HINTS = 3;

/**
 * Default maximum relay entries stored in the kernel's relay pool.
 * 20 bounds storage overhead while accommodating typical bootstrap sets
 * (2–5) plus learned relays discovered through peer exchange.
 */
export const DEFAULT_MAX_KNOWN_RELAYS = 20;

/**
 * Enforce the relay pool cap by prioritizing bootstrap entries, then the
 * newest non-bootstrap entries, up to `cap`. If bootstrap entries alone
 * exceed the cap, the result is truncated to `cap` (some bootstrap entries
 * may be dropped).
 *
 * @param entries - The full set of relay entries.
 * @param cap - The maximum pool size.
 * @returns The entries trimmed to the pool cap.
 */
function enforcePoolCap(entries: RelayEntry[], cap: number): RelayEntry[] {
  if (entries.length <= cap) {
    return entries;
  }
  const bootstrap = entries.filter((entry) => entry.isBootstrap);
  const nonBootstrap = entries
    .filter((entry) => !entry.isBootstrap)
    .sort((a, b) => b.lastSeen - a.lastSeen);
  return [...bootstrap, ...nonBootstrap].slice(0, cap);
}

/**
 * Break down an ocap URL string into its constituent parts.
 *
 * @param ocapURL - The ocap URL to be parsed.
 *
 * @returns an object containing the parsed out elements of `ocapURL`.
 * @throws if `ocapURL` is not a well-formed ocap URL.
 */
export function parseOcapURL(ocapURL: string): OcapURLParts {
  const ref = URL.parse(ocapURL);
  if (!ref) {
    throw Error('unparseable URL');
  }
  if (ref.protocol !== 'ocap:') {
    throw Error('not an ocap URL');
  }
  const parts = ref.pathname.split('@');
  if (parts.length !== 2) {
    throw Error('bad ocap URL');
  }
  const [oid, where] = parts;
  if (!where || !oid) {
    throw Error('bad ocap URL');
  }
  const [host, ...rawHints] = where.split(',');
  if (!host) {
    throw Error('bad ocap URL');
  }
  const hints = rawHints.filter(Boolean);
  return {
    oid,
    host,
    hints,
  };
}

/**
 * Generate the information needed for a network identity.
 *
 * @param seedString - Hex string containing the key seed, or leave undefined to
 *   generate a new random key.
 *
 * @returns pair of the peer id corresponding to the given key, and the seed string.
 */
async function generateKeyInfo(seedString?: string): Promise<[string, string]> {
  // oxlint-disable-next-line no-param-reassign
  seedString ??= toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const keyPair = await generateKeyPairFromSeed('Ed25519', fromHex(seedString));
  const peerId = peerIdFromPrivateKey(keyPair).toString();
  return [seedString, peerId];
}

// XXX IMPORTANT: All the cryptography here is completely amateur and needs to
// be vetted and most likely overhauled in its entirety by an actual competent
// cryptography expert before being unleashed on an unsuspecting public.

/**
 * Initialize the kernel's remote identity (peer ID, crypto keys, OCAP URL
 * operations) without starting any network communications.
 *
 * @param kernelStore - The kernel store, for storing persistent key info.
 * @param [options] - Options for identity initialization.
 * @param [options.relays] - Bootstrap relay addresses. These are merged into
 *   the relay pool, marked as bootstrap (prioritized during eviction and URL
 *   selection), and persisted. Relays previously marked as bootstrap that are
 *   no longer in this list have their bootstrap flag cleared.
 * @param [options.mnemonic] - BIP39 mnemonic for seed recovery.
 * @param [options.maxUrlRelayHints] - Cap on relay hints per OCAP URL.
 * @param [options.maxKnownRelays] - Cap on the stored relay pool.
 * @param logger - The logger to use.
 * @param keySeed - Optional seed for key generation.
 * @returns the identity object, the key seed, and known relays.
 */
export async function initRemoteIdentity(
  kernelStore: KernelStore,
  options?: {
    relays?: string[] | undefined;
    mnemonic?: string | undefined;
    maxUrlRelayHints?: number | undefined;
    maxKnownRelays?: number | undefined;
  },
  logger?: Logger,
  keySeed?: string,
): Promise<{
  identity: RemoteIdentity;
  keySeed: string;
  knownRelays: string[];
}> {
  let peerId: string;
  let ocapURLKey: Uint8Array;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const relays = options?.relays ?? [];
  const mnemonic = options?.mnemonic;
  const maxUrlRelayHints =
    options?.maxUrlRelayHints ?? DEFAULT_MAX_URL_RELAY_HINTS;
  const maxKnownRelays = options?.maxKnownRelays ?? DEFAULT_MAX_KNOWN_RELAYS;

  if (
    !Number.isInteger(maxUrlRelayHints) ||
    maxUrlRelayHints < 1 ||
    !Number.isInteger(maxKnownRelays) ||
    maxKnownRelays < 1
  ) {
    throw Error(
      `maxUrlRelayHints (${maxUrlRelayHints}) and maxKnownRelays (${maxKnownRelays}) must be positive integers`,
    );
  }

  if (relays.length > 0) {
    // Date.now() works here because this code runs in the start compartment,
    // which retains the original Date constructor (%InitialDate%).
    const now = Date.now();
    const bootstrapSet = new Set(relays);

    if (relays.length > maxKnownRelays) {
      logger?.log(
        `relay init: bootstrap relay count (${relays.length}) exceeds maxKnownRelays (${maxKnownRelays}); pool will be truncated`,
      );
    }

    // Merge with existing entries: mark bootstrap relays, preserve learned ones
    const existing = kernelStore.getRelayEntries();
    const byAddr = new Map(existing.map((entry) => [entry.addr, entry]));
    for (const addr of relays) {
      // Bootstrap relays always get a fresh lastSeen timestamp on (re-)init
      byAddr.set(addr, { addr, lastSeen: now, isBootstrap: true });
    }
    // Clear bootstrap flag on entries no longer in the current bootstrap set
    // (create new objects to follow immutability conventions)
    for (const [addr, entry] of byAddr.entries()) {
      if (entry.isBootstrap && !bootstrapSet.has(addr)) {
        byAddr.set(addr, { ...entry, isBootstrap: false });
      }
    }
    const preCapCount = byAddr.size;
    const merged = enforcePoolCap([...byAddr.values()], maxKnownRelays);
    if (merged.length < preCapCount) {
      logger?.log(
        `relay init: evicted ${preCapCount - merged.length} relays to enforce pool cap (${maxKnownRelays})`,
      );
    }
    kernelStore.setRelayEntries(merged);
  }

  /* oxlint-disable no-param-reassign */
  const possiblePeerId = kernelStore.getRemoteIdentityValue('peerId');
  if (possiblePeerId) {
    // If a mnemonic is provided but identity already exists, throw an error
    // to avoid silently using a different identity than expected
    if (mnemonic) {
      throw Error(
        'Cannot use mnemonic: kernel identity already exists. Use resetStorage to clear existing identity first.',
      );
    }
    keySeed = kernelStore.getRemoteIdentityValueRequired('keySeed');
    peerId = possiblePeerId;
    logger?.log(`comms init: existing peer id: ${peerId}`);
  } else {
    // If a mnemonic is provided, derive the seed from it
    if (mnemonic) {
      keySeed = await mnemonicToSeed(mnemonic);
      logger?.log('comms init: using mnemonic for seed recovery');
    }
    [keySeed, peerId] = await generateKeyInfo(keySeed);
    kernelStore.setRemoteIdentityValue('keySeed', keySeed);
    kernelStore.setRemoteIdentityValue('peerId', peerId);
    logger?.log(`comms init: new peer id: ${peerId}`);
  }
  const possibleOcapURLKey = kernelStore.getRemoteIdentityValue('ocapURLKey');
  if (possibleOcapURLKey) {
    ocapURLKey = fromHex(possibleOcapURLKey);
  } else {
    ocapURLKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    kernelStore.setRemoteIdentityValue('ocapURLKey', toHex(ocapURLKey));
  }
  /* oxlint-enable no-param-reassign */
  const cipher = AES_GCM.create();

  const KREF_MIN_LEN = 16;

  /**
   * Obtain this kernel's peer ID.
   *
   * @returns this kernel's peer ID.
   */
  function getPeerId(): string {
    return peerId;
  }

  /**
   * Produce a URL string referencing one of the objects in this kernel.
   *
   * @param kref - The kref of the object in question.
   *
   * @returns a URL that can later be redeemed for the given object reference.
   */
  async function issueOcapURL(kref: KRef): Promise<string> {
    // the libp2p AESCipher salts the plaintext before encrypting, so not bothering to do that here
    const paddedKref = `${kref.padStart(KREF_MIN_LEN)}`;
    const encodedKref = encoder.encode(paddedKref);
    const rawOid = await cipher.encrypt(encodedKref, ocapURLKey);
    const oid = base58btc.encode(rawOid);
    const entries = kernelStore.getRelayEntries();
    // Select top relays: bootstrap first (operator-configured, most reliable),
    // then most recently seen (likeliest to be online)
    const sorted = [...entries].sort((a, b) => {
      if (a.isBootstrap !== b.isBootstrap) {
        return a.isBootstrap ? -1 : 1;
      }
      return b.lastSeen - a.lastSeen;
    });
    const selected = sorted
      .slice(0, maxUrlRelayHints)
      .map((entry) => entry.addr);
    const relaySuffix = selected.length > 0 ? `,${selected.join(',')}` : '';
    const ocapURL = `ocap:${oid}@${peerId}${relaySuffix}`;
    return ocapURL;
  }

  /**
   * Add relay addresses to the kernel's known relay pool.
   * Deduplicates, updates lastSeen on re-observation, and enforces
   * the configured `maxKnownRelays` cap by evicting the oldest
   * non-bootstrap entries.
   *
   * @param newRelays - Relay multiaddrs to add.
   */
  function addKnownRelays(newRelays: string[]): void {
    if (newRelays.length === 0) {
      return;
    }
    // Date.now() works here because this code runs in the start compartment,
    // which retains the original Date constructor (%InitialDate%).
    const now = Date.now();
    const existing = kernelStore.getRelayEntries();
    const byAddr = new Map(existing.map((entry) => [entry.addr, entry]));
    let changed = false;

    for (const addr of newRelays) {
      const entry = byAddr.get(addr);
      if (entry) {
        // Update lastSeen on re-observation (create new object to follow
        // immutability conventions)
        if (entry.lastSeen !== now) {
          byAddr.set(addr, { ...entry, lastSeen: now });
          changed = true;
        }
      } else {
        byAddr.set(addr, { addr, lastSeen: now, isBootstrap: false });
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    const preCapCount = byAddr.size;
    const capped = enforcePoolCap([...byAddr.values()], maxKnownRelays);
    if (capped.length < preCapCount) {
      logger?.log(
        `addKnownRelays: evicted ${preCapCount - capped.length} relays to enforce pool cap (${maxKnownRelays})`,
      );
    }
    kernelStore.setRelayEntries(capped);
  }

  /**
   * Provide the kref encoded by an ocap URL referencing this kernel.
   *
   * @param ocapURL - The URL to be decoded.
   *
   * @returns a promise for the kref encoded by `ocapURL`.
   * @throws if the URL is not local to this kernel.
   */
  async function redeemLocalOcapURL(ocapURL: string): Promise<KRef> {
    const { oid, host } = parseOcapURL(ocapURL);
    if (host !== peerId) {
      throw Error(`ocapURL from a host that's not me`);
    }
    const rawOid = base58btc.decode(oid);
    let encodedKref: Uint8Array;
    try {
      encodedKref = await cipher.decrypt(rawOid, ocapURLKey);
    } catch (problem) {
      logger?.error(`problem deciphering encoded kref: `, problem);
      throw Error(`ocapURL has bad object reference`);
    }
    const paddedKref = decoder.decode(encodedKref);
    const kref = paddedKref.trim();
    insistKRef(kref);
    return kref;
  }

  return harden({
    identity: harden({
      getPeerId,
      issueOcapURL,
      redeemLocalOcapURL,
      addKnownRelays,
    }),
    keySeed,
    knownRelays: kernelStore.getKnownRelayAddresses(),
  });
}

/**
 * Initialize remote communications for this kernel.
 *
 * @param kernelStore - The kernel store, for storing persistent key info.
 * @param platformServices - The platform services, for accessing network I/O
 *   operations that are not available within the web worker that the kernel runs in.
 * @param remoteMessageHandler - Handler to process received inbound communications.
 * @param options - Options for remote communications initialization.
 * @param logger - The logger to use.
 * @param keySeed - Optional seed for libp2p key generation.
 * @param onRemoteGiveUp - Optional callback to be called when we give up on a remote.
 * @param incarnationId - Unique identifier for this kernel instance.
 * @param onIncarnationChange - Optional callback when a remote peer's incarnation changes.
 *
 * @returns the initialized remote comms object.
 */
export async function initRemoteComms(
  kernelStore: KernelStore,
  platformServices: PlatformServices,
  remoteMessageHandler: RemoteMessageHandler,
  options: RemoteCommsOptions = {},
  logger?: Logger,
  keySeed?: string,
  onRemoteGiveUp?: OnRemoteGiveUp,
  incarnationId?: string,
  onIncarnationChange?: OnIncarnationChange,
): Promise<RemoteComms> {
  const {
    relays = [],
    mnemonic,
    maxUrlRelayHints,
    maxKnownRelays,
    ...platformOptions
  } = options;

  const result = await initRemoteIdentity(
    kernelStore,
    { relays, mnemonic, maxUrlRelayHints, maxKnownRelays },
    logger,
    keySeed,
  );

  const { identity, knownRelays } = result;

  logger?.log(`relays: ${JSON.stringify(knownRelays)}`);

  // detectWake() reads and updates lastActiveTime atomically, so it must be
  // called before initializeRemoteComms to capture the pre-restart timestamp.
  const wakeDetected = kernelStore.detectWake();

  // Omit mnemonic (sensitive key material) from the options passed to
  // platform services, which only needs network-level configuration.
  await platformServices.initializeRemoteComms(
    result.keySeed,
    { ...platformOptions, relays: knownRelays },
    remoteMessageHandler,
    onRemoteGiveUp,
    incarnationId,
    onIncarnationChange,
  );

  if (wakeDetected) {
    logger?.log('Cross-incarnation wake detected, resetting backoffs');
    await platformServices.resetAllBackoffs();
  }

  /**
   * Transmit a message to a remote kernel.
   *
   * @param to - The peer ID of the intended destination.
   * @param message - The serialized message string (with seq/ack already added by RemoteHandle).
   */
  async function sendRemoteMessage(to: string, message: string): Promise<void> {
    await platformServices.sendRemoteMessage(to, message);
  }

  return {
    ...identity,
    sendRemoteMessage,
    registerLocationHints:
      platformServices.registerLocationHints.bind(platformServices),
  };
}
