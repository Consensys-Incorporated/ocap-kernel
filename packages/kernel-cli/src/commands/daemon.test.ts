import '@metamask/kernel-shims/endoify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rm } from 'node:fs/promises';

import {
  handleDaemonBegone,
  handleDaemonQueueMessage,
  handleDaemonStart,
  handleRedeemURL,
} from './daemon.ts';
import { isProcessAlive, readPidFile } from '../utils.ts';

vi.mock('@metamask/kernel-node-runtime/daemon', () => ({
  deleteDaemonState: vi.fn(),
}));

vi.mock('@metamask/kernel-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@metamask/kernel-utils')>()),
  prettifySmallcaps: vi.fn((val: unknown) => val),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  readFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('../utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils.ts')>()),
  isProcessAlive: vi.fn(),
  readPidFile: vi.fn(),
  waitFor: vi.fn(),
}));

vi.mock('./daemon-client.ts', () => ({
  getSocketPath: vi.fn().mockReturnValue('/tmp/test.sock'),
  pingDaemon: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('./daemon-spawn.ts', () => ({
  ensureDaemon: vi.fn(),
}));

vi.mock('./relay.ts', () => ({
  getRelayPidPath: () => '/mock/.ocap/relay.pid',
  getRelayAddrPath: () => '/mock/.ocap/relay.addr',
}));

const socketPath = '/tmp/test.sock';

describe('handleDaemonBegone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('deletes the LLM config with the rest of the daemon state', async () => {
    vi.stubEnv('OCAP_HOME', '/mock/.ocap');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(readPidFile).mockResolvedValueOnce(undefined);

    await handleDaemonBegone(socketPath);

    expect(rm).toHaveBeenCalledWith('/mock/.ocap/llm.json', { force: true });
  });
});

describe('handleDaemonStart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('starts the daemon without local relay', async () => {
    const { ensureDaemon } = await import('./daemon-spawn.ts');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await handleDaemonStart(socketPath);

    expect(ensureDaemon).toHaveBeenCalledWith(socketPath);
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('Daemon running'),
    );
  });

  describe('--local-relay', () => {
    it('exits with code 1 when relay has no PID file', async () => {
      vi.mocked(readPidFile).mockResolvedValueOnce(undefined);
      const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      await handleDaemonStart(socketPath, { localRelay: true });

      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('Relay is not running'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('exits with code 1 when relay PID is stale', async () => {
      vi.mocked(readPidFile).mockResolvedValueOnce(9999);
      vi.mocked(isProcessAlive).mockReturnValueOnce(false);
      const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      await handleDaemonStart(socketPath, { localRelay: true });

      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('Relay is not running'),
      );
      expect(process.exitCode).toBe(1);
    });

    it.each([
      [
        'missing',
        async () => {
          const { readFile } = await import('node:fs/promises');
          vi.mocked(readFile).mockRejectedValueOnce(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
          );
        },
      ],
      [
        'empty',
        async () => {
          const { readFile } = await import('node:fs/promises');
          vi.mocked(readFile).mockResolvedValueOnce('   ' as never);
        },
      ],
    ])(
      'exits with code 1 when relay addr file is %s',
      async (_label, setupMock) => {
        vi.mocked(readPidFile).mockResolvedValueOnce(1234);
        vi.mocked(isProcessAlive).mockReturnValueOnce(true);

        await setupMock();

        const writeSpy = vi
          .spyOn(process.stderr, 'write')
          .mockReturnValue(true);

        await handleDaemonStart(socketPath, { localRelay: true });

        expect(writeSpy).toHaveBeenCalledWith(
          expect.stringContaining('Relay address file not found'),
        );
        expect(process.exitCode).toBe(1);
      },
    );

    it('initializes remote comms with the relay addr', async () => {
      vi.mocked(readPidFile).mockResolvedValueOnce(1234);
      vi.mocked(isProcessAlive).mockReturnValueOnce(true);

      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValueOnce(
        '/ip4/127.0.0.1/tcp/9001/ws/p2p/QmFoo' as never,
      );

      const { sendCommand } = await import('./daemon-client.ts');
      vi.mocked(sendCommand)
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 1,
          result: { remoteComms: { state: 'identity-only' } },
        })
        .mockResolvedValueOnce({ jsonrpc: '2.0', id: 2, result: {} });

      const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      await handleDaemonStart(socketPath, { localRelay: true });

      expect(sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'initRemoteComms',
          params: { relays: ['/ip4/127.0.0.1/tcp/9001/ws/p2p/QmFoo'] },
        }),
      );
      expect(writeSpy).toHaveBeenCalledWith(
        'Remote comms initialized with local relay.\n',
      );
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('Daemon running'),
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('skips initRemoteComms when remote comms already connected', async () => {
      vi.mocked(readPidFile).mockResolvedValueOnce(1234);
      vi.mocked(isProcessAlive).mockReturnValueOnce(true);

      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValueOnce(
        '/ip4/127.0.0.1/tcp/9001/ws/p2p/QmFoo' as never,
      );

      const { sendCommand } = await import('./daemon-client.ts');
      vi.mocked(sendCommand).mockResolvedValueOnce({
        jsonrpc: '2.0',
        id: 1,
        result: { remoteComms: { state: 'connected' } },
      });

      const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      await handleDaemonStart(socketPath, { localRelay: true });

      expect(sendCommand).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith(
        'Remote comms already initialized.\n',
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('exits with code 1 when initRemoteComms fails', async () => {
      vi.mocked(readPidFile).mockResolvedValueOnce(1234);
      vi.mocked(isProcessAlive).mockReturnValueOnce(true);

      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValueOnce(
        '/ip4/127.0.0.1/tcp/9001/ws/p2p/QmFoo' as never,
      );

      const { sendCommand } = await import('./daemon-client.ts');
      vi.mocked(sendCommand)
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 1,
          result: { remoteComms: { state: 'identity-only' } },
        })
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 2,
          error: { code: -32000, message: 'init failed' },
        });

      const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      await handleDaemonStart(socketPath, { localRelay: true });

      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to initialize remote comms: init failed',
        ),
      );
      expect(process.exitCode).toBe(1);
    });
  });
});

