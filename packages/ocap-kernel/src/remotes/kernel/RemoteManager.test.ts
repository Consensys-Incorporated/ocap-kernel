import { delay } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import * as remoteComms from './remote-comms.ts';
import { RemoteHandle } from './RemoteHandle.ts';
import { RemoteManager } from './RemoteManager.ts';
import { asRRef, asRemoteId } from '../../../test/branded.ts';
import { createMockRemotesFactory } from '../../../test/remotes-mocks.ts';
import { makeMapKernelDatabase } from '../../../test/storage.ts';
import type { KernelQueue } from '../../KernelQueue.ts';
import { makeKernelStore } from '../../store/index.ts';
import type { CrankResult, PlatformServices } from '../../types.ts';
import type { RemoteComms } from '../types.ts';

vi.mock('./remote-comms.ts', async () => {
  const actual = await vi.importActual('./remote-comms.ts');
  return {
    ...actual,
    initRemoteComms: vi.fn(),
    initRemoteIdentity: vi.fn(),
  };
});

const remoteFor = async (
  manager: RemoteManager,
  peerId: string,
  hints: string[] = [],
): Promise<RemoteHandle> =>
  manager.withRemote(peerId, { hints, use: (remote) => remote });

const peerMessage = (seq: number): string =>
  JSON.stringify({ seq, method: 'deliver', params: ['bringOutYourDead'] });

