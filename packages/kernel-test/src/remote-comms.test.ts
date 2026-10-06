import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { fromHex } from '@metamask/kernel-utils';
import { makeKernelStore, kunser, Kernel } from '@metamask/ocap-kernel';
import type {
  KernelStore,
  ClusterConfig,
  KRef,
  PlatformServices,
  RemoteMessageHandler,
  RemoteCommsOptions,
} from '@metamask/ocap-kernel';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  makeTestLogger,
  getBundleSpec,
  runTestVats,
  makeKernel,
} from './utils.ts';

/**
 * Create a direct network platform services that bypasses libp2p for local testing.
 * This creates a simple in-memory message router between kernels.
 */
class DirectNetworkService {
  peerRegistry = new Map<string, RemoteMessageHandler>();

  peerAddresses = new Map<string, string>();

  /**
   * Register a peer with its handler and address.
   *
   * @param peerId - The peer ID to register.
   * @param handler - The handler to register.
   * @param address - The address to register.
   */
  registerPeer(
    peerId: string,
    handler: RemoteMessageHandler,
    address: string,
  ): void {
    this.peerRegistry.set(peerId, handler);
    this.peerAddresses.set(peerId, address);
  }

  /**
   * Create platform services that route messages directly between registered peers.
   *
   * @param tempPeerId - The temporary peer ID used during initialization.
   * @returns The platform services.
   */
  createPlatformServices(tempPeerId: string): PlatformServices {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    // Store the actual peer ID once we know it
    let actualPeerId: string | undefined;
    const realServices = new NodejsPlatformServices({
      logger: makeTestLogger().logger,
    });

    return {
      async launch(vatId) {
        return realServices.launch(vatId);
      },

      async terminate(vatId) {
        return realServices.terminate(vatId);
      },

      async terminateAll() {
        return realServices.terminateAll();
      },

      async sendRemoteMessage(to: string, message: string) {
        const fromPeer = actualPeerId ?? tempPeerId;
        // Route message directly to the target peer's handler
        const targetHandler = self.peerRegistry.get(to);
        if (targetHandler) {
          // Message is already serialized by RemoteHandle
          const response = await targetHandler(fromPeer, message);
          // If there's a response, send it back
          if (response) {
            const senderHandler = self.peerRegistry.get(fromPeer);
            if (senderHandler) {
              await senderHandler(to, response);
            }
          }
        } else {
          throw new Error(`No handler registered for peer ${to}`);
        }
      },

      async initializeRemoteComms(
        keySeed: string,
        _options: RemoteCommsOptions,
        handler: RemoteMessageHandler,
      ) {
        // Generate the actual peer ID from the key seed
        const keyPair = await generateKeyPairFromSeed(
          'Ed25519',
          fromHex(keySeed),
        );
        actualPeerId = peerIdFromPrivateKey(keyPair).toString();

        // Register this peer in the direct network with its actual ID
        self.registerPeer(actualPeerId, handler, 'direct://localhost');
        console.log(`Registered peer ${actualPeerId} for direct messaging`);
        return Promise.resolve();
      },

      async stopRemoteComms() {
        // Unregister this peer from the direct network
        if (actualPeerId) {
          self.peerRegistry.delete(actualPeerId);
          self.peerAddresses.delete(actualPeerId);
          console.log(
            `Unregistered peer ${actualPeerId} from direct messaging`,
          );
        }
        return Promise.resolve();
      },

      async closeConnection(_peerId: string) {
        // Mock implementation - in direct network, connections are always available
        return Promise.resolve();
      },

      async registerLocationHints(_peerId: string, _hints: string[]) {
        return Promise.resolve();
      },

      async reconnectPeer(_peerId: string, _hints: string[] = []) {
        // Mock implementation - in direct network, connections are always available
        return Promise.resolve();
      },

      getListenAddresses() {
        return [];
      },
    };
  }
}

// Type definitions for test result objects
type BootstrapResult = {
  message: string;
  ocapURL: string;
};

/**
 * Create a test subcluster configuration for remote sender vat.
 *
 * @param name - The name of the sender vat.
 * @returns Cluster configuration for the sender.
 */
