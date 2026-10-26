import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pingDaemon } from '../../src/commands/daemon-client.ts';

const POLL_INTERVAL_MS = 100;
const MAX_POLLS = 300; // 30 seconds

/**
 * Poll until the daemon socket responds.
 *
 * @param socketPath - The daemon socket path.
 */
async function waitForDaemon(socketPath: string): Promise<void> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (await pingDaemon(socketPath)) {
      return;
    }
  }
  throw new Error(
    `Daemon did not start within ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s`,
  );
}

/**
 * Poll until the daemon socket stops responding.
 *
 * @param socketPath - The daemon socket path.
 */
export async function waitForDaemonStop(socketPath: string): Promise<void> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (!(await pingDaemon(socketPath))) {
      return;
    }
  }
  throw new Error('Daemon did not stop within timeout');
}

export type TestDaemon = {
  ocapHome: string;
  socketPath: string;
  pid: number;
  cleanup: () => Promise<void>;
};

/**
 * Spawn a real daemon process in a temporary directory.
 *
 * @param options - Spawn options.
 * @param options.devMode - Start the daemon with `OCAP_DEV_MODE=true`, so it
 * serves the dev-only RPC methods.
 * @returns The OCAP home dir, socket path, and cleanup function.
 */
export async function spawnTestDaemon({
  devMode = false,
}: { devMode?: boolean } = {}): Promise<TestDaemon> {
  const ocapHome = await mkdtemp(join(tmpdir(), 'ocap-e2e-'));
  const socketPath = join(ocapHome, 'daemon.sock');

  // `mkdtemp` already returns 0700; loosen it so the daemon's chmod has
  // something to actually tighten, which is the case a fresh directory
  // can't exercise.
  await chmod(ocapHome, 0o755);

  const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const entryPath = join(packageRoot, 'dist/commands/daemon-entry.js');

  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      OCAP_HOME: ocapHome,
      OCAP_SOCKET_PATH: socketPath,
      // Pinned off rather than omitted, or an ambient `OCAP_DEV_MODE=true`
      // would make the refusal assertions vacuous.
      OCAP_DEV_MODE: devMode ? 'true' : undefined,
    },
  });
  const { pid } = child;
  if (pid === undefined) {
    throw new Error('Failed to get daemon PID');
  }
  child.unref();

  await waitForDaemon(socketPath);

  return {
    ocapHome,
    socketPath,
    pid,
    cleanup: async () => {
      try {
        const { sendCommand } =
          await import('../../src/commands/daemon-client.ts');
        await sendCommand({
          socketPath,
          method: 'shutdown',
          timeoutMs: 5_000,
        });
        await waitForDaemonStop(socketPath);
      } catch {
        // Graceful shutdown failed — SIGKILL as fallback.
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already gone.
        }
      }

      await rm(ocapHome, { recursive: true, force: true });
    },
  };
}
