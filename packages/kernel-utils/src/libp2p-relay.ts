import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { autoNAT } from '@libp2p/autonat';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { identify } from '@libp2p/identify';
import type { Libp2p, PeerId, PrivateKey } from '@libp2p/interface';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import type { Multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';

/**
 * Fixed local ID for the relay server.
 * This ensures the relay server always has the same PeerID across restarts,
 * making it easier for clients to connect to a known relay address.
 * The ID must be between 1-255 to generate a deterministic keypair.
 */
const RELAY_LOCAL_ID = 200;

/**
 * A minimal logger interface for relay events.
 */
type RelayLogger = {
  log: (message: string, ...args: unknown[]) => void;
};

/**
 * Start the relay server.
 *
 * @param logger - The logger to use.
 * @param options - Optional configuration.
 * @param options.publicIp - Public IPv4 address that the relay should
 * announce in addition to whatever libp2p auto-detects from local
 * interfaces. Use on hosts (e.g., NAT-backed VPSes) where the public
 * address is not bound to a local NIC and would otherwise be missing
 * from `getMultiaddrs()`.
 * @returns The libp2p instance.
 */
export async function startRelay(
  logger: RelayLogger,
  options: { publicIp?: string } = {},
): Promise<Libp2p> {
  const tersePeers = new Map<string, string>();
  let tersePeerIdx = 0;
  const activePeers = new Set<string>();
  const privateKey = await generateKeyPair(RELAY_LOCAL_ID);
  const appendAnnounce = options.publicIp
    ? [
        `/ip4/${options.publicIp}/tcp/9001/ws`,
        `/ip4/${options.publicIp}/tcp/9002`,
      ]
    : [];
  const libp2p = await createLibp2p({
    privateKey,
    addresses: {
      listen: [
        '/ip4/0.0.0.0/tcp/9001/ws', // WebSocket for browser connections
        '/ip4/0.0.0.0/tcp/9002', // TCP for server-to-server
      ],
      appendAnnounce,
    },
    transports: [
      webSockets(), // Required for browser connections
      tcp(), // Optional for server connections
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      // Allow private addresses for local testing
      denyDialMultiaddr: async () => false,
    },
    services: {
      identify: identify(),
      ping: ping(),
      autoNat: autoNAT(),
      relay: circuitRelayServer({
        // Allow unlimited reservations for testing
        reservations: {
          maxReservations: Infinity,
          applyDefaultLimit: false,
        },
        // Reduce hop timeout to clean up stale connections faster
        hopTimeout: 10 * 1000, // 10 seconds instead of default 30
      }),
    },
  });

  /**
   * Produce a more legible peer ID string.
   *
   * @param peer - The peer ID we care about, either as a `PeerId` object
   * (e.g. `connection.remotePeer`) or as the bare string form extracted
   * from a multiaddr.
   * @returns a terser form of `peer`.
   */
  function tersePeer(peer: PeerId | string): string {
    const peerId = typeof peer === 'string' ? peer : peer.toString();
    if (tersePeers.has(peerId)) {
      return tersePeers.get(peerId) as string;
    }
    tersePeerIdx += 1;
    const terse = `<PEER-${tersePeerIdx}>`;
    tersePeers.set(peerId, terse);
    logger.log(`[PEER] ${terse} = ${peerId}`);
    return terse;
  }

  /**
   * Produce a more legible multiaddr string.
   *
   * @param multiaddr - The multiaddr we care about.
   * @returns a terser form of `multiaddr`.
   */
  function terseAddr(multiaddr: Multiaddr): string {
    const raw = multiaddr.toString();
    const slash = raw.lastIndexOf('/') + 1;
    if (slash <= 0) {
      return raw;
    }
    const prefix = raw.substring(0, slash);
    const suffix = raw.substring(slash);
    return `${prefix}${tersePeer(suffix)}`;
  }

  /**
   *
   */
  function dumpPeers(): void {
    logger.log(`[ACTIVE] [${Array.from(activePeers.values()).join(' ')}]`);
  }

  // Set up connection event listeners for logging
  libp2p.addEventListener('connection:open', (evt) => {
    const connection = evt.detail;
    const peer = tersePeer(connection.remotePeer);
    activePeers.add(peer);
    /*
    logger.log(`[CONNECTION] New connection from ${peer}`);
    logger.log(`  Remote addr: ${terseAddr(connection.remoteAddr)}`);
    logger.log(`  Direction: ${connection.direction}`);
    logger.log(`  Status: ${connection.status}`);
    */
    logger.log(
      `[CONNECTION] New connection from ${terseAddr(connection.remoteAddr)}`,
    );
    dumpPeers();
  });

  libp2p.addEventListener('connection:close', (evt) => {
    const connection = evt.detail;
    const peer = tersePeer(connection.remotePeer);
    logger.log(`[CONNECTION] Closed connection with ${peer}`);
    activePeers.delete(peer);
    dumpPeers();
  });

  /*
  // Log peer discovery events
  libp2p.addEventListener('peer:discovery', (evt) => {
    const peerInfo = evt.detail;
    logger.log(`[DISCOVERY] Found peer ${tersePeer(peerInfo.id)}`);
  });

  // Log circuit relay specific events
  if (libp2p.services.relay) {
    // Log when a reservation is made
    libp2p.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail;
      logger.log(`[RELAY] Peer connected: ${tersePeer(peerId)}`);
    });

    libp2p.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail;
      logger.log(`[RELAY] Peer disconnected: ${tersePeer(peerId)}`);
    });
  }
  */

  await new Promise<void>((resolve) => {
    if (libp2p.status === 'started') {
      resolve();
    } else {
      libp2p.addEventListener('start', () => resolve());
    }
  });

  logger.log('========================================');
  logger.log('Relay Server Started');
  logger.log('PeerID: ', libp2p.peerId.toString());
  logger.log('Multiaddrs: ', libp2p.getMultiaddrs());
  logger.log('========================================');

  return libp2p;
}

/**
 * Generate the private key for a given localID.
 *
 * @param localId - The localID whose peerID is sought.
 *
 * @returns the private key for `localID`.
 */
async function generateKeyPair(
  localId: number | undefined,
): Promise<PrivateKey> {
  let seed;
  // oxlint-disable-next-line no-negated-condition
  if (localId !== undefined) {
    if (localId < 1 || localId > 255) {
      throw new Error(`localId must be a Uint8 1<=255. Received: ${localId}`);
    }

    seed = new Uint8Array(32);
    seed[0] = localId;
  } else {
    seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
  }
  return await generateKeyPairFromSeed('Ed25519', seed);
}
