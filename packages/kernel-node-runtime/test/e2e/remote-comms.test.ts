import type { Libp2p } from '@libp2p/interface';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { startRelay } from '@metamask/kernel-utils/libp2p';
import { Kernel, kunser, makeKernelStore } from '@metamask/ocap-kernel';
import type { KRef, VatId } from '@metamask/ocap-kernel';
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

import { makeTestKernel, runTestVats } from '../helpers/kernel.ts';
import {
  getPeerIds,
  getVatRootRef,
  launchVatAndGetURL,
  makeMaasClientConfig,
  makeMaasServerConfig,
  makeRemoteVatConfig,
  restartKernel,
  restartKernelAndReloadVat,
  sendRemoteMessage,
  setupAliceAndBob,
} from '../helpers/remote-comms.ts';
import { stopWithTimeout } from '../helpers/stop-with-timeout.ts';

// Increase timeout for network operations
const NETWORK_TIMEOUT = 30_000;
// Test relay configuration
// The relay peer ID is deterministic based on RELAY_LOCAL_ID = 200 in relay.ts
const relayPeerId = '12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc';
const testRelays = [`/ip4/127.0.0.1/tcp/9001/ws/p2p/${relayPeerId}`];

// Fast timing options for tests to avoid waiting on real delays
const testBackoffOptions = {
  reconnectionBaseDelayMs: 10,
  reconnectionMaxDelayMs: 50,
  handshakeTimeoutMs: 3_000,
  writeTimeoutMs: 3_000,
  ackTimeoutMs: 2_000,
};

