import { assertSupportedPlatform } from '@metamask/kernel-node-runtime/daemon';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { pingDaemon } from './daemon-client.ts';
import { ensureDaemon } from './daemon-spawn.ts';

vi.mock('@metamask/kernel-node-runtime/daemon', () => ({
  assertSupportedPlatform: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('./daemon-client.ts', () => ({
  pingDaemon: vi.fn(),
}));

describe('ensureDaemon', () => {
  it('checks the platform before pinging or spawning the daemon', async () => {
    vi.mocked(assertSupportedPlatform).mockImplementationOnce(() => {
      throw new Error('unsupported');
    });

    await expect(ensureDaemon('/tmp/daemon.sock')).rejects.toThrow(
      'unsupported',
    );
    expect(pingDaemon).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns without spawning when the daemon responds', async () => {
    vi.mocked(pingDaemon).mockResolvedValueOnce(true);

    await ensureDaemon('/tmp/daemon.sock');

    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails at once, naming the log, when the daemon exits during startup', async () => {
    const ocapHome = await mkdtemp(join(tmpdir(), 'daemon-spawn-'));
    vi.stubEnv('OCAP_HOME', ocapHome);
    onTestFinished(async () => {
      vi.unstubAllEnvs();
      await rm(ocapHome, { recursive: true, force: true });
    });
    vi.mocked(pingDaemon).mockResolvedValue(false);
    vi.mocked(spawn).mockReturnValueOnce({
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (code: number) => void) => {
        if (event === 'exit') {
          listener(1);
        }
      }),
    } as never);

    await expect(ensureDaemon('/tmp/daemon.sock')).rejects.toThrow(
      `Daemon exited during startup (code 1); see ${ocapHome}/daemon.log`,
    );
  });
});
