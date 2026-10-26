/* oxlint-disable node/no-process-env, node/no-sync */
/**
 * Generic kernel entrypoint for Docker E2E containers.
 *
 * Boots a kernel daemon with optional QUIC transport, starts the RPC socket
 * server, and writes a readiness file. All wallet-specific configuration
 * (subclusters, keyrings, providers, etc.) is driven from the host.
 *
 * Env vars:
 *   SERVICE_NAME         — log prefix (e.g. "home", "away")
 *   SOCKET_PATH          — Unix socket path for the RPC server
 *   QUIC_LISTEN_ADDRESS  — optional QUIC multiaddr (omit to skip transport)
 *   READY_FILE           — path to write readiness JSON
 */

import '@metamask/kernel-shims/endoify-node';

import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import { startRpcSocketServer } from '@metamask/kernel-node-runtime/daemon';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { Kernel } from '@metamask/ocap-kernel';
import {
  createWriteStream,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const NAME = process.env.SERVICE_NAME ?? 'kernel';
const { SOCKET_PATH } = process.env;
const QUIC_ADDR = process.env.QUIC_LISTEN_ADDRESS;
const { READY_FILE } = process.env;

// Tee stdout/stderr to a file so logs are accessible on the host via the
// bind-mounted logs directory even after the container exits.
mkdirSync('/logs', { recursive: true });
const logStream = createWriteStream(`/logs/${NAME}.log`, { flags: 'w' });
for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write.bind(stream);
  // oxlint-disable-next-line ocap/require-jsdoc
  stream.write = (chunk, ...args) => {
    logStream.write(chunk);
    return original(chunk, ...args);
  };
}

if (!SOCKET_PATH) {
  console.error(`[${NAME}] FATAL: SOCKET_PATH is required`);
  process.exit(1);
}
if (!READY_FILE) {
  console.error(`[${NAME}] FATAL: READY_FILE is required`);
  process.exit(1);
}

/**
 * Boot the kernel and start the RPC socket server.
 */
async function main() {
  // Clean stale files from previous runs
  mkdirSync(dirname(SOCKET_PATH), { recursive: true });
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    /* ok */
  }
  try {
    unlinkSync(READY_FILE);
  } catch {
    /* ok */
  }

  console.log(`[${NAME}] Booting kernel...`);
  const db = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernel = await Kernel.make(new NodejsPlatformServices({}), db, {
    resetStorage: true,
  });
  await kernel.initIdentity();

  let peerId;
  let listenAddresses;

  if (QUIC_ADDR) {
    console.log(`[${NAME}] Initializing QUIC transport on ${QUIC_ADDR}...`);
    await kernel.initRemoteComms({
      directListenAddresses: [QUIC_ADDR],
    });

    const deadline = Date.now() + 30_000;
    let status = await kernel.getStatus();
    while (status.remoteComms?.state !== 'connected' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = await kernel.getStatus();
    }
    if (status.remoteComms?.state !== 'connected') {
      console.error(`[${NAME}] FATAL: Remote comms failed to connect`);
      process.exit(1);
    }
    ({ peerId, listenAddresses } = status.remoteComms);
    console.log(`[${NAME}] Peer ID: ${peerId.slice(0, 16)}...`);
  }

  console.log(`[${NAME}] Starting RPC socket server at ${SOCKET_PATH}...`);
  await startRpcSocketServer({
    socketPath: SOCKET_PATH,
    kernel,
    kernelDatabase: db,
  });

  const info = {
    socketPath: SOCKET_PATH,
    ...(peerId ? { peerId, listenAddresses } : {}),
  };
  writeFileSync(READY_FILE, JSON.stringify(info, null, 2));
  console.log(`[${NAME}] Ready.`);

  // Keep alive
  setInterval(() => undefined, 60_000);
}

main().catch((error) => {
  console.error(`[${NAME}] FATAL:`, error);
  process.exit(1);
});
