import { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import * as remoteComms from './remote-comms.ts';
import { RemoteManager } from './RemoteManager.ts';
import { createMockRemotesFactory } from '../../../test/remotes-mocks.ts';
import { withFailingSavepointRelease } from '../../../test/savepoint-stack.ts';
import { makeMapKernelDatabase } from '../../../test/storage.ts';
import type { KernelQueue } from '../../KernelQueue.ts';
import { makeKernelStore } from '../../store/index.ts';
import type { PlatformServices } from '../../types.ts';
import type { RemoteComms } from '../types.ts';

vi.mock('./remote-comms.ts', async () => {
  const actual = await vi.importActual('./remote-comms.ts');
  return {
    ...actual,
    initRemoteComms: vi.fn(),
    initRemoteIdentity: vi.fn(),
  };
});

describe('RemoteManager', () => {
  let remoteManager: RemoteManager;
  let mockPlatformServices: PlatformServices;
  let kernelStore: ReturnType<typeof makeKernelStore>;
  let mockKernelQueue: KernelQueue;
  let logger: Logger;
  let mockRemoteComms: RemoteComms;
  let mockFactory: ReturnType<typeof createMockRemotesFactory>;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
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
      expect(newRemoteManager.remoteFor('peer-1')).toBe(restoredRemote1);
      expect(newRemoteManager.remoteFor('peer-2')).toBe(restoredRemote2);
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

    it('reuses existing remote for same peer', () => {
      const remote1 = remoteManager.establishRemote('peer123');
      const remote2 = remoteManager.remoteFor('peer123');
      expect(remote1).toBe(remote2);
    });

    it('creates new remote if not exists', () => {
      const remote = remoteManager.remoteFor('new-peer');
      expect(remote).toBeDefined();
      expect(remote.remoteId).toMatch(/^r\d+$/u);
    });

    it('creates new remote with hints using remoteFor', () => {
      const hints = ['/dns4/relay.example/tcp/443/wss/p2p/relay'];
      const remote = remoteManager.remoteFor('new-peer-hints', hints);

      expect(remote).toBeDefined();
      const storedInfo = kernelStore.getRemoteInfo(remote.remoteId);
      expect(storedInfo?.hints).toStrictEqual(hints);
    });

    it('registers location hints for existing peer in remoteFor', () => {
      const remote = remoteManager.establishRemote('existing-peer');
      const hints = ['/dns4/relay.example/tcp/443/wss/p2p/relay'];

      const result = remoteManager.remoteFor('existing-peer', hints);

      expect(result).toBe(remote);
      expect(mockRemoteComms.registerLocationHints).toHaveBeenCalledWith(
        'existing-peer',
        hints,
      );
    });

    it('does not register location hints for existing peer when hints are empty', () => {
      const remote = remoteManager.establishRemote('existing-peer');

      const result = remoteManager.remoteFor('existing-peer', []);

      expect(result).toBe(remote);
      expect(mockRemoteComms.registerLocationHints).not.toHaveBeenCalled();
    });

    it('gets remote by ID', () => {
      const established = remoteManager.establishRemote('peer123');
      const retrieved = remoteManager.getRemote(established.remoteId);
      expect(retrieved).toBe(established);
    });

    it('throws error when getting non-existent remote by ID', () => {
      expect(() => remoteManager.getRemote('r999')).toThrow(
        'Remote not found: r999',
      );
    });

    it('handles remote message', async () => {
      const mockHandleMessage = vi.fn().mockResolvedValue('response');
      const remote = remoteManager.establishRemote('peer123');
      remote.handleRemoteMessage = mockHandleMessage;

      const response = await remoteManager.handleRemoteMessage(
        'peer123',
        'test message',
      );
      expect(response).toBe('response');
      expect(mockHandleMessage).toHaveBeenCalledWith('test message');
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

      // This will create a new remote and try to handle the message
      // We expect it to fail because the remote doesn't have the necessary setup
      await expect(
        remoteManager.handleRemoteMessage('new-peer', message),
      ).rejects.toThrow('ko1 is not an ERef');

      // But verify that a new remote was created
      const remote = remoteManager.remoteFor('new-peer');
      expect(remote).toBeDefined();
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

    it('clears all remote handles after cleanup', () => {
      // Establish some remotes
      remoteManager.establishRemote('peer1');
      remoteManager.establishRemote('peer2');
      remoteManager.establishRemote('peer3');

      // Verify they exist
      expect(remoteManager.remoteFor('peer1')).toBeDefined();
      expect(remoteManager.remoteFor('peer2')).toBeDefined();
      expect(remoteManager.remoteFor('peer3')).toBeDefined();

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

    it('clears remote handles by peer ID', () => {
      const remote1 = remoteManager.establishRemote('peer1');
      const remote2 = remoteManager.establishRemote('peer2');

      // Verify they're accessible
      expect(remoteManager.remoteFor('peer1')).toBe(remote1);
      expect(remoteManager.remoteFor('peer2')).toBe(remote2);

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
      kernelStore.addCListEntry(remoteId, kpid, 'rp+1');

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

    it('triggers persist + finalize peer restart when persisted incarnation differs from observed', async () => {
      const peerId = 'peer-that-restarted';
      const remote = remoteManager.establishRemote(peerId);
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');
      // Seed the persisted incarnation (as if a prior handshake recorded it).
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const verdict = await getOnIncarnationChange()(peerId, 'incarnation-B');

      expect(verdict).toBe(true);
      expect(persistSpy).toHaveBeenCalled();
      expect(finalizeSpy).toHaveBeenCalled();
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-B');
    });

    it('does not trigger restart on first observation of a peer', async () => {
      const peerId = 'peer-first-contact';
      const remote = remoteManager.establishRemote(peerId);
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');

      const verdict = await getOnIncarnationChange()(peerId, 'incarnation-A');

      expect(verdict).toBe(false);
      expect(persistSpy).not.toHaveBeenCalled();
      expect(finalizeSpy).not.toHaveBeenCalled();
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-A');
    });

    it('does nothing when observed incarnation matches persisted value', async () => {
      const peerId = 'peer-stable';
      const remote = remoteManager.establishRemote(peerId);
      const persistSpy = vi.spyOn(remote, 'persistPeerRestart');
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const verdict = await getOnIncarnationChange()(peerId, 'incarnation-A');

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
      kernelStore.addCListEntry(remoteId, kpid, 'rp+1');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const resolvePromisesSpy = vi.spyOn(mockKernelQueue, 'resolvePromises');

      await getOnIncarnationChange()(peerId, 'incarnation-B');

      expect(resolvePromisesSpy).toHaveBeenCalledWith(remoteId, [
        [
          kpid,
          true,
          expect.objectContaining({
            body: expect.stringContaining('[KERNEL:PEER_RESTARTED]'),
          }),
        ],
      ]);
    });

    it('persists the incarnation and reports restart even when no remote handle exists', async () => {
      const peerId = 'unknown-peer';
      const resolvePromisesSpy = vi.spyOn(mockKernelQueue, 'resolvePromises');
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      // The verdict reflects the persisted-state comparison, not whether
      // there's a RemoteHandle to reset. Transport callers use the verdict
      // to suppress stale outbound messages; that decision is correct
      // regardless of local handle presence.
      const verdict = await getOnIncarnationChange()(peerId, 'incarnation-B');
      expect(verdict).toBe(true);

      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-B');
      // No remote handle → no promises to reject.
      expect(resolvePromisesSpy).not.toHaveBeenCalled();
    });

    it('does not reject promises when there are none', async () => {
      const peerId = 'peer-without-promises';
      remoteManager.establishRemote(peerId);
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');
      const resolvePromisesSpy = vi.spyOn(mockKernelQueue, 'resolvePromises');

      await getOnIncarnationChange()(peerId, 'incarnation-B');

      expect(resolvePromisesSpy).not.toHaveBeenCalled();
    });

    it('rolls back the savepoint and preserves stored state when persistPeerRestart throws', async () => {
      const peerId = 'peer-handler-throws';
      const remote = remoteManager.establishRemote(peerId);
      kernelStore.setPeerIncarnation(peerId, 'incarnation-A');

      const failure = new Error('synthetic persistPeerRestart failure');
      vi.spyOn(remote, 'persistPeerRestart').mockImplementation(() => {
        throw failure;
      });
      const finalizeSpy = vi.spyOn(remote, 'finalizePeerRestart');

      await expect(
        getOnIncarnationChange()(peerId, 'incarnation-B'),
      ).rejects.toThrow(failure);

      // Persisted incarnation must NOT have advanced — the savepoint
      // rollback should have reverted the would-be setPeerIncarnation that
      // runs after persistPeerRestart in the wrapped block.
      expect(kernelStore.getPeerIncarnation(peerId)).toBe('incarnation-A');
      // finalize must not run if the persisted phase failed: in-memory
      // mutations would otherwise drift from the rolled-back kv view.
      expect(finalizeSpy).not.toHaveBeenCalled();
    });

    // The same shape `RemoteHandle.handleRemoteMessage` has: the release sits
    // inside the `try` and the rollback in the `catch`, so a failed RELEASE —
    // which discards the whole savepoint stack — leaves the rollback naming a
    // savepoint that is gone.
    it('reports the release failure rather than a missing savepoint', async () => {
      const peerId = 'peer-whose-release-fails';
      const {
        kernelStore: failingStore,
        releaseFailure,
        rollbackSavepoint,
      } = withFailingSavepointRelease(kernelStore);
      remoteManager = new RemoteManager({
        platformServices: mockPlatformServices,
        kernelStore: failingStore,
        kernelQueue: mockKernelQueue,
        logger,
      });
      remoteManager.setMessageHandler(vi.fn());
      await remoteManager.initRemoteComms();
      const onIncarnationChange = vi
        .mocked(remoteComms.initRemoteComms)
        .mock.calls.at(-1)?.[8] as (
        peerId: string,
        observedIncarnation: string,
      ) => Promise<boolean>;

      // The error an operator needs is the one the database gave, not the
      // bookkeeping artefact of trying to clean up after it.
      await expect(onIncarnationChange(peerId, 'incarnation-A')).rejects.toBe(
        releaseFailure,
      );
      // Still attempted, so that abandoning the rollback is not a way to pass:
      // a release that failed for a reason of its own may well have left the
      // savepoint standing.
      expect(rollbackSavepoint).toHaveBeenCalledWith(
        `peerIncarnation_${peerId}`,
      );
    });
  });
});