describe.sequential('Remote Communications E2E', () => {
  let relay: Libp2p;
  let kernel1: Kernel;
  let kernel2: Kernel;
  let dbFilename1: string;
  let dbFilename2: string;
  let tempDir: string;
  let kernelStore1: ReturnType<typeof makeKernelStore>;
  let kernelStore2: ReturnType<typeof makeKernelStore>;

  beforeAll(async () => {
    // Start the relay server once for all tests (stateless, reusable)
    relay = await startRelay(console);
  });

  afterAll(async () => {
    if (relay) {
      await relay.stop();
    }
  });

  beforeEach(async () => {
    // Create temp directory for database files
    tempDir = await mkdtemp(join(tmpdir(), 'ocap-e2e-'));
    dbFilename1 = join(tempDir, 'kernel1.db');
    dbFilename2 = join(tempDir, 'kernel2.db');

    // Create two independent kernels with separate storage
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
    // Stop kernels in parallel to speed up cleanup
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

  describe('Basic Connectivity', () => {
    it(
      'initializes remote comms on both kernels',
      async () => {
        await kernel1.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });
        await kernel2.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });

        const status1 = await kernel1.getStatus();
        const status2 = await kernel2.getStatus();

        expect(status1.remoteComms?.state).toBe('connected');
        expect(status2.remoteComms?.state).toBe('connected');

        const { peerId1, peerId2 } = await getPeerIds(kernel1, kernel2);
        expect(peerId1).not.toBe(peerId2);
      },
      NETWORK_TIMEOUT,
    );

    it(
      'sends messages between vats on different kernels',
      async () => {
        const { aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

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

    it(
      'establishes bidirectional communication between kernels',
      async () => {
        const { aliceURL, bobURL, aliceRef, bobRef } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        const aliceToBob = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(aliceToBob).toContain('vat Bob got "hello" from Alice');

        const bobToAlice = await sendRemoteMessage(
          kernel2,
          bobRef,
          aliceURL,
          'hello',
          ['Bob'],
        );
        expect(bobToAlice).toContain('vat Alice got "hello" from Bob');
      },
      NETWORK_TIMEOUT,
    );
  });

  describe('Connection Resilience', () => {
    it(
      'remote relationships should survive kernel restart',
      async () => {
        // Initialize remote comms
        await kernel1.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });
        await kernel2.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });

        // Launch client vat on kernel1
        const clientConfig = makeMaasClientConfig('client1', true);
        let clientKernel = kernel1;
        await runTestVats(clientKernel, clientConfig);
        const clientRootRef = kernelStore1.getRootObject('v1' as VatId) as KRef;

        // Launch server vat on kernel2
        const serverConfig = makeMaasServerConfig('server2', true);
        let serverKernel = kernel2;
        const serverResult = await runTestVats(serverKernel, serverConfig);

        // The server's ocap URL is its bootstrap result
        const serverURL = serverResult as string;

        expect(typeof serverURL).toBe('string');
        expect(serverURL).toMatch(/^ocap:/u);

        // Configure the client with the server's URL
        const setupResult = await clientKernel.queueMessage(
          clientRootRef,
          'setMaas',
          [serverURL],
        );
        let response = kunser(setupResult);
        expect(response).toBeDefined();
        expect(response).toContain('MaaS service URL set');

        // Tell the client to talk to the server
        let expectedCount = 1;
        const stepResult = await clientKernel.queueMessage(
          clientRootRef,
          'step',
          [],
        );
        response = kunser(stepResult);
        expect(response).toBeDefined();
        expect(response).toContain(`next step: ${expectedCount} `);

        // Kill the server and restart it
        await serverKernel.stop();
        serverKernel = await makeTestKernel(
          await makeSQLKernelDatabase({ dbFilename: dbFilename2 }),
          { resetStorage: false },
        );
        await serverKernel.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });

        // Tell the client to talk to the server a second time
        expectedCount += 1;
        const stepResult2 = await clientKernel.queueMessage(
          clientRootRef,
          'step',
          [],
        );
        response = kunser(stepResult2);
        expect(response).toBeDefined();
        expect(response).toContain(`next step: ${expectedCount} `);

        // Kill the client and restart it
        await clientKernel.stop();
        clientKernel = await makeTestKernel(
          await makeSQLKernelDatabase({ dbFilename: dbFilename1 }),
          { resetStorage: false },
        );
        await clientKernel.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });

        // Tell the client to talk to the server a third time
        expectedCount += 1;
        const stepResult3 = await clientKernel.queueMessage(
          clientRootRef,
          'step',
          [],
        );
        response = kunser(stepResult3);
        expect(response).toBeDefined();
        expect(response).toContain(`next step: ${expectedCount} `);

        // Update describe-scope refs so afterEach stops the restarted kernels
        kernel1 = clientKernel;
        kernel2 = serverKernel;
      },
      NETWORK_TIMEOUT * 2,
    );

    it(
      'handles connection failure and recovery',
      async () => {
        const reconnectOptions = {
          ...testBackoffOptions,
          maxConnectionAttemptsPerMinute: 500,
        };
        const { bobURL, aliceRef } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          reconnectOptions,
        );

        // Verify initial connectivity
        const initialMessage = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(initialMessage).toContain('vat Bob got "hello" from Alice');

        // Simulate connection failure by stopping kernel2
        await kernel2.stop();

        // Queue a message while kernel2 is down - this triggers reconnection
        const recoveryPromise = kernel1.queueMessage(
          aliceRef,
          'testConnection',
          [bobURL],
        );

        // Restart kernel2 - the queued message should trigger reconnection
        const bobConfig = makeRemoteVatConfig('Bob');
        const restartResult = await restartKernelAndReloadVat(
          dbFilename2,
          false,
          testRelays,
          bobConfig,
          reconnectOptions,
        );
        kernel2 = restartResult.kernel;

        // Wait for the recovery message to complete
        const recoveryResult = await recoveryPromise;
        const recoveryResponse = kunser(recoveryResult) as {
          status: string;
          result?: unknown;
          error?: string;
        };

        // Verify connection was recovered
        expect(recoveryResponse).toHaveProperty('status');
        expect(recoveryResponse.status).toBe('connected');
        expect(recoveryResponse.result).toBe('pong from Bob');

        // Verify ongoing connectivity with a follow-up message
        const followUpMessage = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(followUpMessage).toContain('vat Bob got "hello" from Alice');
      },
      NETWORK_TIMEOUT * 2,
    );

    it(
      'handles connection failure to non-existent peer',
      async () => {
        await kernel1.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });

        const aliceConfig = makeRemoteVatConfig('Alice');
        await launchVatAndGetURL(kernel1, aliceConfig);
        const aliceRef = getVatRootRef(kernel1, kernelStore1, 'Alice');

        // Create a fake ocap URL for a non-existent kernel
        const fakeURL =
          'ocap://12D3KooWFakePeerIdThatDoesNotExist123456789/ko1';

        // Try to connect to non-existent peer - should fail gracefully
        const connectionTest = await kernel1.queueMessage(
          aliceRef,
          'testConnection',
          [fakeURL],
        );

        const result = kunser(connectionTest) as {
          status: string;
          error?: string;
        };
        expect(result).toHaveProperty('status');
        expect(result.status).toBe('disconnected');
        expect(result).toHaveProperty('error');
      },
      NETWORK_TIMEOUT,
    );

    it(
      'handles reconnection with exponential backoff',
      async () => {
        // ackTimeoutMs must be long enough for kernel2 to restart + reconnect
        // before Alice's URL redemption gives up (fires after
        // ackTimeoutMs × (MAX_RETRIES + 1)). See PR #927 for the same fix
        // applied to sibling tests with this pattern.
        const reconnectOptions = {
          ...testBackoffOptions,
          ackTimeoutMs: 5_000,
        };

        const { aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          reconnectOptions,
        );

        const initialMessage = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(initialMessage).toContain('vat Bob got "hello" from Alice');

        await kernel2.stop();

        // Send a message which will queue and trigger reconnection attempts
        // The reconnection will use exponential backoff (with fast test config).
        const messagePromise = kernel1.queueMessage(
          aliceRef,
          'sendRemoteMessage',
          [bobURL, 'hello', ['Alice']],
        );

        // Track when reconnection attempts happen by monitoring when
        // the message succeeds after restarting kernel2
        const reconnectStartTime = Date.now();

        const bobConfig = makeRemoteVatConfig('Bob');
        const restartResult = await restartKernelAndReloadVat(
          dbFilename2,
          false,
          testRelays,
          bobConfig,
          reconnectOptions,
        );
        kernel2 = restartResult.kernel;

        // The queued message should now be delivered
        const reconnectResult = await messagePromise;
        const reconnectEndTime = Date.now();
        const totalReconnectTime = reconnectEndTime - reconnectStartTime;

        expect(kunser(reconnectResult)).toContain(
          'vat Bob got "hello" from Alice',
        );

        // Verify that reconnection took some time (indicating backoff delays)
        // Even with fast test backoff, kernel restart + reconnection takes measurable time
        expect(totalReconnectTime).toBeGreaterThan(100);

        const followUpMessage = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(followUpMessage).toContain('vat Bob got "hello" from Alice');
      },
      NETWORK_TIMEOUT * 2,
    );
  });

  describe('Message Queueing', () => {
    it(
      'queues messages when connection is not established',
      async () => {
        await kernel1.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });
        await kernel2.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });

        const aliceConfig = makeRemoteVatConfig('Alice');
        await launchVatAndGetURL(kernel1, aliceConfig);
        const aliceRef = getVatRootRef(kernel1, kernelStore1, 'Alice');

        const bobConfig = makeRemoteVatConfig('Bob');
        const bobURL = await launchVatAndGetURL(kernel2, bobConfig);

        await kernel2.stop();

        // Send messages while kernel2 is offline - these should be queued
        const queuePromises = [];
        for (let i = 0; i < 3; i++) {
          const promise = kernel1.queueMessage(aliceRef, 'queueMessage', [
            bobURL,
            'receiveSequence',
            [i],
          ]);
          queuePromises.push(promise);
        }
        const restartResult = await restartKernelAndReloadVat(
          dbFilename2,
          false,
          testRelays,
          bobConfig,
          testBackoffOptions,
        );
        kernel2 = restartResult.kernel;

        // Messages should be queued and delivered after reconnection
        // Note: Some may fail if the vat wasn't restored properly, but queueing should work
        const queueResults = await Promise.allSettled(queuePromises);
        expect(queueResults).toHaveLength(3);

        const normalMessage = await kernel1.queueMessage(
          aliceRef,
          'sendRemoteMessage',
          [bobURL, 'receiveSequence', [99]],
        );
        const response = kunser(normalMessage);
        expect(response).toBe('Sequence 99 received');
      },
      NETWORK_TIMEOUT * 2,
    );

    it(
      'preserves message order during queueing',
      async () => {
        const { aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        // Send multiple messages in sequence using sendSequence
        const sequenceResult = await kernel1.queueMessage(
          aliceRef,
          'sendSequence',
          [bobURL, 5],
        );

        const results = kunser(sequenceResult) as string[];
        expect(results).toHaveLength(5);

        // Verify messages were received in order
        for (let i = 0; i < 5; i++) {
          expect(results[i]).toBe(`Sequence ${i} received`);
        }
      },
      NETWORK_TIMEOUT,
    );
  });

  describe('Queue Management', () => {
    it(
      'rejects new messages when queue reaches MAX_QUEUE limit',
      async () => {
        // Use high rate limits to avoid rate limiting interference with queue limit test.
        // maxConnectionAttemptsPerMinute is needed because async kernel service invocations
        // can cause multiple concurrent connection attempts when processing many messages.
        // ackTimeoutMs must be long enough for kernel2 to restart + reconnect before
        // the RemoteHandle gives up (give-up fires after ackTimeoutMs × (MAX_RETRIES + 1)).
        const queueTestOptions = {
          ...testBackoffOptions,
          maxMessagesPerSecond: 500,
          maxConnectionAttemptsPerMinute: 500,
          ackTimeoutMs: 5_000,
        };

        const { aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          queueTestOptions,
        );

        await sendRemoteMessage(kernel1, aliceRef, bobURL, 'hello', ['Alice']);

        await kernel2.stop();

        // Send MAX_QUEUE + 1 messages (201 messages) while disconnected
        // Messages beyond the queue limit (200) should be rejected
        const messagePromises = [];
        for (let i = 0; i <= 200; i++) {
          const promise = kernel1.queueMessage(aliceRef, 'queueMessage', [
            bobURL,
            'receiveSequence',
            [i],
          ]);
          messagePromises.push(promise);
        }

        const bobConfig = makeRemoteVatConfig('Bob');
        const restartResult = await restartKernelAndReloadVat(
          dbFilename2,
          false,
          testRelays,
          bobConfig,
          queueTestOptions,
        );
        kernel2 = restartResult.kernel;

        // Check results - messages beyond queue capacity should be rejected
        const results = await Promise.allSettled(messagePromises);
        expect(results).toHaveLength(201);

        // Messages beyond queue capacity should be rejected with queue full error.
        // Messages within capacity may fulfill or reject (e.g., if the remote vat
        // was restarted and references are stale), but they should NOT contain
        // "queue at capacity".
        const queueFullResults = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected' &&
            String(result.reason).includes('queue at capacity'),
        );
        // At most 1 message (the 201st) should be rejected due to queue capacity
        expect(queueFullResults.length).toBeLessThanOrEqual(1);

        const newMessageResult = await kernel1.queueMessage(
          aliceRef,
          'sendRemoteMessage',
          [bobURL, 'receiveSequence', [999]],
        );
        const newMessage = kunser(newMessageResult);
        expect(newMessage).toBe('Sequence 999 received');
      },
      NETWORK_TIMEOUT * 4,
    );
  });

  describe('Multiple Peer Reconnections', () => {
    it(
      'handles multiple simultaneous reconnections to different peers',
      async () => {
        // Create a third kernel for testing multiple peers
        const dbFilename3 = join(tempDir, 'kernel3.db');
        const kernelDatabase3 = await makeSQLKernelDatabase({
          dbFilename: dbFilename3,
        });
        let kernel3: Kernel | undefined;

        // The ACK give-up fires after ackTimeoutMs × (MAX_RETRIES + 1).
        // kernel2 and kernel3 restart in parallel below, but each restart
        // (new kernel + libp2p connect + vat launch) still takes several
        // seconds. A 5 s ACK timeout gives a 20 s redemption window.
        // maxConnectionAttemptsPerMinute is raised because the fast test
        // backoff (10-50 ms) exhausts the default 10/min rate limit before
        // the peers finish restarting, blocking reconnection for ~60 s.
        const multiPeerOptions = {
          ...testBackoffOptions,
          ackTimeoutMs: 5_000,
          maxConnectionAttemptsPerMinute: 500,
        };

        try {
          await kernel1.initRemoteComms({
            relays: testRelays,
            ...multiPeerOptions,
          });
          await kernel2.initRemoteComms({
            relays: testRelays,
            ...multiPeerOptions,
          });
          kernel3 = await makeTestKernel(kernelDatabase3);
          await kernel3.initRemoteComms({
            relays: testRelays,
            ...multiPeerOptions,
          });

          const aliceConfig = makeRemoteVatConfig('Alice');
          const bobConfigInitial = makeRemoteVatConfig('Bob');
          const charlieConfigInitial = makeRemoteVatConfig('Charlie');

          await launchVatAndGetURL(kernel1, aliceConfig);
          const bobURL = await launchVatAndGetURL(kernel2, bobConfigInitial);
          const charlieURL = await launchVatAndGetURL(
            kernel3,
            charlieConfigInitial,
          );

          const aliceRef = getVatRootRef(kernel1, kernelStore1, 'Alice');

          await sendRemoteMessage(kernel1, aliceRef, bobURL, 'hello', [
            'Alice',
          ]);
          await sendRemoteMessage(kernel1, aliceRef, charlieURL, 'hello', [
            'Alice',
          ]);

          await kernel2.stop();
          await kernel3.stop();

          // Send messages to both peers - should trigger simultaneous reconnections
          const bobMessagePromise = kernel1.queueMessage(
            aliceRef,
            'sendRemoteMessage',
            [bobURL, 'hello', ['Alice']],
          );
          const charlieMessagePromise = kernel1.queueMessage(
            aliceRef,
            'sendRemoteMessage',
            [charlieURL, 'hello', ['Alice']],
          );

          // Restart both peers in parallel to fit within the 20 s redemption
          // window. Sequential restarts doubled the wall-clock time.
          const bobConfigRestart = makeRemoteVatConfig('Bob');
          const charlieConfigRestart = makeRemoteVatConfig('Charlie');
          const [restartResult2, restartResult3] = await Promise.all([
            restartKernelAndReloadVat(
              dbFilename2,
              false,
              testRelays,
              bobConfigRestart,
              multiPeerOptions,
            ),
            restartKernelAndReloadVat(
              dbFilename3,
              false,
              testRelays,
              charlieConfigRestart,
              multiPeerOptions,
            ),
          ]);
          kernel2 = restartResult2.kernel;

          kernel3 = restartResult3.kernel;

          // Both messages should be delivered successfully
          const bobResult = await bobMessagePromise;
          const charlieResult = await charlieMessagePromise;

          expect(kunser(bobResult)).toContain('vat Bob got "hello" from Alice');
          expect(kunser(charlieResult)).toContain(
            'vat Charlie got "hello" from Alice',
          );

          const bobFollowUp = await sendRemoteMessage(
            kernel1,
            aliceRef,
            bobURL,
            'hello',
            ['Alice'],
          );
          const charlieFollowUp = await sendRemoteMessage(
            kernel1,
            aliceRef,
            charlieURL,
            'hello',
            ['Alice'],
          );

          expect(bobFollowUp).toContain('vat Bob got "hello" from Alice');
          expect(charlieFollowUp).toContain(
            'vat Charlie got "hello" from Alice',
          );
        } finally {
          if (kernel3) {
            await kernel3.stop();
          }
        }
      },
      NETWORK_TIMEOUT * 4,
    );
  });

  describe('Intentional Disconnect', () => {
    it(
      'explicitly closes connection and prevents automatic reconnection',
      async () => {
        const { aliceRef, bobURL, peerId2 } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        const initialMessage = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(initialMessage).toContain('vat Bob got "hello" from Alice');

        await kernel1.closeConnection(peerId2);
        await kernel2.stop();

        const messageAfterClose = kernel1.queueMessage(
          aliceRef,
          'sendRemoteMessage',
          [bobURL, 'hello', ['Alice']],
        );

        const bobConfig = makeRemoteVatConfig('Bob');
        const restartResult = await restartKernelAndReloadVat(
          dbFilename2,
          false,
          testRelays,
          bobConfig,
          testBackoffOptions,
        );
        kernel2 = restartResult.kernel;

        // The message should not have been delivered because we didn't reconnect
        await expect(messageAfterClose).rejects.toThrow(
          'Message delivery failed after intentional close',
        );
      },
      NETWORK_TIMEOUT * 2,
    );

    it(
      'manually reconnects after intentional close',
      async () => {
        const { aliceRef, bobURL, peerId2 } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        const initialMessage = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(initialMessage).toContain('vat Bob got "hello" from Alice');

        await kernel1.closeConnection(peerId2);
        await kernel2.stop();
        await kernel1.reconnectPeer(peerId2);

        const bobConfig = makeRemoteVatConfig('Bob');
        const restartResult = await restartKernelAndReloadVat(
          dbFilename2,
          false,
          testRelays,
          bobConfig,
          testBackoffOptions,
        );
        kernel2 = restartResult.kernel;

        const messageAfterReconnect = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(messageAfterReconnect).toContain(
          'vat Bob got "hello" from Alice',
        );
      },
      NETWORK_TIMEOUT * 2,
    );

    it(
      'handles remote intentional disconnect without reconnecting',
      async () => {
        const { aliceRef, bobURL, peerId2 } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        const initialMessage = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(initialMessage).toContain('vat Bob got "hello" from Alice');

        // Close connection from kernel1 side
        await kernel1.closeConnection(peerId2);
        await delay(100);

        // Try to send a message after closing - should fail
        await expect(
          kernel1.queueMessage(aliceRef, 'sendRemoteMessage', [
            bobURL,
            'hello',
            ['Alice'],
          ]),
        ).rejects.toThrow('Message delivery failed after intentional close');

        // Manually reconnect
        await kernel1.reconnectPeer(peerId2);
        await delay(200);

        // Send message after manual reconnect - should succeed
        const messageAfterManualReconnect = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(messageAfterManualReconnect).toContain(
          'vat Bob got "hello" from Alice',
        );
      },
      NETWORK_TIMEOUT * 2,
    );
  });

  describe('Incarnation Detection', () => {
    it(
      'detects incarnation change when peer restarts with fresh state',
      async () => {
        // Initialize with low retry attempts to trigger give-up on incarnation change.
        // Use moderate backoff (not the fast test defaults) so reconnection attempts
        // don't exhaust before the restarted peer is reachable.
        await kernel1.initRemoteComms({
          relays: testRelays,
          maxRetryAttempts: 2,
          reconnectionBaseDelayMs: 200,
          reconnectionMaxDelayMs: 500,
          handshakeTimeoutMs: 3_000,
          writeTimeoutMs: 3_000,
        });
        await kernel2.initRemoteComms({
          relays: testRelays,
          reconnectionBaseDelayMs: 200,
          reconnectionMaxDelayMs: 500,
          handshakeTimeoutMs: 3_000,
          writeTimeoutMs: 3_000,
        });

        const aliceConfig = makeRemoteVatConfig('Alice');
        const bobConfig = makeRemoteVatConfig('Bob');

        await launchVatAndGetURL(kernel1, aliceConfig);
        const bobURL = await launchVatAndGetURL(kernel2, bobConfig);
        const aliceRef = getVatRootRef(kernel1, kernelStore1, 'Alice');

        // Establish connection and exchange handshakes
        await sendRemoteMessage(kernel1, aliceRef, bobURL, 'hello', ['Alice']);

        // Stop kernel2 (also closes the database)
        await kernel2.stop();

        // Simulate state loss by creating a fresh database (new incarnation ID, no previous state)
        const freshDb2 = await makeSQLKernelDatabase({
          dbFilename: join(tempDir, 'kernel2-fresh.db'),
        });

        // Create a completely new kernel (new incarnation ID, no previous state)
        const freshKernel2 = await makeTestKernel(freshDb2);
        kernel2 = freshKernel2;
        await kernel2.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });

        // Launch Bob again (fresh vat, no previous state)
        await launchVatAndGetURL(kernel2, bobConfig);

        await expect(
          kernel1.queueMessage(aliceRef, 'sendRemoteMessage', [
            bobURL,
            'hello',
            ['Alice'],
          ]),
        ).rejects.toThrow(/Remote connection lost/u);
      },
      NETWORK_TIMEOUT * 3,
    );

    it(
      'preserves seq dedup when receiver loses peer-incarnation memory',
      async () => {
        // Reproduces issue #944. A peer's incarnationId is held only in the
        // receiver's in-memory PeerStateManager, but RemoteHandle's
        // #highestReceivedSeq is persisted in KV. When PSM loses the entry
        // (e.g. receiver restart, or stale-peer cleanup) and the sender
        // comes back with the same peerId but a fresh incarnation, the
        // handshake mis-classifies the reconnect as a "first connection"
        // (previousIncarnation undefined → setRemoteIncarnation returns
        // false → handlePeerRestart is never called) and the sender's
        // fresh seq=1 messages are silently dropped against the stale
        // persisted dedup state.
        //
        // Fix the sender's libp2p key with a mnemonic so that wiping its
        // storage gives a fresh incarnation and seq counter without also
        // changing the peerId — that's the precondition that exposes the
        // dedup-vs-incarnation lifetime mismatch.
        const k2Mnemonic =
          'legal winner thank year wave sausage worth useful legal winner thank yellow';
        // ackTimeoutMs gates the URL redemption timeout
        // (`ackTimeoutMs * (MAX_RETRIES + 1)`). Keep it generous enough to
        // absorb the cost of fresh K2's libp2p dial + handshake under CI
        // load, otherwise this test becomes flaky on slower runners.
        const opts = {
          relays: testRelays,
          reconnectionBaseDelayMs: 100,
          reconnectionMaxDelayMs: 500,
          handshakeTimeoutMs: 5_000,
          writeTimeoutMs: 5_000,
          ackTimeoutMs: 2_000,
          maxRetryAttempts: 4,
        };

        await kernel1.initRemoteComms({ ...opts });
        await kernel2.initRemoteComms({ ...opts, mnemonic: k2Mnemonic });
        const aliceURL = await launchVatAndGetURL(
          kernel1,
          makeRemoteVatConfig('Alice'),
        );
        await launchVatAndGetURL(kernel2, makeRemoteVatConfig('Bob'));
        const bobRef = getVatRootRef(kernel2, kernelStore2, 'Bob');

        // Bob (K2) sends to Alice (K1) once, advancing K1's persisted
        // #highestReceivedSeq for K2's peer past 0.
        const phase1 = await sendRemoteMessage(
          kernel2,
          bobRef,
          aliceURL,
          'hello',
          ['Bob-before'],
        );
        expect(phase1).toContain('vat Alice got "hello" from Bob-before');

        // Allow K2's standalone ACK to settle before stopping K1, otherwise
        // K1 would persist a stale pending notify and retransmit it on
        // restart — a separate failure mode unrelated to seq dedup. The
        // delayed-ACK timer fires at 50ms.
        await delay(150);

        // Restart the receiver keeping its DB. PeerStateManager rebuilds
        // empty; RemoteHandles are restored from KV with their seq state.
        await stopWithTimeout(async () => kernel1.stop(), 3000, 'kernel1.stop');
        kernel1 = await restartKernel(dbFilename1, false, testRelays, opts);

        // Restart the sender with a FRESH DB but the same mnemonic — same
        // peerId, but fresh incarnationId and a seq counter starting from 0.
        await stopWithTimeout(async () => kernel2.stop(), 3000, 'kernel2.stop');
        const freshDb2 = await makeSQLKernelDatabase({
          dbFilename: join(tempDir, 'kernel2-fresh.db'),
        });
        kernelStore2 = makeKernelStore(freshDb2);
        kernel2 = await makeTestKernel(freshDb2);
        await kernel2.initRemoteComms({ ...opts, mnemonic: k2Mnemonic });
        await launchVatAndGetURL(kernel2, makeRemoteVatConfig('Bob'));
        const newBobRef = getVatRootRef(kernel2, kernelStore2, 'Bob');

        // Fresh K2 sends seq=1 to the same alice URL. K1's PSM has no entry
        // for K2's peer, so setRemoteIncarnation returns false, no reset
        // happens, and K1's persisted #highestReceivedSeq >= 1 silently
        // drops the message. Without the fix this send fails after the URL
        // redemption budget (ackTimeoutMs × (MAX_RETRIES + 1), where
        // MAX_RETRIES is hardcoded to 3 in RemoteHandle.ts) — unrelated to
        // the libp2p `maxRetryAttempts` setting.
        const phase4 = await sendRemoteMessage(
          kernel2,
          newBobRef,
          aliceURL,
          'hello',
          ['Bob-after-restart'],
        );
        expect(phase4).toContain(
          'vat Alice got "hello" from Bob-after-restart',
        );
      },
      NETWORK_TIMEOUT * 3,
    );

    it(
      'detects restart when sender keeps DB but uses resetStorage=true',
      async () => {
        // Companion to the test above. The fresh-DB path naturally regenerates
        // incarnationId (nothing in KV to read). The `resetStorage=true` path
        // wipes the KV but used to be coded with an except-list that preserved
        // incarnationId — so the sender came back signaling the same
        // incarnation, the matcher's handshake said "no restart", and the
        // sender's fresh seq=1 was dropped against persisted dedup state.
        // The browser/extension hits this path on every kernel-worker boot
        // (the offscreen page launches the worker with ?reset-storage=true),
        // so without this regression a plugin reload silently loses messages.
        const k2Mnemonic =
          'legal winner thank year wave sausage worth useful legal winner thank yellow';
        const opts = {
          relays: testRelays,
          reconnectionBaseDelayMs: 100,
          reconnectionMaxDelayMs: 500,
          handshakeTimeoutMs: 5_000,
          writeTimeoutMs: 5_000,
          ackTimeoutMs: 2_000,
          maxRetryAttempts: 4,
        };

        await kernel1.initRemoteComms({ ...opts });
        await kernel2.initRemoteComms({ ...opts, mnemonic: k2Mnemonic });
        const aliceURL = await launchVatAndGetURL(
          kernel1,
          makeRemoteVatConfig('Alice'),
        );
        await launchVatAndGetURL(kernel2, makeRemoteVatConfig('Bob'));
        const bobRef = getVatRootRef(kernel2, kernelStore2, 'Bob');

        const phase1 = await sendRemoteMessage(
          kernel2,
          bobRef,
          aliceURL,
          'hello',
          ['Bob-before-reset'],
        );
        expect(phase1).toContain('vat Alice got "hello" from Bob-before-reset');

        // Same delay rationale as in the fresh-DB test above.
        await delay(150);

        // Restart only the sender, KEEPING its DB but passing
        // resetStorage=true. This is the path the browser kernel-worker
        // takes on every offscreen-page reload. Identity keys (keySeed,
        // peerId, ocapURLKey) must survive so the peer id stays stable;
        // incarnationId must NOT survive so the matcher's handshake can
        // detect the wipe.
        await stopWithTimeout(async () => kernel2.stop(), 3000, 'kernel2.stop');
        kernel2 = await restartKernel(dbFilename2, true, testRelays, opts);
        await launchVatAndGetURL(kernel2, makeRemoteVatConfig('Bob'));
        kernelStore2 = makeKernelStore(
          await makeSQLKernelDatabase({ dbFilename: dbFilename2 }),
        );
        const newBobRef = getVatRootRef(kernel2, kernelStore2, 'Bob');

        const phase2 = await sendRemoteMessage(
          kernel2,
          newBobRef,
          aliceURL,
          'hello',
          ['Bob-after-reset'],
        );
        expect(phase2).toContain('vat Alice got "hello" from Bob-after-reset');
      },
      NETWORK_TIMEOUT * 3,
    );
  });

  describe('Promise Rejection on Remote Give-Up', () => {
    it(
      'rejects promises when remote connection is lost after max retries',
      async () => {
        // Initialize kernel1 with a low maxRetryAttempts to trigger give-up.
        // Use moderate backoff so reconnection attempts don't exhaust before
        // the message can be queued and become a pending promise.
        await kernel1.initRemoteComms({
          relays: testRelays,
          maxRetryAttempts: 3,
          reconnectionBaseDelayMs: 200,
          reconnectionMaxDelayMs: 1_000,
          handshakeTimeoutMs: 3_000,
          writeTimeoutMs: 3_000,
        });
        await kernel2.initRemoteComms({
          relays: testRelays,
          reconnectionBaseDelayMs: 200,
          reconnectionMaxDelayMs: 1_000,
          handshakeTimeoutMs: 3_000,
          writeTimeoutMs: 3_000,
        });

        // Set up Alice and Bob manually (can't use setupAliceAndBob as it reinitializes comms)
        const aliceConfig = makeRemoteVatConfig('Alice');
        const bobConfig = makeRemoteVatConfig('Bob');

        await launchVatAndGetURL(kernel1, aliceConfig);
        const bobURL = await launchVatAndGetURL(kernel2, bobConfig);

        const aliceRef = getVatRootRef(kernel1, kernelStore1, 'Alice');

        // Establish connection first by sending a successful message
        await sendRemoteMessage(kernel1, aliceRef, bobURL, 'hello', ['Alice']);

        // Now stop kernel2 to trigger connection loss
        await kernel2.stop();

        // Send a message immediately - it will be queued while reconnection is attempted.
        // With maxRetryAttempts: 3, the reconnection will give up and reject
        // all pending promises including this message.
        await expect(
          kernel1.queueMessage(aliceRef, 'sendRemoteMessage', [
            bobURL,
            'hello',
            ['Alice'],
          ]),
        ).rejects.toThrow('Remote connection lost');
      },
      NETWORK_TIMEOUT * 2,
    );

    it(
      'resolves promise after reconnection when retries have not been exhausted',
      async () => {
        // Use a longer ACK timeout so the RemoteHandle doesn't give up before
        // kernel2 can restart and reconnect (give-up = ackTimeoutMs × 4).
        const reconnectOptions = {
          ...testBackoffOptions,
          ackTimeoutMs: 5_000,
        };

        const { aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          reconnectOptions,
        );

        // Establish the connection and complete URL redemption first so that
        // the subsequent message doesn't race URL redemption against kernel2.stop().
        await sendRemoteMessage(kernel1, aliceRef, bobURL, 'hello', ['Alice']);

        // Stop kernel2 so the next message is guaranteed to be pending
        await kernel2.stop();

        // Send a message while kernel2 is down - it will be queued
        const messagePromise = kernel1.queueMessage(
          aliceRef,
          'sendRemoteMessage',
          [bobURL, 'hello', ['Alice']],
        );

        // Restart kernel2 (before max retries, since default is infinite)
        // The promise should remain unresolved and resolve normally after reconnection
        const bobConfig = makeRemoteVatConfig('Bob');
        const restartResult = await restartKernelAndReloadVat(
          dbFilename2,
          false,
          testRelays,
          bobConfig,
          reconnectOptions,
        );
        kernel2 = restartResult.kernel;

        // The message should eventually be delivered and resolved
        // The promise was never rejected because retries weren't exhausted
        const result = await messagePromise;
        expect(kunser(result)).toContain('vat Bob got "hello" from Alice');
      },
      NETWORK_TIMEOUT * 3,
    );
  });

  describe('Revocation', () => {
    it(
      'blocks remote invocation after revocation and leaves other objects unaffected',
      async () => {
        await kernel1.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });
        await kernel2.initRemoteComms({
          relays: testRelays,
          ...testBackoffOptions,
        });

        // step 1: kernel A exports a revocable target and an unrelated bystander
        const targetURL = await launchVatAndGetURL(
          kernel1,
          makeRemoteVatConfig('Target'),
        );
        const bystanderURL = await launchVatAndGetURL(
          kernel1,
          makeRemoteVatConfig('Bystander'),
        );

        // kernel B: a vat that can invoke remote objects via URL
        await launchVatAndGetURL(kernel2, makeRemoteVatConfig('Sender'));
        const senderRef = getVatRootRef(kernel2, kernelStore2, 'Sender');

        // step 2: B can invoke the target before revocation
        const beforeResult = await sendRemoteMessage(
          kernel2,
          senderRef,
          targetURL,
          'ping',
          [],
        );
        expect(beforeResult).toBe('pong from Target');

        // step 3: revoke the target on A through the public API
        const targetKRef = getVatRootRef(kernel1, kernelStore1, 'Target');
        kernel1.revoke(targetKRef);

        // step 4: B's next invocation fails
        await expect(
          kernel2.queueMessage(senderRef, 'sendRemoteMessage', [
            targetURL,
            'ping',
            [],
          ]),
        ).rejects.toThrow('OBJECT_REVOKED');

        // step 5: the bystander and B's other references are unaffected
        const bystanderResult = await sendRemoteMessage(
          kernel2,
          senderRef,
          bystanderURL,
          'ping',
          [],
        );
        expect(bystanderResult).toBe('pong from Bystander');
      },
      NETWORK_TIMEOUT,
    );
  });

  describe('Distributed Garbage Collection', () => {
    it(
      'creates remote endpoint with clist entries after cross-kernel message',
      async () => {
        const { aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        // Send a message to create cross-kernel object references
        const response = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );

        // Verify cross-kernel communication works (implies remote endpoints were created)
        expect(response).toContain('vat Bob got "hello" from Alice');
      },
      NETWORK_TIMEOUT,
    );

    it(
      'sends BOYD to remote kernel when local remote is reaped',
      async () => {
        const { aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        // Send a message to create cross-kernel refs
        await sendRemoteMessage(kernel1, aliceRef, bobURL, 'hello', ['Alice']);

        // Schedule reap on kernel1's remote endpoints - this will cause
        // the crank loop to deliver BOYD to the remote kernel
        kernel1.reapRemotes();

        // Trigger cranks to process the reap action (which sends BOYD to kernel2)
        // and allow the remote to process it and respond
        for (let i = 0; i < 3; i++) {
          await kernel1.queueMessage(aliceRef, 'ping', []);
          await waitUntilQuiescent(100);
        }

        // Verify communication still works after DGC
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

    it(
      'processes incoming BOYD by scheduling local reap',
      async () => {
        const { bobRef, aliceURL, aliceRef, bobURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        // Send messages in both directions to create refs on both sides
        await sendRemoteMessage(kernel1, aliceRef, bobURL, 'hello', ['Alice']);
        await sendRemoteMessage(kernel2, bobRef, aliceURL, 'hello', ['Bob']);

        // Schedule reap on kernel2's remote endpoints - this will send BOYD to kernel1
        kernel2.reapRemotes();

        // Trigger cranks to process the reap and allow BOYD to flow
        for (let i = 0; i < 3; i++) {
          await kernel2.queueMessage(bobRef, 'ping', []);
          await waitUntilQuiescent(100);
        }

        // Verify communication still works after DGC from both directions
        const aliceToBob = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(aliceToBob).toContain('vat Bob got "hello" from Alice');

        const bobToAlice = await sendRemoteMessage(
          kernel2,
          bobRef,
          aliceURL,
          'hello',
          ['Bob'],
        );
        expect(bobToAlice).toContain('vat Alice got "hello" from Bob');
      },
      NETWORK_TIMEOUT,
    );

    it(
      'completes BOYD exchange without infinite ping-pong',
      async () => {
        const { aliceRef, bobRef, bobURL, aliceURL } = await setupAliceAndBob(
          kernel1,
          kernel2,
          kernelStore1,
          kernelStore2,
          testRelays,
          testBackoffOptions,
        );

        // Send messages to establish refs on both sides
        await sendRemoteMessage(kernel1, aliceRef, bobURL, 'hello', ['Alice']);
        await sendRemoteMessage(kernel2, bobRef, aliceURL, 'hello', ['Bob']);

        // Schedule reap on BOTH sides simultaneously - this tests that the
        // ping-pong prevention flag works correctly, preventing infinite BOYD loops
        kernel1.reapRemotes();
        kernel2.reapRemotes();

        // Trigger cranks on both kernels to process the reaps and allow
        // BOYD messages to flow in both directions
        for (let i = 0; i < 3; i++) {
          await Promise.all([
            kernel1.queueMessage(aliceRef, 'ping', []),
            kernel2.queueMessage(bobRef, 'ping', []),
          ]);
          await waitUntilQuiescent(100);
        }

        // Verify continued bidirectional communication works - this proves
        // the BOYD exchange completed without breaking the connection
        const aliceToBob = await sendRemoteMessage(
          kernel1,
          aliceRef,
          bobURL,
          'hello',
          ['Alice'],
        );
        expect(aliceToBob).toContain('vat Bob got "hello" from Alice');

        const bobToAlice = await sendRemoteMessage(
          kernel2,
          bobRef,
          aliceURL,
          'hello',
          ['Bob'],
        );
        expect(bobToAlice).toContain('vat Alice got "hello" from Bob');
      },
      NETWORK_TIMEOUT,
    );
  });
});
