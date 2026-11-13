/* oxlint-disable node/no-sync -- existsSync is fine in tests */
import {
  assertIsJsonRpcFailure,
  assertIsJsonRpcSuccess,
} from '@metamask/utils';
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { TestDaemon } from './helpers.ts';
import { spawnTestDaemon, waitForDaemonStop } from './helpers.ts';
import { sendCommand, pingDaemon } from '../../src/commands/daemon-client.ts';

// NOTE: `redeem-url` is not tested here because it requires remote comms
// infrastructure (relay + peer). See unit tests in src/commands/daemon.test.ts.

/**
 * Read a path's permission bits.
 *
 * @param path - The path to stat.
 * @returns The permission bits, maskable against octal literals.
 */
async function permissionsOf(path: string): Promise<number> {
  const { mode } = await stat(path);
  // oxlint-disable-next-line no-bitwise -- the only way to read mode bits
  return mode & 0o777;
}

describe('Daemon CLI e2e', { timeout: 60_000 }, () => {
  describe('start / exec / queueMessage', () => {
    let daemon: TestDaemon;

    beforeAll(async () => {
      daemon = await spawnTestDaemon();
    });

    afterAll(async () => {
      await daemon.cleanup();
    });

    it('starts daemon and responds to getStatus', async () => {
      const response = await sendCommand({
        socketPath: daemon.socketPath,
        method: 'getStatus',
      });

      assertIsJsonRpcSuccess(response);
      const { result } = response;
      expect(result).toHaveProperty('vats');
      expect(result).toHaveProperty('subclusters');
      // `runLoop` is required by `KernelStatusStruct`, and `sendCommand` doesn't
      // validate results — so without this assertion a kernel that stopped
      // emitting it would break every `RpcClient` consumer (the UI panel) while
      // this test stayed green. A live daemon reports the loop running.
      expect(result).toHaveProperty('runLoop', { state: 'running' });
    });

    it('returns error for unknown method', async () => {
      const response = await sendCommand({
        socketPath: daemon.socketPath,
        method: 'nonexistentMethod',
      });

      assertIsJsonRpcFailure(response);
      expect(response.error).toHaveProperty('code', -32601);
    });

    it('refuses executeDBQuery without OCAP_DEV_MODE', async () => {
      const response = await sendCommand({
        socketPath: daemon.socketPath,
        method: 'executeDBQuery',
        params: { sql: 'SELECT key, value FROM kv LIMIT 5' },
      });

      assertIsJsonRpcFailure(response);
      expect(response.error).toStrictEqual({
        code: -32601,
        message:
          "Method not found: 'executeDBQuery' is served only when the daemon runs with OCAP_DEV_MODE=true",
      });
    });

    it('returns error for queueMessage with invalid kref', async () => {
      const response = await sendCommand({
        socketPath: daemon.socketPath,
        method: 'queueMessage',
        params: ['ko99999', 'someMethod', []],
      });
      expect(() => assertIsJsonRpcFailure(response)).not.toThrow();
    });

    it('writes state files to OCAP_HOME', () => {
      expect(existsSync(join(daemon.ocapHome, 'daemon.pid'))).toBe(true);
      expect(existsSync(join(daemon.ocapHome, 'kernel.sqlite'))).toBe(true);
      expect(existsSync(join(daemon.ocapHome, 'daemon.log'))).toBe(true);
    });

    it('restricts OCAP_HOME and the socket to the owning user', async () => {
      // The helper leaves OCAP_HOME at 0755, so this covers the upgrade
      // path: a home directory created before the daemon enforced a mode.
      const [homeMode, socketMode] = await Promise.all([
        permissionsOf(daemon.ocapHome),
        permissionsOf(daemon.socketPath),
      ]);

      expect({ homeMode, socketMode }).toStrictEqual({
        homeMode: 0o700,
        socketMode: 0o600,
      });
    });
  });

  describe('dev mode', () => {
    let daemon: TestDaemon;

    beforeAll(async () => {
      daemon = await spawnTestDaemon({ devMode: true });
    });

    afterAll(async () => {
      await daemon.cleanup();
    });

    it('executes DB query with SQL param', async () => {
      const response = await sendCommand({
        socketPath: daemon.socketPath,
        method: 'executeDBQuery',
        params: { sql: 'SELECT key, value FROM kv LIMIT 5' },
      });

      assertIsJsonRpcSuccess(response);
      expect(Array.isArray(response.result)).toBe(true);
    });
  });

  describe('stop / purge', () => {
    let daemon: TestDaemon;

    beforeAll(async () => {
      daemon = await spawnTestDaemon();
    });

    afterAll(async () => {
      // Kill the daemon process as a fallback if it's still alive.
      try {
        process.kill(daemon.pid, 'SIGKILL');
      } catch {
        // Process already gone.
      }
      await rm(daemon.ocapHome, { recursive: true, force: true });
    });

    it('stops daemon via shutdown RPC', async () => {
      expect(await pingDaemon(daemon.socketPath)).toBe(true);

      await sendCommand({
        socketPath: daemon.socketPath,
        method: 'shutdown',
        timeoutMs: 10_000,
      });

      await waitForDaemonStop(daemon.socketPath);

      expect(await pingDaemon(daemon.socketPath)).toBe(false);
    });

    it('purges state after stop', async () => {
      const { deleteDaemonState } =
        await import('@metamask/kernel-node-runtime/daemon');
      await deleteDaemonState({
        ocapHome: daemon.ocapHome,
        socketPath: daemon.socketPath,
      });

      const remaining = [
        'kernel.sqlite',
        'daemon.pid',
        'daemon.log',
        'daemon.sock',
      ].filter((name) => existsSync(join(daemon.ocapHome, name)));
      expect(remaining).toStrictEqual([]);
    });
  });
});
