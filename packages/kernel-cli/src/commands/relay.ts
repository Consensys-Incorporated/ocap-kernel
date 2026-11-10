import { startRelay } from '@metamask/kernel-utils/libp2p';
import { getLibp2pRelayHome } from '@metamask/kernel-utils/nodejs';
import type { Logger } from '@metamask/logger';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { isProcessAlive, readPidFile, sendSignal, waitFor } from '../utils.ts';

/**
 * Get the relay PID file path.
 *
 * @returns The relay PID file path.
 */
export function getRelayPidPath(): string {
  return `${getLibp2pRelayHome()}/relay.pid`;
}

/**
 * Get the relay address file path.
 *
 * @returns The relay address file path.
 */
export function getRelayAddrPath(): string {
  return `${getLibp2pRelayHome()}/relay.addr`;
}

/**
 * Remove the relay PID and address files.
 */
async function removeRelayFiles(): Promise<void> {
  await Promise.all([
    rm(getRelayPidPath(), { force: true }),
    rm(getRelayAddrPath(), { force: true }),
  ]);
}

/**
 * Pick the multiaddr to write into `relay.addr`. We want the address
 * remote peers will actually be able to dial. Preference order:
 *
 *   1. A `/ip4/X.X.X.X/tcp/9001/ws/p2p/...` whose IPv4 part is neither
 *      loopback nor any RFC 1918 private range (i.e., looks public).
 *   2. Any non-loopback `/tcp/9001/ws/`.
 *   3. The loopback `/tcp/9001/ws/` as a last resort (single-host
 *      development).
 *
 * Without an `appendAnnounce` configured, libp2p's `getMultiaddrs()`
 * only reports addresses bound to local NICs, which on a NAT-backed
 * VPS is just loopback + a private interface — hence the
 * `LIBP2P_RELAY_PUBLIC_IP` / `--public-ip` knob feeds `appendAnnounce`
 * so a public hint is available here.
 *
 * @param multiaddrs - Multiaddrs reported by `libp2p.getMultiaddrs()`.
 * @returns The selected multiaddr, or `undefined` if no `/tcp/9001/ws/`
 * multiaddr is present at all.
 */
function pickRelayAddr(
  multiaddrs: readonly { toString(): string }[],
): string | undefined {
  const candidates = multiaddrs
    .map((ma) => ma.toString())
    .filter((addr) => addr.includes('/tcp/9001/ws/'));
  if (candidates.length === 0) {
    return undefined;
  }
  const ipOf = (addr: string): string | undefined =>
    /\/ip4\/([^/]+)\//u.exec(addr)?.[1];
  const isLoopback = (ip: string): boolean => ip === '127.0.0.1';
  const isPrivate = (ip: string): boolean =>
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./u.test(ip);
  const publicAddr = candidates.find((addr) => {
    const ip = ipOf(addr);
    return ip !== undefined && !isLoopback(ip) && !isPrivate(ip);
  });
  if (publicAddr) {
    return publicAddr;
  }
  const nonLoopback = candidates.find((addr) => {
    const ip = ipOf(addr);
    return ip !== undefined && !isLoopback(ip);
  });
  return nonLoopback ?? candidates[0];
}

/**
 * Start the relay server, write a PID file, and register signal handlers for
 * cleanup on exit.
 *
 * @param logger - The logger instance.
 * @param options - Optional configuration.
 * @param options.publicIp - Public IPv4 to announce alongside the
 * locally-bound addresses. Sourced by callers from
 * `LIBP2P_RELAY_PUBLIC_IP` or `--public-ip`.
 */
export async function startRelayWithBookkeeping(
  logger: Logger,
  options: { publicIp?: string } = {},
): Promise<void> {
  await mkdir(getLibp2pRelayHome(), { recursive: true });

  const existingPid = await readPidFile(getRelayPidPath());
  if (existingPid !== undefined && isProcessAlive(existingPid)) {
    throw new Error(`Relay is already running (PID: ${existingPid}).`);
  }

  await writeFile(getRelayPidPath(), String(process.pid));

  let libp2p;
  try {
    libp2p = await startRelay(
      logger,
      options.publicIp ? { publicIp: options.publicIp } : {},
    );
  } catch (error) {
    await removeRelayFiles();
    throw error;
  }

  try {
    const relayAddr = options.publicIp
      ? // Operator told us the externally-reachable IPv4 explicitly;
        // synthesize the multiaddr instead of trusting whatever libp2p's
        // address manager surfaces. Defends against scenarios where the
        // appendAnnounce entry never makes it into getMultiaddrs() — and
        // cleanly avoids the picker's heuristic for the common case
        // where the operator already knows the right answer.
        `/ip4/${options.publicIp}/tcp/9001/ws/p2p/${libp2p.peerId.toString()}`
      : pickRelayAddr(libp2p.getMultiaddrs());
    if (relayAddr === undefined) {
      throw new Error('Relay started but no /tcp/9001/ws multiaddr found');
    }
    await writeFile(getRelayAddrPath(), relayAddr);
    logger.info(`Relay address: ${relayAddr}`);
    if (options.publicIp) {
      logger.info(`(Used LIBP2P_RELAY_PUBLIC_IP=${options.publicIp}.)`);
    }
  } catch (error) {
    await Promise.resolve(libp2p.stop()).catch(() => undefined);
    await removeRelayFiles();
    throw error;
  }

  const cleanup = (): void => {
    Promise.resolve(libp2p.stop())
      .catch(() => undefined)
      .finally(() => {
        removeRelayFiles()
          .catch(() => undefined)
          .finally(() => process.exit(0));
      });
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

/**
 * Print whether the relay process is running.
 */
export async function printRelayStatus(): Promise<void> {
  const pid = await readPidFile(getRelayPidPath());
  if (pid !== undefined && isProcessAlive(pid)) {
    process.stderr.write(`Relay is running (PID: ${pid}).\n`);
  } else {
    if (pid !== undefined) {
      await removeRelayFiles();
    }
    process.stderr.write('Relay is not running.\n');
    process.exitCode = 1;
  }
}

/**
 * Stop the relay process. Sends SIGTERM and waits; escalates to SIGKILL if
 * `force` is true and SIGTERM is ignored.
 *
 * @param options - Options.
 * @param options.force - Send SIGKILL if SIGTERM fails to stop the relay.
 * @returns True if the relay was stopped (or was not running), false otherwise.
 */
export async function stopRelay({
  force = false,
}: { force?: boolean } = {}): Promise<boolean> {
  const pid = await readPidFile(getRelayPidPath());

  if (pid === undefined || !isProcessAlive(pid)) {
    if (pid !== undefined) {
      await removeRelayFiles();
    }
    process.stderr.write('Relay is not running.\n');
    return true;
  }

  process.stderr.write('Stopping relay...\n');
  let stopped = false;

  // Strategy 1: SIGTERM.
  stopped = !sendSignal(pid, 'SIGTERM');
  if (!stopped) {
    stopped = await waitFor(() => !isProcessAlive(pid), 5_000);
  }

  // Strategy 2: SIGKILL (only with --force).
  if (!stopped && force) {
    stopped = !sendSignal(pid, 'SIGKILL');
    if (!stopped) {
      stopped = await waitFor(() => !isProcessAlive(pid), 2_000);
    }
  }

  if (stopped) {
    await removeRelayFiles();
    process.stderr.write('Relay stopped.\n');
  } else {
    process.stderr.write('Relay did not stop within timeout.\n');
  }
  return stopped;
}