describe('RemoteManager', () => {
  let remoteManager: RemoteManager;
  let mockPlatformServices: PlatformServices;
  let kernelDatabase: ReturnType<typeof makeMapKernelDatabase>;
  let kernelStore: ReturnType<typeof makeKernelStore>;
  let mockKernelQueue: KernelQueue;
  let logger: Logger;
  let mockRemoteComms: RemoteComms;
  let mockFactory: ReturnType<typeof createMockRemotesFactory>;

  beforeEach(() => {
    kernelDatabase = makeMapKernelDatabase();
    kernelStore = makeKernelStore(kernelDatabase);
    logger = new Logger('test');

    mockFactory = createMockRemotesFactory({
      peerId: 'test-peer-id',
      kernelStore,
    });

    const mocks = mockFactory.makeRemoteManagerMocks();
    mockPlatformServices = mocks.platformServices;
    mockKernelQueue = mocks.kernelQueue;
    mockRemoteComms = mocks.remoteComms;

    remoteManager = new RemoteManager({
      platformServices: mockPlatformServices,
      kernelStore,
      kernelQueue: mockKernelQueue,
      logger,
    });

    vi.mocked(remoteComms.initRemoteComms).mockClear();
    vi.mocked(remoteComms.initRemoteIdentity).mockClear();
  });

  describe('identity initialization', () => {
    it('initializes identity without message handler', async () => {
      const mockIdentity = {
        getPeerId: vi.fn().mockReturnValue('identity-peer-id'),
        issueOcapURL: vi.fn(),
        redeemLocalOcapURL: vi.fn(),
        addKnownRelays: vi.fn(),
      };
      vi.mocked(remoteComms.initRemoteIdentity).mockResolvedValue({
        identity: mockIdentity,
        keySeed: 'test-key-seed',
        knownRelays: [],
      });

      // No message handler set - should still work
      await remoteManager.initIdentity();

      expect(remoteComms.initRemoteIdentity).toHaveBeenCalledWith(
        kernelStore,
        { mnemonic: undefined },
        logger,
        undefined,
      );
    });

    it('reports isIdentityInitialized correctly', async () => {
      expect(remoteManager.isIdentityInitialized()).toBe(false);

      const mockIdentity = {
        getPeerId: vi.fn().mockReturnValue('identity-peer-id'),
        issueOcapURL: vi.fn(),
        redeemLocalOcapURL: vi.fn(),
        addKnownRelays: vi.fn(),
      };
      vi.mocked(remoteComms.initRemoteIdentity).mockResolvedValue({
        identity: mockIdentity,
        keySeed: 'test-key-seed',
        knownRelays: [],
      });

      await remoteManager.initIdentity();
      expect(remoteManager.isIdentityInitialized()).toBe(true);
    });

    it('getRemoteIdentity works after initIdentity', async () => {
      const mockIdentity = {
        getPeerId: vi.fn().mockReturnValue('identity-peer-id'),
        issueOcapURL: vi.fn(),
        redeemLocalOcapURL: vi.fn(),
        addKnownRelays: vi.fn(),
      };
      vi.mocked(remoteComms.initRemoteIdentity).mockResolvedValue({
        identity: mockIdentity,
        keySeed: 'test-key-seed',
        knownRelays: [],
      });

      await remoteManager.initIdentity();
      const identity = remoteManager.getRemoteIdentity();
      expect(identity.getPeerId()).toBe('identity-peer-id');
    });

    it('getRemoteIdentity works after initRemoteComms (returns comms)', async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);

      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();

      const identity = remoteManager.getRemoteIdentity();
      expect(identity).toBe(mockRemoteComms);
    });

    it('getRemoteIdentity throws when nothing initialized', () => {
      expect(() => remoteManager.getRemoteIdentity()).toThrow(
        'Remote identity not initialized',
      );
    });

    it('cleanup clears identity', async () => {
      const mockIdentity = {
        getPeerId: vi.fn().mockReturnValue('identity-peer-id'),
        issueOcapURL: vi.fn(),
        redeemLocalOcapURL: vi.fn(),
        addKnownRelays: vi.fn(),
      };
      vi.mocked(remoteComms.initRemoteIdentity).mockResolvedValue({
        identity: mockIdentity,
        keySeed: 'test-key-seed',
        knownRelays: [],
      });

      await remoteManager.initIdentity();
      expect(remoteManager.isIdentityInitialized()).toBe(true);

      remoteManager.cleanup();
      expect(remoteManager.isIdentityInitialized()).toBe(false);
    });

    it('getPeerId works with identity-only', async () => {
      const mockIdentity = {
        getPeerId: vi.fn().mockReturnValue('identity-peer-id'),
        issueOcapURL: vi.fn(),
        redeemLocalOcapURL: vi.fn(),
        addKnownRelays: vi.fn(),
      };
      vi.mocked(remoteComms.initRemoteIdentity).mockResolvedValue({
        identity: mockIdentity,
        keySeed: 'test-key-seed',
        knownRelays: [],
      });

      await remoteManager.initIdentity();
      expect(remoteManager.getPeerId()).toBe('identity-peer-id');
    });

    it('passes mnemonic from constructor', async () => {
      const managerWithMnemonic = new RemoteManager({
        platformServices: mockPlatformServices,
        kernelStore,
        kernelQueue: mockKernelQueue,
        logger,
        mnemonic: 'test mnemonic phrase',
      });

      const mockIdentity = {
        getPeerId: vi.fn().mockReturnValue('mnemonic-peer-id'),
        issueOcapURL: vi.fn(),
        redeemLocalOcapURL: vi.fn(),
        addKnownRelays: vi.fn(),
      };
      vi.mocked(remoteComms.initRemoteIdentity).mockResolvedValue({
        identity: mockIdentity,
        keySeed: 'mnemonic-key-seed',
        knownRelays: [],
      });

      await managerWithMnemonic.initIdentity();

      expect(remoteComms.initRemoteIdentity).toHaveBeenCalledWith(
        kernelStore,
        { mnemonic: 'test mnemonic phrase' },
        expect.any(Object),
        undefined,
      );
    });
  });

  describe('initialization', () => {
    it('throws error if remote comms is accessed before initialization', () => {
      expect(() => remoteManager.getRemoteComms()).toThrow(
        'Remote comms not initialized',
      );
    });

    it('throws error if initRemoteComms is called without message handler', async () => {
      await expect(remoteManager.initRemoteComms()).rejects.toThrow(
        'Message handler must be set before initializing remote comms',
      );
    });

    it('initializes remote comms after setting message handler', async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);

      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms({ relays: ['relay1', 'relay2'] });

      expect(remoteComms.initRemoteComms).toHaveBeenCalledWith(
        kernelStore,
        mockPlatformServices,
        messageHandler,
        { relays: ['relay1', 'relay2'] },
        logger,
        undefined,
        expect.any(Function),
        kernelStore.provideIncarnationId(),
        expect.any(Function), // onIncarnationChange
      );
    });

    it('initializes remote comms with all options', async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);

      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms({
        relays: ['relay1', 'relay2'],
        maxRetryAttempts: 5,
        maxQueue: 100,
      });

      expect(remoteComms.initRemoteComms).toHaveBeenCalledWith(
        kernelStore,
        mockPlatformServices,
        messageHandler,
        {
          relays: ['relay1', 'relay2'],
          maxRetryAttempts: 5,
          maxQueue: 100,
          mnemonic: undefined,
        },
        logger,
        undefined,
        expect.any(Function),
        kernelStore.provideIncarnationId(),
        expect.any(Function), // onIncarnationChange
      );
    });

    it('passes keySeed to initRemoteComms', async () => {
      const keySeed = '0x1234567890abcdef';
      const managerWithKeySeed = new RemoteManager({
        platformServices: mockPlatformServices,
        kernelStore,
        kernelQueue: mockKernelQueue,
        logger,
        keySeed,
      });

      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);

      managerWithKeySeed.setMessageHandler(messageHandler);
      await managerWithKeySeed.initRemoteComms();

      expect(remoteComms.initRemoteComms).toHaveBeenCalledWith(
        kernelStore,
        mockPlatformServices,
        messageHandler,
        {},
        logger,
        keySeed,
        expect.any(Function),
        kernelStore.provideIncarnationId(),
        expect.any(Function), // onIncarnationChange
      );
    });

    it('correctly reports remote comms initialization status', async () => {
      expect(remoteManager.isRemoteCommsInitialized()).toBe(false);

      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);

      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();

      expect(remoteManager.isRemoteCommsInitialized()).toBe(true);
    });

    it('restores previously established remotes from kernel store', async () => {
      // First establish some remotes and store them
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);
      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();

      const remote1 = remoteManager.establishRemote('peer-1', ['relay-1']);
      const remote2 = remoteManager.establishRemote('peer-2', ['relay-2']);
      const remote1Id = remote1.remoteId;
      const remote2Id = remote2.remoteId;

      // Stop remote comms (simulating shutdown)
      await mockPlatformServices.stopRemoteComms();
      remoteManager.cleanup();

      // Create a new RemoteManager instance (simulating restart)
      const newRemoteManager = new RemoteManager({
        platformServices: mockPlatformServices,
        kernelStore, // Same store with persisted remotes
        kernelQueue: mockKernelQueue,
        logger,
      });

      // Initialize - should restore the remotes
      newRemoteManager.setMessageHandler(messageHandler);
      await newRemoteManager.initRemoteComms();

      // Verify remotes were restored
      const restoredRemote1 = newRemoteManager.getRemote(remote1Id);
      const restoredRemote2 = newRemoteManager.getRemote(remote2Id);

      expect(restoredRemote1).toBeDefined();
      expect(restoredRemote2).toBeDefined();
      expect(restoredRemote1.remoteId).toBe(remote1Id);
      expect(restoredRemote2.remoteId).toBe(remote2Id);

      // Verify remotes are also accessible by peer ID
      expect(await remoteFor(newRemoteManager, 'peer-1')).toBe(restoredRemote1);
      expect(await remoteFor(newRemoteManager, 'peer-2')).toBe(restoredRemote2);
    });

    it('handles empty kernel store during initialization', async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);

      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();

      // Should initialize successfully with no remotes
      expect(remoteManager.isRemoteCommsInitialized()).toBe(true);
    });
  });

  describe('remote comms operations', () => {
    beforeEach(async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);
      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();
    });

    it('gets peer ID from remote comms', () => {
      const peerId = remoteManager.getPeerId();
      expect(peerId).toBe('test-peer-id');
      expect(mockRemoteComms.getPeerId).toHaveBeenCalled();
    });

    it('closes connection to peer', async () => {
      await remoteManager.closeConnection('peer123');
      expect(mockPlatformServices.closeConnection).toHaveBeenCalledWith(
        'peer123',
      );
    });

    it('closes connection to peer that does not exist', async () => {
      await remoteManager.closeConnection('non-existent-peer');
      expect(mockPlatformServices.closeConnection).toHaveBeenCalledWith(
        'non-existent-peer',
      );
    });

    it('registers location hints', async () => {
      await remoteManager.registerLocationHints('peer123', ['hint1', 'hint2']);
      expect(mockRemoteComms.registerLocationHints).toHaveBeenCalledWith(
        'peer123',
        ['hint1', 'hint2'],
      );
    });

    it('reconnects peer with hints', async () => {
      await remoteManager.reconnectPeer('peer123', ['relay1', 'relay2']);
      expect(mockPlatformServices.reconnectPeer).toHaveBeenCalledWith(
        'peer123',
        ['relay1', 'relay2'],
      );
    });

    it('reconnects peer with empty hints when hints not provided', async () => {
      await remoteManager.reconnectPeer('peer123');
      expect(mockPlatformServices.reconnectPeer).toHaveBeenCalledWith(
        'peer123',
        [],
      );
    });

    it('gets remote comms after initialization', () => {
      const comms = remoteManager.getRemoteComms();
      expect(comms).toBe(mockRemoteComms);
    });
  });

  describe('remote handle management', () => {
    beforeEach(async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);
      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();
    });

    it('establishes a new remote connection', () => {
      const remote = remoteManager.establishRemote('peer123');
      expect(remote).toBeDefined();
      expect(remote.remoteId).toMatch(/^r\d+$/u);
    });

    it('establishes a new remote with location hints', () => {
      const hints = ['/dns4/relay1.example/tcp/443/wss/p2p/relay1'];
      const remote = remoteManager.establishRemote('peer-with-hints', hints);

      expect(remote).toBeDefined();
      expect(remote.remoteId).toMatch(/^r\d+$/u);

      // Verify hints are persisted in kernel store
      const storedInfo = kernelStore.getRemoteInfo(remote.remoteId);
      expect(storedInfo).toBeDefined();
      expect(storedInfo?.hints).toStrictEqual(hints);
    });

    it('stores and retrieves multiple location hints', () => {
      const hints = [
        '/dns4/relay1.example/tcp/443/wss/p2p/relay1',
        '/dns4/relay2.example/tcp/443/wss/p2p/relay2',
        '/dns4/relay3.example/tcp/443/wss/p2p/relay3',
      ];
      const remote = remoteManager.establishRemote('peer-multi-hints', hints);

      const storedInfo = kernelStore.getRemoteInfo(remote.remoteId);
      expect(storedInfo?.hints).toStrictEqual(hints);
      expect(storedInfo?.hints).toHaveLength(3);
    });

    it('reuses existing remote for same peer', async () => {
      const remote1 = remoteManager.establishRemote('peer123');
      const remote2 = await remoteFor(remoteManager, 'peer123');
      expect(remote1).toBe(remote2);
    });

    it('creates new remote if not exists', async () => {
      const remote = await remoteFor(remoteManager, 'new-peer');
      expect(remote).toBeDefined();
      expect(remote.remoteId).toMatch(/^r\d+$/u);
    });

    /**
     * Hold the writes the manager hands the kernel queue, as an open crank
     * would.
     *
     * @returns A function that makes the held writes, in order.
     */
    const holdWrites = (): (() => void) => {
      const held: (() => void)[] = [];
      vi.mocked(mockKernelQueue.writeOutsideCrank).mockImplementation(
        async (write) =>
          new Promise((resolve) => {
            held.push(() => resolve(write()));
          }),
      );
      return () => {
        for (const write of held.splice(0)) {
          write();
        }
      };
    };

    it('sets up a new remote only when the kernel queue makes the write', async () => {
      const writeHeld = holdWrites();

      const first = remoteFor(remoteManager, 'new-peer');
      const second = remoteFor(remoteManager, 'new-peer', ['/dns4/relay']);
      const recordsWhileHeld = kernelStore.getRemoteIDs();
      writeHeld();
      const remote = await first;

      expect(recordsWhileHeld).toStrictEqual([]);
      expect(kernelStore.getRemoteIDs()).toStrictEqual([remote.remoteId]);
      expect(await second).toBe(remote);
      expect(mockKernelQueue.writeOutsideCrank).toHaveBeenCalledWith(
        expect.any(Function),
      );
      expect(mockRemoteComms.registerLocationHints).toHaveBeenCalledWith(
        'new-peer',
        ['/dns4/relay'],
      );
    });

    it("uses a known peer's remote at once, without the kernel queue", async () => {
      const remote = remoteManager.establishRemote('existing-peer');
      const use = vi.fn().mockReturnValue('used');

      const used = remoteManager.withRemote('existing-peer', { use });

      expect(use).toHaveBeenCalledExactlyOnceWith(remote);
      expect(mockKernelQueue.writeOutsideCrank).not.toHaveBeenCalled();
      expect(await used).toBe('used');
    });

    it('resolves to what a promise returned by use resolves to', async () => {
      const writeHeld = holdWrites();

      const used = remoteManager.withRemote('new-peer', {
        use: async () => 'answered',
      });
      writeHeld();

      expect(await used).toBe('answered');
    });

    it.each([0, 1, 2, 3])(
      "takes a new peer's messages in the order they came, %i ticks apart",
      async (ticks) => {
        const first = remoteManager.handleRemoteMessage(
          'new-peer',
          peerMessage(1),
        );
        for (let tick = 0; tick < ticks; tick += 1) {
          await Promise.resolve();
        }
        const second = remoteManager.handleRemoteMessage(
          'new-peer',
          peerMessage(2),
        );
        await Promise.all([first, second]);

        expect(
          vi
            .mocked(mockKernelQueue.acceptRemoteInbound)
            .mock.calls.map(([{ seq }]) => seq),
        ).toStrictEqual([1, 2]);
      },
    );

    it("takes a new peer's first message before one that comes once its setup is made", async () => {
      const writeHeld = holdWrites();
      const first = remoteManager.handleRemoteMessage(
        'new-peer',
        peerMessage(1),
      );
      writeHeld();
      const second = remoteManager.handleRemoteMessage(
        'new-peer',
        peerMessage(2),
      );
      await Promise.all([first, second]);

      expect(
        vi
          .mocked(mockKernelQueue.acceptRemoteInbound)
          .mock.calls.map(([{ seq }]) => seq),
      ).toStrictEqual([1, 2]);
    });

    it.each([
      ['known', true],
      ['new', false],
    ])(
      "rejects with what refusing a %s peer's message throws",
      async (_, known) => {
        if (known) {
          remoteManager.establishRemote('peer');
        }

        await expect(
          remoteManager.handleRemoteMessage('peer', peerMessage(0)),
        ).rejects.toThrow('invalid message seq: 0');
      },
    );

    it('sets up anew a remote whose setup failed to be written (gap, #1171)', async () => {
      const fault = new Error('SQLITE_FULL');
      const { kernelKVStore } = kernelDatabase;
      const set = kernelKVStore.set.bind(kernelKVStore);
      let failing = true;
      vi.spyOn(kernelKVStore, 'set').mockImplementation((key, value) => {
        if (failing && key.startsWith('e.nextObjectId.')) {
          failing = false;
          throw fault;
        }
        set(key, value);
      });

      await expect(remoteFor(remoteManager, 'new-peer')).rejects.toBe(fault);
      const remote = await remoteFor(remoteManager, 'new-peer');

      expect(kernelKVStore.get(`e.nextObjectId.${remote.remoteId}`)).toBe('1');
      expect(kernelStore.getRemoteIDs()).toStrictEqual([remote.remoteId]);
    });

    it('leaves no record of a remote whose handle failed to be made', async () => {
      const fault = new Error('SQLITE_IOERR');
      const { kernelKVStore } = kernelDatabase;
      const get = kernelKVStore.get.bind(kernelKVStore);
      let failing = true;
      vi.spyOn(kernelKVStore, 'get').mockImplementation((key) => {
        if (failing && key.startsWith('remoteSeq.')) {
          failing = false;
          throw fault;
        }
        return get(key);
      });

      await expect(remoteFor(remoteManager, 'new-peer')).rejects.toBe(fault);
      const remote = await remoteFor(remoteManager, 'new-peer');

      expect(kernelStore.getRemoteIDs()).toStrictEqual([remote.remoteId]);
    });

    it('refuses to set up a remote once the run loop is dead', async () => {
      vi.mocked(mockKernelQueue.assertRunLoopAlive).mockImplementationOnce(
        (what) => {
          throw new Error(`Kernel run loop died; cannot ${what}`);
        },
      );

      await expect(remoteFor(remoteManager, 'new-peer')).rejects.toThrow(
        'Kernel run loop died; cannot set up a remote',
      );
      expect(mockKernelQueue.writeOutsideCrank).not.toHaveBeenCalled();
    });

    it('costs no remote ID when remote comms are down', async () => {
      const nextRemoteId = kernelStore.getNextRemoteId();
      remoteManager.cleanup();

      await expect(remoteFor(remoteManager, 'new-peer')).rejects.toThrow(
        'Remote comms not initialized',
      );
      expect(kernelStore.getNextRemoteId()).toBe(
        `r${Number(nextRemoteId.slice(1)) + 1}`,
      );
    });

    it('creates new remote with hints using withRemote', async () => {
      const hints = ['/dns4/relay.example/tcp/443/wss/p2p/relay'];
      const remote = await remoteFor(remoteManager, 'new-peer-hints', hints);

      expect(remote).toBeDefined();
      const storedInfo = kernelStore.getRemoteInfo(remote.remoteId);
      expect(storedInfo?.hints).toStrictEqual(hints);
    });

    it('registers location hints for existing peer in withRemote', async () => {
      const remote = remoteManager.establishRemote('existing-peer');
      const hints = ['/dns4/relay.example/tcp/443/wss/p2p/relay'];

      const result = await remoteFor(remoteManager, 'existing-peer', hints);

      expect(result).toBe(remote);
      expect(mockRemoteComms.registerLocationHints).toHaveBeenCalledWith(
        'existing-peer',
        hints,
      );
    });

    it('does not register location hints for existing peer when hints are empty', async () => {
      const remote = remoteManager.establishRemote('existing-peer');

      const result = await remoteFor(remoteManager, 'existing-peer', []);

      expect(result).toBe(remote);
      expect(mockRemoteComms.registerLocationHints).not.toHaveBeenCalled();
    });

    it('gets remote by ID', () => {
      const established = remoteManager.establishRemote('peer123');
      const retrieved = remoteManager.getRemote(established.remoteId);
      expect(retrieved).toBe(established);
    });

    it('says whether a remote has a handle', () => {
      const established = remoteManager.establishRemote('peer123');
      expect([
        remoteManager.hasRemote(established.remoteId),
        remoteManager.hasRemote(asRemoteId('r999')),
      ]).toStrictEqual([true, false]);
    });

    it('throws error when getting non-existent remote by ID', () => {
      expect(() => remoteManager.getRemote(asRemoteId('r999'))).toThrow(
        'Remote not found: r999',
      );
    });

    it('hands a remote message to the peer it came from', async () => {
      const receiveFromPeer = vi.fn();
      const remote = remoteManager.establishRemote('peer123');
      remote.receiveFromPeer = receiveFromPeer;

      const response = await remoteManager.handleRemoteMessage(
        'peer123',
        'test message',
      );

      expect(response).toBeNull();
      expect(receiveFromPeer).toHaveBeenCalledWith('test message');
    });

    it('creates new remote when handling message from unknown peer', async () => {
      const message = JSON.stringify({
        seq: 1,
        method: 'deliver',
        params: [
          'message',
          'ko1',
          { type: 'invoke', target: 'ko2', methargs: {} },
        ],
      });

      // The message is only queued here, so the reference in it is not looked
      // at until the crank that delivers it.
      expect(
        await remoteManager.handleRemoteMessage('new-peer', message),
      ).toBeNull();

      const remote = await remoteFor(remoteManager, 'new-peer');
      expect(remote).toBeDefined();
      await expect(remote.deliverInbound(message)).rejects.toThrow(
        'ko1 is not an ERef',
      );
    });

    it('preserves location hints across stop/restart cycle', async () => {
      const hints = ['/dns4/relay.example/tcp/443/wss/p2p/relay'];
      const remote = remoteManager.establishRemote('peer-persist-hints', hints);
      const { remoteId } = remote;

      // Stop and restart
      await mockPlatformServices.stopRemoteComms();
      remoteManager.cleanup();

      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);
      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();

      // Verify hints were restored
      const restoredRemote = remoteManager.getRemote(remoteId);
      const storedInfo = kernelStore.getRemoteInfo(restoredRemote.remoteId);
      expect(storedInfo?.hints).toStrictEqual(hints);
    });
  });

  describe('message handler', () => {
    it('sets message handler', () => {
      const handler = vi.fn();
      // Should not throw
      expect(() => remoteManager.setMessageHandler(handler)).not.toThrow();
    });

    it('allows setting message handler multiple times', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      remoteManager.setMessageHandler(handler1);
      remoteManager.setMessageHandler(handler2);

      // Should not throw
      expect(() => remoteManager.setMessageHandler(handler2)).not.toThrow();
    });
  });

  describe('cleanup', () => {
    beforeEach(async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);
      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();
    });

    it('clears remoteComms after cleanup', () => {
      remoteManager.cleanup();

      expect(remoteManager.isRemoteCommsInitialized()).toBe(false);
    });

    it('clears all remote handles after cleanup', async () => {
      // Establish some remotes
      remoteManager.establishRemote('peer1');
      remoteManager.establishRemote('peer2');
      remoteManager.establishRemote('peer3');

      // Verify they exist
      expect(await remoteFor(remoteManager, 'peer1')).toBeDefined();
      expect(await remoteFor(remoteManager, 'peer2')).toBeDefined();
      expect(await remoteFor(remoteManager, 'peer3')).toBeDefined();

      remoteManager.cleanup();

      // After cleanup, trying to get remotes should throw or create new ones
      expect(remoteManager.isRemoteCommsInitialized()).toBe(false);
    });

    it('throws when calling getPeerId after cleanup', () => {
      remoteManager.cleanup();

      expect(() => remoteManager.getPeerId()).toThrow(
        'Remote identity not initialized',
      );
    });

    it('throws when calling closeConnection after cleanup', async () => {
      remoteManager.cleanup();

      await expect(remoteManager.closeConnection('peer1')).rejects.toThrow(
        'Remote comms not initialized',
      );
    });

    it('throws when calling registerLocationHints after cleanup', async () => {
      remoteManager.cleanup();

      await expect(
        remoteManager.registerLocationHints('peer1', ['hint1', 'hint2']),
      ).rejects.toThrow('Remote comms not initialized');
    });

    it('throws when calling reconnectPeer after cleanup', async () => {
      remoteManager.cleanup();

      await expect(remoteManager.reconnectPeer('peer1')).rejects.toThrow(
        'Remote comms not initialized',
      );
    });

    it('can be called when remote comms is not initialized', () => {
      const newManager = new RemoteManager({
        platformServices: mockPlatformServices,
        kernelStore,
        kernelQueue: mockKernelQueue,
        logger,
      });

      // Should not throw
      expect(() => newManager.cleanup()).not.toThrow();
    });

    it('allows re-initialization after cleanup', async () => {
      remoteManager.cleanup();

      // Should be able to initialize again
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);
      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms({ relays: ['relay1'] });

      expect(remoteManager.isRemoteCommsInitialized()).toBe(true);
      expect(remoteComms.initRemoteComms).toHaveBeenCalledTimes(2);
    });

    it('clears remote handles by peer ID', async () => {
      const remote1 = remoteManager.establishRemote('peer1');
      const remote2 = remoteManager.establishRemote('peer2');

      // Verify they're accessible
      expect(await remoteFor(remoteManager, 'peer1')).toBe(remote1);
      expect(await remoteFor(remoteManager, 'peer2')).toBe(remote2);

      remoteManager.cleanup();

      // After cleanup, remotes are cleared
      expect(remoteManager.isRemoteCommsInitialized()).toBe(false);
    });
  });

  describe('reapRemotes', () => {
    beforeEach(async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);
      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();
    });

    it('schedules reap for all remotes when no filter provided', () => {
      remoteManager.establishRemote('peer1');
      remoteManager.establishRemote('peer2');
      remoteManager.establishRemote('peer3');

      remoteManager.reapRemotes();

      // Drain the reap queue and verify all remotes were scheduled
      const reaped: string[] = [];
      let action = kernelStore.nextReapAction();
      while (action) {
        reaped.push(action.endpointId);
        action = kernelStore.nextReapAction();
      }
      expect(reaped).toStrictEqual(['r1', 'r2', 'r3']);
    });

    it('schedules reap only for remotes matching the filter', () => {
      remoteManager.establishRemote('peer1');
      remoteManager.establishRemote('peer2');
      remoteManager.establishRemote('peer3');

      remoteManager.reapRemotes((remoteId) => remoteId === 'r2');

      const action = kernelStore.nextReapAction();
      expect(action).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: 'r2',
      });
      expect(kernelStore.nextReapAction()).toBeUndefined();
    });

    it('does nothing when no remotes exist', () => {
      remoteManager.reapRemotes();

      expect(kernelStore.nextReapAction()).toBeUndefined();
    });
  });

  describe('handleRemoteGiveUp', () => {
    beforeEach(async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);
      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();
    });

    it('handles remote give up callback when remote exists', () => {
      const peerId = 'peer-to-give-up';
      const remote = remoteManager.establishRemote(peerId);
      const giveUpSpy = vi.spyOn(remote, 'giveUp');
      // Get the callback that was passed to initRemoteComms
      const initCall = vi.mocked(remoteComms.initRemoteComms).mock.calls[0];
      const onRemoteGiveUp = initCall?.[6] as (peerId: string) => void;
      onRemoteGiveUp(peerId);
      // Verify giveUp was called to stop retransmitting and reject pending work
      expect(giveUpSpy).toHaveBeenCalledWith(
        `Remote connection lost: ${peerId} (max retries reached or non-retryable error)`,
      );
    });

    it('handles remote give up callback when remote does not exist', () => {
      const peerId = 'non-existent-peer';
      const initCall = vi.mocked(remoteComms.initRemoteComms).mock.calls[0];
      const onRemoteGiveUp = initCall?.[6] as (peerId: string) => void;
      expect(() => onRemoteGiveUp(peerId)).not.toThrow();
    });

    it('rejects kernel promises with CONNECTION_LOST when remote has promises', () => {
      const peerId = 'peer-with-promises';
      const remote = remoteManager.establishRemote(peerId);
      const { remoteId } = remote;

      // Set up a promise where the remote is the decider
      const [kpid] = kernelStore.initKernelPromise();
      kernelStore.setPromiseDecider(kpid, remoteId);
      kernelStore.addCListEntry(remoteId, kpid, asRRef('rp+1'));

      const resolvePromisesSpy = vi.spyOn(mockKernelQueue, 'resolvePromises');

      const initCall = vi.mocked(remoteComms.initRemoteComms).mock.calls[0];
      const onRemoteGiveUp = initCall?.[6] as (peerId: string) => void;
      onRemoteGiveUp(peerId);

      expect(resolvePromisesSpy).toHaveBeenCalledWith(remoteId, [
        [
          kpid,
          true,
          expect.objectContaining({
            body: expect.stringContaining('[KERNEL:CONNECTION_LOST]'),
          }),
        ],
      ]);
    });

    it('handles remote give up with no promises', () => {
      const peerId = 'peer-with-no-promises';
      remoteManager.establishRemote(peerId);
      const resolvePromisesSpy = vi.spyOn(mockKernelQueue, 'resolvePromises');
      const initCall = vi.mocked(remoteComms.initRemoteComms).mock.calls[0];
      const onRemoteGiveUp = initCall?.[6] as (peerId: string) => void;
      onRemoteGiveUp(peerId);
      expect(resolvePromisesSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleIncarnationChange', () => {
    beforeEach(async () => {
      const messageHandler = vi.fn();
      vi.mocked(remoteComms.initRemoteComms).mockResolvedValue(mockRemoteComms);
      remoteManager.setMessageHandler(messageHandler);
      await remoteManager.initRemoteComms();
    });

    /**
     * Get the onIncarnationChange callback (9th argument, index 8) that
     * RemoteManager passed when initializing remote comms.
     *
     * @returns The onIncarnationChange callback bound to the RemoteManager.
     */
    function getOnIncarnationChange(): (
      peerId: string,
      observedIncarnation: string,
    ) => Promise<boolean> {
      const initCall = vi.mocked(remoteComms.initRemoteComms).mock.calls[0];
      return initCall?.[8] as (
        peerId: string,
        observedIncarnation: string,
      ) => Promise<boolean>;
    }

    /**
     * Carry out the change the last handshake queued, short of its commit.
     *
     * @returns The crank outcome, or undefined if no change was queued.
     */
    function applyQueuedIncarnationChange(): CrankResult | undefined {
      const queued = vi
        .mocked(mockKernelQueue.acceptPeerIncarnation)
        .mock.calls.at(-1);
      if (!queued) {
        return undefined;
      }
      const [change] = queued;
      return remoteManager.applyIncarnationChange({
        type: 'peerIncarnation',
        ...change,
      });
    }

    /**
     * Apply the change the last handshake queued and run its `afterCommit`.
     */
    async function runQueuedIncarnationChange(): Promise<void> {
      await applyQueuedIncarnationChange()?.afterCommit?.();
    }

    /**
     * Complete a handshake and run the crank it queues, the way the transport
     * and the run loop do between them.
     *
     * @param peerId - The peer handshaking.
     * @param incarnation - The incarnation it reports.
     * @returns Whether the kernel judged this a restart.
     */
    async function handshakeAndRunCrank(
      peerId: string,
      incarnation: string,
    ): Promise<boolean> {
      const verdict = await getOnIncarnationChange()(peerId, incarnation);
      await runQueuedIncarnationChange();
      return verdict;
    }

    it('triggers persist + finalize peer restart when persisted incarnation differs from observed', async () => {
      const peerId = 'peer-that-restarted';
      const remote = remoteManager.establishRemote(peerId);
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');
      // Seed the persisted incarnation (as if a prior handshake recorded it).
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const verdict = await handshakeAndRunCrank(peerId, 'incarnation-B');

      expect(verdict).toBe(true);
      expect(persistSpy).toHaveBeenCalled();
      expect(finalizeSpy).toHaveBeenCalled();
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-B');
    });

    it('does not trigger restart on first observation of a peer', async () => {
      const peerId = 'peer-first-contact';
      const remote = remoteManager.establishRemote(peerId);
      const holdSpy = vi.spyOn(remote, 'holdForRestart');
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');

      const verdict = await handshakeAndRunCrank(peerId, 'incarnation-A');

      expect(verdict).toBe(false);
      expect(mockKernelQueue.acceptPeerIncarnation).toHaveBeenCalledWith({
        peerId,
        incarnation: 'incarnation-A',
        restart: false,
      });
      expect(holdSpy).not.toHaveBeenCalled();
      expect(persistSpy).not.toHaveBeenCalled();
      expect(finalizeSpy).not.toHaveBeenCalled();
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-A');
    });

    it('reports a restart of a peer whose first incarnation is still waiting to be recorded', async () => {
      const peerId = 'peer-restarted-on-first-contact';
      const remote = remoteManager.establishRemote(peerId);
      const holdSpy = vi.spyOn(remote, 'holdForRestart');
      vi.mocked(mockKernelQueue.waitingIncarnations).mockReturnValue([
        'incarnation-A',
      ]);

      expect(await getOnIncarnationChange()(peerId, 'incarnation-B')).toBe(
        true,
      );
      expect(holdSpy).toHaveBeenCalledOnce();
      expect(mockKernelQueue.acceptPeerIncarnation).toHaveBeenCalledWith({
        peerId,
        incarnation: 'incarnation-B',
        restart: true,
      });
    });

    it('queues a change once however many handshakes report it before its crank', async () => {
      const peerId = 'peer-redialing';
      const remote = remoteManager.establishRemote(peerId);
      const holdSpy = vi.spyOn(remote, 'holdForRestart');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      expect(await getOnIncarnationChange()(peerId, 'incarnation-B')).toBe(
        true,
      );
      vi.mocked(mockKernelQueue.waitingIncarnations).mockReturnValue([
        'incarnation-B',
      ]);
      expect(await getOnIncarnationChange()(peerId, 'incarnation-B')).toBe(
        true,
      );

      expect(mockKernelQueue.acceptPeerIncarnation).toHaveBeenCalledOnce();
      expect(holdSpy).toHaveBeenCalledTimes(2);
    });

    it('reports no restart to a re-dial of a first incarnation still waiting to be recorded', async () => {
      const peerId = 'peer-redialing-before-first-record';
      const remote = remoteManager.establishRemote(peerId);
      const holdSpy = vi.spyOn(remote, 'holdForRestart');
      vi.mocked(mockKernelQueue.waitingIncarnations).mockReturnValue([
        'incarnation-A',
      ]);

      expect(await getOnIncarnationChange()(peerId, 'incarnation-A')).toBe(
        false,
      );
      expect(mockKernelQueue.acceptPeerIncarnation).not.toHaveBeenCalled();
      expect(holdSpy).not.toHaveBeenCalled();
    });

    it.each([
      {
        what: 'a restart waiting',
        stored: 'incarnation-A',
        waiting: ['incarnation-B'],
        held: true,
      },
      {
        what: 'a restart waiting behind its first incarnation',
        stored: undefined,
        waiting: ['incarnation-A', 'incarnation-B'],
        held: true,
      },
      {
        what: 'nothing waiting',
        stored: 'incarnation-A',
        waiting: [],
        held: false,
      },
      {
        what: 'only its first incarnation waiting',
        stored: undefined,
        waiting: ['incarnation-A'],
        held: false,
      },
    ])(
      'holds a remote made while its peer has $what: $held',
      ({ stored, waiting, held }) => {
        const peerId = 'peer-established-late';
        if (stored !== undefined) {
          kernelStore.setPeerIncarnation(peerId, stored);
        }
        vi.mocked(mockKernelQueue.waitingIncarnations).mockReturnValue(waiting);
        const holdSpy = vi.spyOn(RemoteHandle.prototype, 'holdForRestart');

        remoteManager.establishRemote(peerId);

        expect(holdSpy.mock.calls.length > 0).toBe(held);
      },
    );

    it('reports a restart again to a re-dial before the first incarnation is recorded', async () => {
      const peerId = 'peer-redialing-on-first-contact';
      const remote = remoteManager.establishRemote(peerId);
      const holdSpy = vi.spyOn(remote, 'holdForRestart');
      vi.mocked(mockKernelQueue.waitingIncarnations).mockReturnValue([
        'incarnation-A',
        'incarnation-B',
      ]);

      expect(await getOnIncarnationChange()(peerId, 'incarnation-B')).toBe(
        true,
      );
      expect(mockKernelQueue.acceptPeerIncarnation).not.toHaveBeenCalled();
      expect(holdSpy).toHaveBeenCalledOnce();
    });

    it('refuses a handshake from the incarnation a waiting restart replaces', async () => {
      const peerId = 'peer-late-old-incarnation';
      remoteManager.establishRemote(peerId);
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');
      vi.mocked(mockKernelQueue.waitingIncarnations).mockReturnValue([
        'incarnation-B',
      ]);

      expect(await getOnIncarnationChange()(peerId, 'incarnation-A')).toBe(
        true,
      );
      expect(mockKernelQueue.acceptPeerIncarnation).not.toHaveBeenCalled();
    });

    it('keeps a remote on hold past a restart while a later one waits', async () => {
      const peerId = 'peer-restarted-twice';
      const remote = remoteManager.establishRemote(peerId);
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');
      await getOnIncarnationChange()(peerId, 'incarnation-B');
      const result = applyQueuedIncarnationChange();
      const holdSpy = vi.spyOn(remote, 'holdForRestart');
      vi.mocked(mockKernelQueue.waitingIncarnations).mockReturnValue([
        'incarnation-C',
      ]);

      await result?.afterCommit?.();

      expect(holdSpy).toHaveBeenCalledOnce();
    });

    it('does not hold a remote for a change the run loop refused', async () => {
      const peerId = 'peer-restarted-after-death';
      const remote = remoteManager.establishRemote(peerId);
      const holdSpy = vi.spyOn(remote, 'holdForRestart');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');
      vi.mocked(mockKernelQueue.acceptPeerIncarnation).mockImplementation(
        () => {
          throw new Error('Kernel run loop died');
        },
      );

      await expect(
        getOnIncarnationChange()(peerId, 'incarnation-B'),
      ).rejects.toThrow('Kernel run loop died');
      expect(holdSpy).not.toHaveBeenCalled();
    });

    it('does nothing when observed incarnation matches persisted value', async () => {
      const peerId = 'peer-stable';
      const remote = remoteManager.establishRemote(peerId);
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const verdict = await handshakeAndRunCrank(peerId, 'incarnation-A');

      expect(verdict).toBe(false);
      expect(persistSpy).not.toHaveBeenCalled();
      expect(finalizeSpy).not.toHaveBeenCalled();
    });

    it('rejects kernel promises where the restarted remote is decider', async () => {
      const peerId = 'peer-with-promises';
      const remote = remoteManager.establishRemote(peerId);
      const { remoteId } = remote;

      const [kpid] = kernelStore.initKernelPromise();
      kernelStore.setPromiseDecider(kpid, remoteId);
      kernelStore.addCListEntry(remoteId, kpid, asRRef('rp+1'));
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const resolvePromisesSpy = vi.spyOn(mockKernelQueue, 'resolvePromises');

      await handshakeAndRunCrank(peerId, 'incarnation-B');

      expect(resolvePromisesSpy).toHaveBeenCalledWith(
        remoteId,
        [
          [
            kpid,
            true,
            expect.objectContaining({
              body: expect.stringContaining('[KERNEL:PEER_RESTARTED]'),
            }),
          ],
        ],
        false,
      );
    });

    it('puts a restarted remote on hold until the crank records the restart', async () => {
      const peerId = 'peer-held';
      const remote = remoteManager.establishRemote(peerId);
      const holdSpy = vi.spyOn(remote, 'holdForRestart');
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      expect(await getOnIncarnationChange()(peerId, 'incarnation-B')).toBe(
        true,
      );
      expect(holdSpy).toHaveBeenCalledOnce();
      expect(finalizeSpy).not.toHaveBeenCalled();

      await runQueuedIncarnationChange();
      expect(finalizeSpy).toHaveBeenCalledOnce();
    });

    it('releases every hold for a kernel discarding its queued incarnation changes', async () => {
      const remotes = ['peer-held-1', 'peer-held-2'].map((peerId) =>
        remoteManager.establishRemote(peerId),
      );
      const releaseSpies = remotes.map((remote) =>
        vi.spyOn(remote, 'releaseRestartHold'),
      );

      remoteManager.releaseRestartHolds();

      for (const spy of releaseSpies) {
        expect(spy).toHaveBeenCalledOnce();
      }
    });

    it('rejects the promises of a restart a send ran into as PEER_RESTARTED', async () => {
      const peerId = 'peer-restarted-under-a-send';
      const remote = remoteManager.establishRemote(peerId);
      const { remoteId } = remote;

      const [kpid] = kernelStore.initKernelPromise();
      kernelStore.setPromiseDecider(kpid, remoteId);
      kernelStore.addCListEntry(remoteId, kpid, asRRef('rp+1'));
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const resolvePromisesSpy = vi.spyOn(mockKernelQueue, 'resolvePromises');
      let sent: Promise<void> | undefined;
      vi.mocked(mockRemoteComms.sendRemoteMessage).mockImplementationOnce(
        async () => {
          sent = (async () => {
            await getOnIncarnationChange()(peerId, 'incarnation-B');
            throw Object.assign(new Error('peer restarted'), {
              name: 'PeerRestartedError',
            });
          })();
          return sent;
        },
      );

      const redemption = remote.redeemOcapURL('ocap:something@peer,relay');
      await vi.waitFor(() => expect(sent).toBeDefined());
      await sent?.catch(() => undefined);
      // The send's continuation runs on later turns of the microtask queue.
      await delay(0);
      expect(resolvePromisesSpy).not.toHaveBeenCalled();

      await runQueuedIncarnationChange();

      expect(resolvePromisesSpy).toHaveBeenCalledOnce();
      expect(resolvePromisesSpy).toHaveBeenCalledWith(
        remoteId,
        [
          [
            kpid,
            true,
            expect.objectContaining({
              body: expect.stringContaining('[KERNEL:PEER_RESTARTED]'),
            }),
          ],
        ],
        false,
      );
      await expect(redemption).rejects.toThrow('Remote peer restarted');
    });

    it('persists the incarnation and reports restart even when no remote handle exists', async () => {
      const peerId = 'unknown-peer';
      const resolvePromisesSpy = vi.spyOn(mockKernelQueue, 'resolvePromises');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const verdict = await handshakeAndRunCrank(peerId, 'incarnation-B');
      expect(verdict).toBe(true);

      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-B');
      // No remote handle → no promises to reject.
      expect(resolvePromisesSpy).not.toHaveBeenCalled();
    });

    it('does not reject promises when there are none', async () => {
      const peerId = 'peer-without-promises';
      const remote = remoteManager.establishRemote(peerId);
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');
      const resolvePromisesSpy = vi.spyOn(mockKernelQueue, 'resolvePromises');

      await handshakeAndRunCrank(peerId, 'incarnation-B');

      // The restart has to have happened, or this asserts nothing.
      expect(persistSpy).toHaveBeenCalledOnce();
      expect(resolvePromisesSpy).not.toHaveBeenCalled();
    });

    it('answers the handshake without waiting for a crank', async () => {
      const peerId = 'peer-mid-handshake';
      const remote = remoteManager.establishRemote(peerId);
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const verdict = await getOnIncarnationChange()(peerId, 'incarnation-B');

      expect(verdict).toBe(true);
      expect(mockKernelQueue.acceptPeerIncarnation).toHaveBeenCalledWith({
        peerId,
        incarnation: 'incarnation-B',
        restart: true,
      });
      expect(persistSpy).not.toHaveBeenCalled();
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-A');
    });

    it('resets the restarted remote in memory only after the commit', async () => {
      const peerId = 'peer-deferred-rejects';
      const remote = remoteManager.establishRemote(peerId);
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');
      await getOnIncarnationChange()(peerId, 'incarnation-B');

      const result = applyQueuedIncarnationChange();

      expect(finalizeSpy).not.toHaveBeenCalled();
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-B');
      await result?.afterCommit?.();
      expect(finalizeSpy).toHaveBeenCalledOnce();
    });

    it('throws rather than tear a session down twice for one change', async () => {
      const peerId = 'peer-reconnecting';
      const remote = remoteManager.establishRemote(peerId);
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');
      await getOnIncarnationChange()(peerId, 'incarnation-B');
      applyQueuedIncarnationChange();

      expect(() => applyQueuedIncarnationChange()).toThrow(
        `Peer ${peerId} incarnation incarnation-B is already recorded`,
      );
      expect(persistSpy).toHaveBeenCalledOnce();
    });

    it('leaves a change for the next handshake while remote comms are not up', async () => {
      const peerId = 'peer-restarted-before-comms';
      const remote = remoteManager.establishRemote(peerId);
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');
      await getOnIncarnationChange()(peerId, 'incarnation-B');
      remoteManager.cleanup();

      expect(applyQueuedIncarnationChange()).toStrictEqual({});
      expect(persistSpy).not.toHaveBeenCalled();
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-A');
    });

    it('records a first incarnation taken while remote comms are stopped', async () => {
      const peerId = 'peer-met-at-boot';
      await getOnIncarnationChange()(peerId, 'incarnation-A');
      remoteManager.cleanup();

      expect(applyQueuedIncarnationChange()).toStrictEqual({});
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-A');
    });

    it('throws, leaving the incarnation unadvanced, when persistPeerRestart throws', async () => {
      const peerId = 'peer-handler-throws';
      const remote = remoteManager.establishRemote(peerId);
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const failure = new Error('synthetic persistPeerRestart failure');
      vi.spyOn(remote, 'persistPeerRestart').mockImplementation(() => {
        throw failure;
      });
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');

      expect(await getOnIncarnationChange()(peerId, 'incarnation-B')).toBe(
        true,
      );
      expect(() => applyQueuedIncarnationChange()).toThrow(failure);

      // `setPeerIncarnation` runs after `persistPeerRestart`, so it never
      // happened. What `persistPeerRestart` wrote before throwing would go back
      // with the crank, which this map-backed store cannot model.
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-A');
      expect(finalizeSpy).not.toHaveBeenCalled();
    });
  });
});
