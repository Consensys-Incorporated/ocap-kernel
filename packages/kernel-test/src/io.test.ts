import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import type { Kernel } from '@metamask/ocap-kernel';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  getBundleSpec,
  makeAuditedKernelOptions,
  makeTestLogger,
  makeTrackedKernel,
} from './utils.ts';

function tempSocketPath(): string {
  return path.join(
    os.tmpdir(),
    `io-int-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

async function connectToSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.removeListener('error', reject);
      resolve(client);
    });
    client.on('error', reject);
  });
}

async function writeLine(socket: net.Socket, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${line}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function readLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (data: Buffer): void => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        socket.removeListener('data', onData);
        resolve(buffer.slice(0, idx));
      }
    };
    socket.on('data', onData);
  });
}

/**
 * Stand up a kernel wired to the real Node listener factory, with an
 * io-vat subcluster listening on `socketPath`.
 *
 * @param socketPath - Path for the listener's Unix domain socket.
 * @returns The kernel and the io-vat's root kref.
 */
async function makeIoKernel(
  socketPath: string,
): Promise<{ kernel: Kernel; rootKref: string }> {
  const kernelDatabase = await makeSQLKernelDatabase({
    dbFilename: ':memory:',
  });
  const { logger } = makeTestLogger();

  const { NodejsPlatformServices, makeIOListenerFactory } = await import(
    '@metamask/kernel-node-runtime'
  );
  const kernel = await makeTrackedKernel(
    new NodejsPlatformServices({
      logger: logger.subLogger({ tags: ['platform'] }),
    }),
    kernelDatabase,
    {
      resetStorage: true,
      logger,
      ioListenerFactory: makeIOListenerFactory(),
      ...makeAuditedKernelOptions(),
    },
  );

  const { rootKref } = await kernel.launchSubcluster({
    bootstrap: 'io',
    forceReset: true,
    io: {
      repl: {
        type: 'socket' as const,
        path: socketPath,
      },
    },
    services: ['repl'],
    vats: {
      io: {
        bundleSpec: getBundleSpec('io-vat'),
        parameters: { name: 'io' },
      },
    },
  });
  await waitUntilQuiescent();

  return { kernel, rootKref };
}

describe('IO kernel service', () => {
  const clients: net.Socket[] = [];

  afterEach(async () => {
    for (const client of clients) {
      client.destroy();
    }
    clients.length = 0;
  });

  it('reads and writes through an accepted connection', async () => {
    const socketPath = tempSocketPath();
    const { kernel, rootKref } = await makeIoKernel(socketPath);

    const client = await connectToSocket(socketPath);
    clients.push(client);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await kernel.queueMessage(rootKref, 'doAccept', []);
    await waitUntilQuiescent(100);

    // Send a line from the test to the vat
    await writeLine(client, 'hello from test');

    await kernel.queueMessage(rootKref, 'doRead', []);
    await waitUntilQuiescent(100);

    const bufferResult = await kernel.queueMessage(
      rootKref,
      'getReadBuffer',
      [],
    );
    await waitUntilQuiescent(100);
    expect(bufferResult.body).toContain('hello from test');

    // Trigger the vat to write
    const linePromise = readLine(client);
    await kernel.queueMessage(rootKref, 'doWrite', ['hello from vat']);
    await waitUntilQuiescent(100);

    expect(await linePromise).toBe('hello from vat');
  });

  it('serves two concurrent peers without crossing their traffic', async () => {
    const socketPath = tempSocketPath();
    const { kernel, rootKref } = await makeIoKernel(socketPath);

    const alice = await connectToSocket(socketPath);
    clients.push(alice);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const bob = await connectToSocket(socketPath);
    clients.push(bob);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Both peers are accepted — under the old single-client channel the
    // second connection would have been destroyed outright.
    await kernel.queueMessage(rootKref, 'doAccept', []);
    await waitUntilQuiescent(100);
    await kernel.queueMessage(rootKref, 'doAccept', []);
    await waitUntilQuiescent(100);

    const countResult = await kernel.queueMessage(
      rootKref,
      'getConnectionCount',
      [],
    );
    await waitUntilQuiescent(100);
    expect(countResult.body).toContain('2');

    // Each peer's line arrives on its own connection.
    await writeLine(alice, 'from-alice');
    await writeLine(bob, 'from-bob');
    await new Promise((resolve) => setTimeout(resolve, 20));

    await kernel.queueMessage(rootKref, 'doRead', [0]);
    await waitUntilQuiescent(100);
    await kernel.queueMessage(rootKref, 'doRead', [1]);
    await waitUntilQuiescent(100);

    const bufferResult = await kernel.queueMessage(
      rootKref,
      'getReadBuffer',
      [],
    );
    await waitUntilQuiescent(100);
    expect(bufferResult.body).toContain('from-alice');
    expect(bufferResult.body).toContain('from-bob');

    // And each write goes back to the right peer.
    const aliceHeard = readLine(alice);
    const bobHeard = readLine(bob);
    await kernel.queueMessage(rootKref, 'doWrite', ['for-alice', 0]);
    await waitUntilQuiescent(100);
    await kernel.queueMessage(rootKref, 'doWrite', ['for-bob', 1]);
    await waitUntilQuiescent(100);

    expect(await aliceHeard).toBe('for-alice');
    expect(await bobHeard).toBe('for-bob');
  });
});
