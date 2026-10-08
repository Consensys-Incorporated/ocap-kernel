import { assertSupportedPlatform } from '@metamask/kernel-node-runtime/daemon';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

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
});