describe('handleRedeemURL', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('sends redeemOcapURL RPC and prints the result', async () => {
    const { sendCommand } = await import('./daemon-client.ts');
    vi.mocked(sendCommand).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: '1',
      result: 'ko42',
    });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await handleRedeemURL('ocap:abc@peer1,relay1', '/tmp/test.sock');

    expect(sendCommand).toHaveBeenCalledWith({
      socketPath: '/tmp/test.sock',
      method: 'redeemOcapURL',
      params: { url: 'ocap:abc@peer1,relay1' },
    });
    expect(writeSpy).toHaveBeenCalledWith('"ko42"\n');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints error and sets exit code on RPC failure', async () => {
    const { sendCommand } = await import('./daemon-client.ts');
    vi.mocked(sendCommand).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: '1',
      error: { code: -32000, message: 'Remote comms not initialized' },
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await handleRedeemURL('ocap:bad@peer', '/tmp/test.sock');

    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: Remote comms not initialized (code -32000)\n',
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('handleDaemonQueueMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('sends queueMessage RPC with positional params', async () => {
    const { sendCommand } = await import('./daemon-client.ts');
    vi.mocked(sendCommand).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: '1',
      result: { body: '#"ok"', slots: [] },
    });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await handleDaemonQueueMessage({
      target: 'ko1',
      method: 'doStuff',
      args: [1, 2],
      socketPath,
    });

    expect(sendCommand).toHaveBeenCalledWith({
      socketPath,
      method: 'queueMessage',
      params: ['ko1', 'doStuff', [1, 2]],
    });
  });

  it('prints prettified CapData on success', async () => {
    const { sendCommand } = await import('./daemon-client.ts');
    vi.mocked(sendCommand).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: '1',
      result: { body: '#"hello"', slots: [] },
    });

    const { prettifySmallcaps } = await import('@metamask/kernel-utils');
    vi.mocked(prettifySmallcaps).mockReturnValueOnce('hello');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await handleDaemonQueueMessage({
      target: 'ko1',
      method: 'greet',
      args: [],
      socketPath,
    });

    expect(prettifySmallcaps).toHaveBeenCalledWith({
      body: '#"hello"',
      slots: [],
    });
    expect(stdoutSpy).toHaveBeenCalledWith('"hello"\n');
  });

  it('prints raw CapData when raw is true', async () => {
    const { sendCommand } = await import('./daemon-client.ts');
    const rawResult = { body: '#"hello"', slots: [] };
    vi.mocked(sendCommand).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: '1',
      result: rawResult,
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await handleDaemonQueueMessage({
      target: 'ko1',
      method: 'greet',
      args: [],
      socketPath,
      raw: true,
    });

    expect(stdoutSpy).toHaveBeenCalledWith(`${JSON.stringify(rawResult)}\n`);
  });

  it('prints error and sets exit code on RPC failure', async () => {
    const { sendCommand } = await import('./daemon-client.ts');
    vi.mocked(sendCommand).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: '1',
      error: { code: -32603, message: 'target not found' },
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await handleDaemonQueueMessage({
      target: 'ko999',
      method: 'nope',
      args: [],
      socketPath,
    });

    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: target not found (code -32603)\n',
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('forwards timeoutMs when provided', async () => {
    const { sendCommand } = await import('./daemon-client.ts');
    vi.mocked(sendCommand).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: '1',
      result: { body: '#null', slots: [] },
    });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await handleDaemonQueueMessage({
      target: 'ko1',
      method: 'slow',
      args: [],
      socketPath,
      timeoutMs: 30_000,
    });

    expect(sendCommand).toHaveBeenCalledWith({
      socketPath,
      method: 'queueMessage',
      params: ['ko1', 'slow', []],
      timeoutMs: 30_000,
    });
  });
});