function makeSenderSubclusterConfig(name: string): ClusterConfig {
  return {
    bootstrap: 'sender',
    forceReset: true,
    services: ['ocapURLIssuerService', 'ocapURLRedemptionService'],
    vats: {
      sender: {
        bundleSpec: getBundleSpec('remote-sender-vat'),
        parameters: {
          name,
        },
      },
      receiver: {
        bundleSpec: getBundleSpec('remote-receiver-vat'),
        parameters: {
          name: `${name}LocalReceiver`,
        },
      },
    },
  };
}

/**
 * Create a test subcluster configuration for remote receiver vat.
 *
 * @param name - The name of the receiver vat.
 * @returns Cluster configuration for the receiver.
 */
function makeReceiverSubclusterConfig(name: string): ClusterConfig {
  return {
    bootstrap: 'receiver',
    forceReset: true,
    services: ['ocapURLIssuerService', 'ocapURLRedemptionService'],
    vats: {
      receiver: {
        bundleSpec: getBundleSpec('remote-receiver-vat'),
        parameters: {
          name,
        },
      },
    },
  };
}

/**
 * Create a kernel instance for testing.
 *
 * @param tag - Tag string for logging and generating initial peer ID.
 * @param kernelDatabase - The kernel database instance to use.
 * @param directNetwork - Network platform services for testing.
 * @param resetStorage - If true (the default), reset kernel storage on start;
 *  if false, leave persistent state as is.
 * @param peerId - Optional peer ID to use.
 * @param keySeed - Optional seed for libp2p key generation.
 *
 * @returns a promise for the kernel that was created.
 */
async function makeTestKernel(
  tag: string,
  kernelDatabase: KernelDatabase,
  directNetwork: DirectNetworkService,
  resetStorage: boolean = true,
  peerId: string = `${tag}-peer`,
  keySeed?: string,
): Promise<Kernel> {
  const logger = makeTestLogger().logger.subLogger({ tags: [tag] });
  const platformServices = directNetwork.createPlatformServices(peerId);

  const kernel = await makeKernel(
    kernelDatabase,
    resetStorage,
    logger,
    undefined,
    platformServices,
    keySeed,
  );
  await kernel.initRemoteComms();
  return kernel;
}

