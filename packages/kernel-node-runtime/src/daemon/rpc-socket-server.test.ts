import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { DEV_ONLY_METHODS, startRpcSocketServer } from './rpc-socket-server.ts';
import type { RpcSocketServerHandle } from './rpc-socket-server.ts';
import { readLine, writeLine } from './socket-line.ts';

// Set by the one test that exercises the fail-closed path; `chmod` is
// otherwise real, so every other test observes the true socket mode.
let chmodFailure: Error | undefined;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (path: string, mode: number) => {
      if (chmodFailure) {
        throw chmodFailure;
      }
      return actual.chmod(path, mode);
    },
  };
});

const makeMockKernel = () =>
  ({
    getStatus: vi.fn().mockResolvedValue({
      vats: [],
      subclusters: [],
      runLoop: { state: 'running' },
    }),
    terminateAllVats: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
  }) as never;

const makeMockKernelDatabase = () =>
  ({
    executeQuery: vi.fn().mockReturnValue([{ key: 'k', value: 'v' }]),
  }) as never;

/**
 * Generate a socket path unique to this call.
 *
 * Kept short deliberately: macOS caps `sun_path` at 104 bytes, and the
 * darwin `tmpdir()` already spends about half of that.
 *
 * @returns A socket path.
 */
function makeSocketPath(): string {
  return join(tmpdir(), `ocap-rpc-${randomBytes(6).toString('hex')}.sock`);
}

/**
 * Send one JSON-RPC request over a fresh connection and read the response.
 *
 * @param options - Request options.
 * @param options.socketPath - The socket to connect to.
 * @param options.method - The RPC method name.
 * @param options.params - Optional method parameters.
 * @returns The parsed JSON-RPC response.
 */
async function sendRequest({
  socketPath,
  method,
  params,
}: {
  socketPath: string;
  method: string;
  params?: unknown;
}): Promise<Record<string, unknown>> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.removeListener('error', reject);
      resolve(client);
    });
    client.on('error', reject);
  });
  try {
    await writeLine(
      socket,
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method,
        ...(params === undefined ? {} : { params }),
      }),
    );
    return JSON.parse(await readLine(socket)) as Record<string, unknown>;
  } finally {
    socket.destroy();
  }
}

describe('startRpcSocketServer', () => {
  let handle: RpcSocketServerHandle | undefined;

  afterEach(async () => {
    chmodFailure = undefined;
    if (handle) {
      const toClose = handle;
      handle = undefined;
      await toClose.close();
    }
  });

  /**
   * Start a server on a fresh socket path, registering it for cleanup.
   *
   * @param devMode - Whether to serve the dev-only methods.
   * @returns The socket path.
   */
  async function startServer(devMode?: boolean): Promise<string> {
    const socketPath = makeSocketPath();
    handle = await startRpcSocketServer({
      socketPath,
      kernel: makeMockKernel(),
      kernelDatabase: makeMockKernelDatabase(),
      ...(devMode === undefined ? {} : { devMode }),
    });
    return socketPath;
  }

  it('creates the socket readable and writable only by its owner', async () => {
    const socketPath = await startServer();

    // oxlint-disable-next-line no-bitwise
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it('refuses to serve when the socket mode cannot be narrowed', async () => {
    const socketPath = makeSocketPath();
    chmodFailure = new Error('EPERM: operation not permitted');

    await expect(
      startRpcSocketServer({
        socketPath,
        kernel: makeMockKernel(),
        kernelDatabase: makeMockKernelDatabase(),
      }),
    ).rejects.toThrow(`Refusing to serve on ${socketPath}`);

    // The rejection alone would also be satisfied by a server left listening,
    // which is the state this path exists to avoid.
    await expect(
      sendRequest({ socketPath, method: 'getStatus' }),
    ).rejects.toThrow('ENOENT');
  });

  it('serves production methods when devMode is off', async () => {
    const socketPath = await startServer();

    const response = await sendRequest({ socketPath, method: 'getStatus' });

    expect(response.error).toBeUndefined();
    expect(response.result).toHaveProperty('runLoop', { state: 'running' });
  });

  it.each(DEV_ONLY_METHODS)(
    'refuses %s when devMode is off',
    async (method) => {
      const socketPath = await startServer();

      const response = await sendRequest({ socketPath, method });

      expect(response.error).toStrictEqual({
        code: -32601,
        message: `Method not found: '${method}' is served only when the daemon runs with OCAP_DEV_MODE=true`,
      });
    },
  );

  it('does not reach the database when executeDBQuery is refused', async () => {
    const socketPath = makeSocketPath();
    const kernelDatabase = makeMockKernelDatabase();
    handle = await startRpcSocketServer({
      socketPath,
      kernel: makeMockKernel(),
      kernelDatabase,
    });

    await sendRequest({
      socketPath,
      method: 'executeDBQuery',
      params: { sql: 'SELECT 1' },
    });

    expect(
      (kernelDatabase as unknown as { executeQuery: ReturnType<typeof vi.fn> })
        .executeQuery,
    ).not.toHaveBeenCalled();
  });

  it('serves executeDBQuery when devMode is on', async () => {
    const socketPath = await startServer(true);

    const response = await sendRequest({
      socketPath,
      method: 'executeDBQuery',
      params: { sql: 'SELECT key, value FROM kv LIMIT 5' },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toStrictEqual([{ key: 'k', value: 'v' }]);
  });

  it('serves terminateAllVats when devMode is on', async () => {
    const socketPath = await startServer(true);

    const response = await sendRequest({
      socketPath,
      method: 'terminateAllVats',
    });

    expect(response.error).toBeUndefined();
  });

  it('returns method-not-found for a method that does not exist', async () => {
    const socketPath = await startServer();

    const response = await sendRequest({
      socketPath,
      method: 'nonexistentMethod',
    });

    expect((response.error as { code: number }).code).toBe(-32601);
  });
});
