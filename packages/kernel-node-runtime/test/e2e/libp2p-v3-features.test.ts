import type { Libp2p } from '@libp2p/interface';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { startRelay } from '@metamask/kernel-utils/libp2p';
import { Kernel, kunser, makeKernelStore } from '@metamask/ocap-kernel';
import { delay } from '@ocap/repo-tools/test-utils';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';

import { makeTestKernel } from '../helpers/kernel.ts';
import {
  makeRemoteVatConfig,
  restartKernelAndReloadVat,
  sendRemoteMessage,
  setupAliceAndBob,
} from '../helpers/remote-comms.ts';
import { stopWithTimeout } from '../helpers/stop-with-timeout.ts';

const NETWORK_TIMEOUT = 30_000;
const relayPeerId = '12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc';
const testRelays = [`/ip4/127.0.0.1/tcp/9001/ws/p2p/${relayPeerId}`];

const testBackoffOptions = {
  reconnectionBaseDelayMs: 10,
  reconnectionMaxDelayMs: 50,
  handshakeTimeoutMs: 3_000,
  writeTimeoutMs: 3_000,
  ackTimeoutMs: 2_000,
};

describe.sequential('libp2p v3 Features E2E', () => {
  let relay: Libp2p;
  let kernel1: Kernel;
  let kernel2: Kernel;
  let dbFilename1: string;
  let dbFilename2: string;
  let tempDir: string;
  let kernelStore1: ReturnType<typeof makeKernelStore>;
  let kernelStore2: ReturnType<typeof makeKernelStore>;

  beforeAll(async () => {
    relay = await startRelay(console);
  });

  afterAll(async () => {
    if (relay) {
      await relay.stop();
    }
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ocap-v3-'));
    dbFilename1 = join(tempDir, 'kernel1.db');
    dbFilename2 = join(tempDir, 'kernel2.db');

    const kernelDatabase1 = await makeSQLKernelDatabase({
      dbFilename: dbFilename1,
    });
    kernelStore1 = makeKernelStore(kernelDatabase1);

    const kernelDatabase2 = await makeSQLKernelDatabase({
      dbFilename: dbFilename2,
    });
    kernelStore2 = makeKernelStore(kernelDatabase2);

    kernel1 = await makeTestKernel(kernelDatabase1);
    kernel2 = await makeTestKernel(kernelDatabase2);
  });

  afterEach(async () => {
    const STOP_TIMEOUT = 3000;
    await Promise.all([
      kernel1 &&
        stopWithTimeout(
          async () => kernel1.stop(),
          STOP_TIMEOUT,
          'kernel1.stop',
        ),
      kernel2 &&
        stopWithTimeout(
          async () => kernel2.stop(),
          STOP_TIMEOUT,
          'kernel2.stop',
        ),
    ]);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('peer:disconnect Reconnection', () => {
    it(
      'recovers queued message after peer:disconnect triggers reconnection',
      async () => {
        // The fast test backoff spends the default 10 connection attempts a
        // minute while kernel2 is down, and every send after that fails.
        const reconnectOptions = {
          ...testBackoffOptions,
          maxConnectionAttemptsPerMinute: 500,
        };
        const { aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          reconnectOptions,
        );

        // Establish initial communication
        const initial = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(initial).toContain('vat Bob got "hello" from Alice');

        // Stop kernel2 — triggers both readChannel error and peer:disconnect.
        // The peer:disconnect event acts as a safety net ensuring reconnection
        // is attempted even after readChannel clears the channel.
        await kernel2.stop();

        // Queue a message while kernel2 is down — this triggers reconnection
        const recoveryPromise = kernel1.queueMessage(
          aliceRef,
          'sendRemoteMessage',
          [bobURL, 'hello', ['Alice']],
        );

        // Restart kernel2; kernel1's ACK retransmit delivers the queued message
        const bobConfig = makeRemoteVatConfig('Bob');
        const restartResult = await restartKernelAndReloadVat(
          dbFilename2,
          false,
          testRelays,
          bobConfig,
          reconnectOptions,
        );
        kernel2 = restartResult.kernel;

        const result = kunser(await recoveryPromise) as string;
        expect(result).toContain('vat Bob got "hello" from Alice');

        // Verify ongoing connectivity after peer:disconnect recovery
        const followUp = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(followUp).toContain('vat Bob got "hello" from Alice');
      },
      NETWORK_TIMEOUT * 2,
    );
  });

  describe('Stream Inactivity Timeout', () => {
    it(
      'recovers communication after idle period exceeds inactivity timeout',
      async () => {
        // Use a short inactivity timeout to test the auto-abort behavior.
        // Must be >= MIN_STREAM_INACTIVITY_TIMEOUT_MS (5 s) since the
        // transport clamps lower values.
        const shortTimeoutOptions = {
          ...testBackoffOptions,
          streamInactivityTimeoutMs: 6_000,
        };

        const { aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          shortTimeoutOptions,
        );

        // Establish initial communication
        const initial = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(initial).toContain('vat Bob got "hello" from Alice');

        // Wait longer than the inactivity timeout (6s + buffer).
        // The stream should auto-abort due to inactivityTimeout,
        // triggering connection loss handling and reconnection.
        await delay(8_000);

        // Send another message — the transport layer should
        // reconnect since the previous stream was aborted by inactivity.
        const afterIdle = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(afterIdle).toContain('vat Bob got "hello" from Alice');
      },
      NETWORK_TIMEOUT * 2,
    );
  });

  describe('Fast Failure on Closed Streams', () => {
    it(
      'handles rapid sends during disconnect without hanging',
      async () => {
        const { aliceRef, bobURL, peerId2 } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        // Establish initial connectivity
        await sendRemoteMessage(kernel1, aliceRef, bobURL, 'hello', ['Alice']);

        // Intentionally close the connection — writes should fail fast
        // via stream.status check rather than waiting for timeout
        await kernel1.closeConnection(peerId2);

        const start = Date.now();
        // This should fail quickly (stream.status !== 'open') rather than
        // waiting for the full write timeout (3000ms)
        await expect(
          kernel1.queueMessage(aliceRef, 'sendRemoteMessage', [
            bobURL,
            'hello',
            ['Alice'],
          ]),
        ).rejects.toThrow('Message delivery failed after intentional close');
        const elapsed = Date.now() - start;

        // Should fail well under the write timeout
        expect(elapsed).toBeLessThan(testBackoffOptions.writeTimeoutMs);
      },
      NETWORK_TIMEOUT,
    );
  });

  describe('Connection Type Awareness', () => {
    it(
      'establishes relayed connections and communicates successfully',
      async () => {
        // Both kernels connect via relay — the connection.direct property
        // should be false (relayed), and the log should include "relayed".
        // This validates that the connection type detection works with real
        // libp2p connections.
        const { aliceRef, bobURL, peerId1, peerId2 } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        // Verify distinct peer IDs (confirms real libp2p nodes)
        expect(peerId1).not.toBe(peerId2);

        // Bidirectional communication through relay
        const response = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(response).toContain('vat Bob got "hello" from Alice');
      },
      NETWORK_TIMEOUT,
    );
  });
});
