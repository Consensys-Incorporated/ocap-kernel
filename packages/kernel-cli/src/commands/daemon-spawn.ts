import { assertSupportedPlatform } from '@metamask/kernel-node-runtime/daemon';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pingDaemon } from './daemon-client.ts';
import { getOcapHome } from '../ocap-home.ts';
import { isProcessAlive } from '../utils.ts';

const POLL_INTERVAL_MS = 100;
const MAX_POLLS = 300; // 30 seconds

/**
 * Read the PID from `<OCAP_HOME>/daemon.pid`. Returns `undefined` if the
 * file is missing or unparseable.
 *
 * @returns The parsed pid, or `undefined`.
 */
async function readPidFile(): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(getOcapHome(), 'daemon.pid'), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const pid = Number(raw.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * Ensure the daemon is running. If it is not, spawn it as a detached process
 * and wait until the socket becomes responsive.
 *
 * Refuses to spawn if a daemon process is already alive under this
 * OCAP_HOME — orphaning the existing process would leave it holding
 * `kernel.sqlite` locks with no easy way to find it again.
 *
 * @param socketPath - The UNIX socket path.
 */
export async function ensureDaemon(socketPath: string): Promise<void> {
  // The daemon would also refuse to boot, but out of sight: it runs with
  // `stdio: 'ignore'`, so the caller would only see the poll below time out.
  assertSupportedPlatform();

  if (await pingDaemon(socketPath)) {
    return;
  }

  const orphanPid = await readPidFile();
  if (orphanPid !== undefined && isProcessAlive(orphanPid)) {
    throw new Error(
      `A daemon process (pid ${orphanPid}) is alive under ` +
        `${getOcapHome()} but its socket is unresponsive. ` +
        `Kill it (\`kill ${orphanPid}\`) and remove ` +
        `${getOcapHome()}/daemon.{sock,pid} before retrying.`,
    );
  }

  process.stderr.write('Starting daemon...\n');

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const entryPath = join(currentDir, 'daemon-entry.mjs');

  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      OCAP_SOCKET_PATH: socketPath,
    },
  });
  child.unref();

  // Poll until daemon responds
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (await pingDaemon(socketPath)) {
      process.stderr.write('Daemon ready.\n');
      return;
    }
  }

  throw new Error(
    `Daemon did not start within ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s`,
  );
}