describe('Remote Communications (Integration Tests)', () => {
  let kernel1: Kernel;
  let kernel2: Kernel;
  let kernelDatabase1: KernelDatabase;
  let kernelDatabase2: KernelDatabase;
  let kernelStore1: KernelStore;
  let directNetwork: DirectNetworkService;

  beforeEach(async () => {
    // Create direct network service for deterministic testing
    directNetwork = new DirectNetworkService();

    // Create two independent kernels with separate in-memory databases
    kernelDatabase1 = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    kernelStore1 = makeKernelStore(kernelDatabase1);
    kernelDatabase2 = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });

    kernel1 = await makeTestKernel(
      'kernel1',
      kernelDatabase1,
      directNetwork,
      true,
      'kernel1-peer',
      '01',
    );
    kernel2 = await makeTestKernel(
      'kernel2',
      kernelDatabase2,
      directNetwork,
      true,
      'kernel2-peer',
      '02',
    );
  });

  it('should initialize remote communications without errors', async () => {
    const status1 = await kernel1.getStatus();
    const status2 = await kernel2.getStatus();
    expect(status1).toBeDefined();
    expect(status2).toBeDefined();
    expect(status1.vats).toStrictEqual([]);
    expect(status2.vats).toStrictEqual([]);
    expect(status1.remoteComms).toBeDefined();
    expect(status2.remoteComms).toBeDefined();
    expect(status1.remoteComms).toStrictEqual({
      state: 'connected',
      peerId: expect.any(String),
      listenAddresses: [],
    });
    expect(status2.remoteComms).toStrictEqual({
      state: 'connected',
      peerId: expect.any(String),
      listenAddresses: [],
    });
    // Each kernel should have a unique peer ID
    const peerId1 =
      status1.remoteComms?.state === 'connected'
        ? status1.remoteComms.peerId
        : undefined;
    const peerId2 =
      status2.remoteComms?.state === 'connected'
        ? status2.remoteComms.peerId
        : undefined;
    expect(peerId1).not.toBe(peerId2);
  });

  it('should create vats with ocap URL services', async () => {
    // Launch sender vat on kernel1
    const senderConfig = makeSenderSubclusterConfig('Sender1');
    const senderResult = await runTestVats(kernel1, senderConfig);

    expect(senderResult).toBeDefined();
    expect(senderResult).toHaveProperty('message');
    expect(senderResult).toHaveProperty('ocapURL');

    // Launch receiver vat on kernel2
    const receiverConfig = makeReceiverSubclusterConfig('Receiver2');
    const receiverResult = await runTestVats(kernel2, receiverConfig);

    expect(receiverResult).toBeDefined();
    expect(receiverResult).toHaveProperty('message');
    expect(receiverResult).toHaveProperty('ocapURL');

    // Verify both have issued ocap URLs
    const senderBootstrap = senderResult as BootstrapResult;
    const receiverBootstrap = receiverResult as BootstrapResult;
    expect(typeof senderBootstrap.ocapURL).toBe('string');
    expect(typeof receiverBootstrap.ocapURL).toBe('string');
    expect(senderBootstrap.ocapURL).toMatch(/^ocap:/u);
    expect(receiverBootstrap.ocapURL).toMatch(/^ocap:/u);
  });

  it('should send remote message between kernels via ocap URLs', async () => {
    // Launch sender vat on kernel1
    const senderConfig = makeSenderSubclusterConfig('Sender1');
    await runTestVats(kernel1, senderConfig);
    const senderRootRef = kernelStore1.getRootObject('v1') as KRef;

    // Launch receiver vat on kernel2
    const receiverConfig = makeReceiverSubclusterConfig('Receiver2');
    const receiverResult = await runTestVats(kernel2, receiverConfig);

    // Get the receiver's ocap URL from bootstrap result
    const receiverBootstrap = receiverResult as BootstrapResult;
    const receiverURL = receiverBootstrap.ocapURL;

    expect(typeof receiverURL).toBe('string');
    expect(receiverURL).toMatch(/^ocap:/u);

    // Send a remote message from kernel1 to kernel2 using the ocap URL
    const remoteCallResult = await kernel1.queueMessage(
      senderRootRef,
      'sendMessage',
      [receiverURL, 'hello', ['RemoteSender from Kernel1']],
    );

    const response = kunser(remoteCallResult);
    expect(response).toBeDefined();
    expect(response).toContain('says hello back to');
  });

  it('revokes a cross-kernel object held by a remote peer', async () => {
    // step 1: kernel A exports a revocable target and an unrelated bystander
    const { targetURL, bystanderURL } = (await runTestVats(kernel1, {
      bootstrap: 'target',
      forceReset: true,
      services: ['ocapURLIssuerService'],
      vats: {
        target: {
          bundleSpec: getBundleSpec('revocation-target-vat'),
          parameters: { name: 'Target' },
        },
      },
    })) as { targetURL: string; bystanderURL: string };

    // Obtain the kernel-level KRef so we can later revoke it via the public API
    const targetRootRef = kernelStore1.getRootObject('v1') as KRef;
    const targetCapdata = await kernel1.queueMessage(
      targetRootRef,
      'getTarget',
      [],
    );
    const targetKRef = targetCapdata.slots[0] as KRef;

    // kernel B: set up a vat that can invoke objects via ocap URL redemption
    const kernelStore2 = makeKernelStore(kernelDatabase2);
    await runTestVats(kernel2, {
      bootstrap: 'sender',
      forceReset: true,
      services: ['ocapURLRedemptionService'],
      vats: {
        sender: {
          bundleSpec: getBundleSpec('remote-sender-vat'),
          parameters: { name: 'Sender' },
        },
      },
    });
    const senderRootRef = kernelStore2.getRootObject('v1') as KRef;

    // step 2: B can invoke the target before revocation
    const beforeResult = await kernel2.queueMessage(
      senderRootRef,
      'sendMessage',
      [targetURL, 'ping', []],
    );
    expect(kunser(beforeResult)).toContain('pong from Target target');

    // step 3: revoke the target on A through the public API
    kernel1.revoke(targetKRef);

    // step 4: B's next invocation fails
    await expect(
      kernel2.queueMessage(senderRootRef, 'sendMessage', [
        targetURL,
        'ping',
        [],
      ]),
    ).rejects.toThrow('OBJECT_REVOKED');

    // step 5: the bystander object, and B's other references, are unaffected
    const bystanderResult = await kernel2.queueMessage(
      senderRootRef,
      'sendMessage',
      [bystanderURL, 'ping', []],
    );
    expect(kunser(bystanderResult)).toContain('pong from Target bystander');
  });

  it('remote relationships should survive kernel restart', async () => {
    // This test needs file-based databases for persistence across stop/restart.
    // Stop the beforeEach kernels and replace them with file-backed ones.
    const tempDir = await mkdtemp(join(tmpdir(), 'kernel-test-rc-'));
    const dbFile1 = join(tempDir, 'k1.db');
    const dbFile2 = join(tempDir, 'k2.db');
    try {
      await Promise.all([kernel1.stop(), kernel2.stop()]);

      const initDb1 = await makeSQLKernelDatabase({ dbFilename: dbFile1 });
      const localKernelStore1 = makeKernelStore(initDb1);
      let clientKernel = await makeTestKernel(
        'kernel1',
        initDb1,
        directNetwork,
        true,
        'kernel1-peer',
        '01',
      );

      const initDb2 = await makeSQLKernelDatabase({ dbFilename: dbFile2 });
      let serverKernel = await makeTestKernel(
        'kernel2',
        initDb2,
        directNetwork,
        true,
        'kernel2-peer',
        '02',
      );

      // Launch client vat on kernel1
      const clientConfig = makeMaasClientConfig('client1', true);
      await runTestVats(clientKernel, clientConfig);
      const clientRootRef = localKernelStore1.getRootObject('v1') as KRef;

      // Launch server vat on kernel2
      const serverConfig = makeMaasServerConfig('server2', true);
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

      // Kill the server and restart it with a fresh db connection
      await serverKernel.stop();
      serverKernel = await makeTestKernel(
        'kernel2b',
        await makeSQLKernelDatabase({ dbFilename: dbFile2 }),
        directNetwork,
        false,
        'kernel2-peer',
        '02',
      );

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

      // Kill the client and restart it with a fresh db connection
      await clientKernel.stop();
      clientKernel = await makeTestKernel(
        'kernel1b',
        await makeSQLKernelDatabase({ dbFilename: dbFile1 }),
        directNetwork,
        false,
        'kernel1-peer',
        '01',
      );

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

      // Stop the local kernels before the temp dir is cleaned up
      await Promise.all([clientKernel.stop(), serverKernel.stop()]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * Create a test subcluster configuration for a MaaS server vat.
 *
 * @param name - The name of the vat.
 * @param forceReset - True if cluster should reset on start
 * @returns Cluster configuration to run a MaaS server.
 */
function makeMaasServerConfig(
  name: string,
  forceReset: boolean,
): ClusterConfig {
  return {
    bootstrap: 'maasServer',
    forceReset,
    services: ['ocapURLIssuerService'],
    vats: {
      maasServer: {
        bundleSpec: getBundleSpec('monotonous-vat'),
        parameters: {
          name,
        },
      },
    },
  };
}

/**
 * Create a test subcluster configuration for a MaaS client vat.
 *
 * @param name - The name of the vat.
 * @param forceReset - True if cluster should reset on start
 * @returns Cluster configuration to run a MaaS client.
 */
function makeMaasClientConfig(
  name: string,
  forceReset: boolean,
): ClusterConfig {
  return {
    bootstrap: 'maasClient',
    forceReset,
    services: ['ocapURLRedemptionService'],
    vats: {
      maasClient: {
        bundleSpec: getBundleSpec('stepper-upper-vat'),
        parameters: {
          name,
        },
      },
    },
  };
}
