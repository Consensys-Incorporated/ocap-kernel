import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { fromHex } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  initRemoteIdentity,
  initRemoteComms,
  parseOcapURL,
  DEFAULT_MAX_URL_RELAY_HINTS,
  DEFAULT_MAX_KNOWN_RELAYS,
} from './remote-comms.ts';
import { createMockRemotesFactory } from '../../../test/remotes-mocks.ts';
import { makeMapKernelDatabase } from '../../../test/storage.ts';
import type { KernelStore, RelayEntry } from '../../store/index.ts';
import { makeKernelStore } from '../../store/index.ts';
import type { KRef, PlatformServices } from '../../types.ts';
import { mnemonicToSeed } from '../../utils/bip39.ts';
import type { RemoteMessageHandler } from '../types.ts';

/**
 * Build learned (non-bootstrap) relay entries from address strings.
 *
 * @param addrs - Relay multiaddr strings.
 * @param lastSeen - Epoch ms for lastSeen (default 100).
 * @returns Relay entries with isBootstrap: false.
 */
function makeLearnedRelayEntries(
  addrs: string[],
  lastSeen = 100,
): RelayEntry[] {
  return addrs.map((addr) => ({ addr, lastSeen, isBootstrap: false }));
}

describe('remote-comms', () => {
  let mockKernelStore: KernelStore;
  let mockPlatformServices: PlatformServices;
  let mockRemoteMessageHandler: RemoteMessageHandler;
  let mockFactory: ReturnType<typeof createMockRemotesFactory>;
  let mockKernelDatabase: ReturnType<typeof makeMapKernelDatabase>;

  beforeEach(() => {
    mockKernelDatabase = makeMapKernelDatabase();
    const kernelStore = makeKernelStore(mockKernelDatabase);
    mockFactory = createMockRemotesFactory({ kernelStore });
    const mocks = mockFactory.makeRemoteCommsMocks();
    mockKernelStore = mocks.kernelStore;
    mockPlatformServices = mocks.platformServices;
    mockRemoteMessageHandler = mocks.remoteMessageHandler;

    let counter = 1;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((arr) => {
      arr[0] = counter;
      counter += 1;
      return arr;
    });
  });

  describe('initRemoteComms', () => {
    it('creates a working remote comms object with expected state', async () => {
      const testRelays = [
        '/dns4/relay1.example.com/tcp/443/wss/p2p-circuit',
        '/dns4/relay2.example.com/tcp/443/wss/p2p-circuit',
      ];
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { relays: testRelays },
      );
      expect(remoteComms).toHaveProperty('getPeerId');
      expect(remoteComms).toHaveProperty('issueOcapURL');
      expect(remoteComms).toHaveProperty('redeemLocalOcapURL');
      expect(remoteComms).toHaveProperty('sendRemoteMessage');
      expect(remoteComms).toHaveProperty('registerLocationHints');

      const keySeed = mockKernelStore.getRemoteIdentityValue('keySeed');
      expect(keySeed).toBe(
        '0100000000000000000000000000000000000000000000000000000000000000',
      );

      const ocapURLKey = mockKernelStore.getRemoteIdentityValue('ocapURLKey');
      expect(ocapURLKey).toBe(
        '0200000000000000000000000000000000000000000000000000000000000000',
      );

      const peerId = mockKernelStore.getRemoteIdentityValue('peerId');
      const keyPair = await generateKeyPairFromSeed(
        'Ed25519',
        fromHex(keySeed as string),
      );
      expect(peerId).toBe(peerIdFromPrivateKey(keyPair).toString());

      expect(remoteComms.getPeerId()).toBe(peerId);

      const ocapURL = await remoteComms.issueOcapURL('ko1' as KRef);
      const { oid, hints } = parseOcapURL(ocapURL);
      const knownRelayAddresses = mockKernelStore.getKnownRelayAddresses();
      expect(knownRelayAddresses).toStrictEqual(testRelays);
      // URL should embed the relays (within DEFAULT_MAX_URL_RELAY_HINTS cap)
      expect(hints).toStrictEqual(testRelays);
      const referenceURL = `ocap:${oid}@${peerId},${testRelays.join(',')}`;
      expect(ocapURL).toBe(referenceURL);

      const kref = await remoteComms.redeemLocalOcapURL(ocapURL);
      expect(kref).toBe('ko1');

      await remoteComms.sendRemoteMessage('elsewhere', 'your message here');
      expect(mockPlatformServices.sendRemoteMessage).toHaveBeenCalledWith(
        'elsewhere',
        'your message here',
      );

      await remoteComms.sendRemoteMessage('peer1', 'msg');
      expect(mockPlatformServices.sendRemoteMessage).toHaveBeenCalledWith(
        'peer1',
        'msg',
      );
    });

    it('honors pre-existing comms initialization parameters when present', async () => {
      const mockPeerId = 'mockPeerId';
      const mockKeySeed = 'abcdef';
      const mockOcapURLKey = 'mockOcapURLKey';
      mockKernelStore.setRemoteIdentityValue('peerId', mockPeerId);
      mockKernelStore.setRemoteIdentityValue('keySeed', mockKeySeed);
      mockKernelStore.setRemoteIdentityValue('ocapURLKey', mockOcapURLKey);
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );
      expect(remoteComms).toHaveProperty('getPeerId');
      expect(remoteComms).toHaveProperty('issueOcapURL');
      expect(remoteComms).toHaveProperty('redeemLocalOcapURL');
      expect(remoteComms).toHaveProperty('sendRemoteMessage');
      expect(remoteComms).toHaveProperty('registerLocationHints');
      expect(mockKernelStore.getRemoteIdentityValue('peerId')).toBe(mockPeerId);
      expect(remoteComms.getPeerId()).toBe(mockPeerId);
      expect(mockKernelStore.getRemoteIdentityValue('keySeed')).toBe(
        mockKeySeed,
      );
      expect(mockKernelStore.getRemoteIdentityValue('ocapURLKey')).toBe(
        mockOcapURLKey,
      );
    });

    it('passes options object to platformServices.initializeRemoteComms', async () => {
      const options = {
        relays: ['/dns4/relay.example/tcp/443/wss/p2p/relay'],
        maxRetryAttempts: 5,
        maxQueue: 100,
      };
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        options,
      );
      expect(mockPlatformServices.initializeRemoteComms).toHaveBeenCalledWith(
        expect.any(String), // keySeed
        expect.objectContaining({
          relays: options.relays,
          maxRetryAttempts: options.maxRetryAttempts,
          maxQueue: options.maxQueue,
        }),
        mockRemoteMessageHandler,
        undefined, // onRemoteGiveUp
        undefined, // incarnationId
        undefined, // onIncarnationChange
      );
    });

    it('uses stored relays when options.relays is empty', async () => {
      const storedRelays = [
        '/dns4/stored-relay1.example/tcp/443/wss/p2p/relay1',
        '/dns4/stored-relay2.example/tcp/443/wss/p2p/relay2',
      ];
      mockKernelStore.setRelayEntries(makeLearnedRelayEntries(storedRelays));
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {}, // empty options
      );
      expect(mockPlatformServices.initializeRemoteComms).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          relays: storedRelays,
        }),
        mockRemoteMessageHandler,
        undefined,
        undefined, // incarnationId
        undefined, // onIncarnationChange
      );
    });

    it('passes onRemoteGiveUp callback to platformServices', async () => {
      const onRemoteGiveUp = vi.fn();
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {},
        undefined, // logger
        undefined, // keySeed
        onRemoteGiveUp,
      );
      expect(mockPlatformServices.initializeRemoteComms).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        mockRemoteMessageHandler,
        onRemoteGiveUp,
        undefined, // incarnationId
        undefined, // onIncarnationChange
      );
    });

    it('passes incarnationId to platformServices', async () => {
      const incarnationId = 'test-incarnation-id';
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {},
        undefined, // logger
        undefined, // keySeed
        undefined, // onRemoteGiveUp
        incarnationId,
      );
      expect(mockPlatformServices.initializeRemoteComms).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        mockRemoteMessageHandler,
        undefined,
        incarnationId,
        undefined, // onIncarnationChange
      );
    });

    it('passes onIncarnationChange callback to platformServices', async () => {
      const onIncarnationChange = vi.fn();
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {},
        undefined, // logger
        undefined, // keySeed
        undefined, // onRemoteGiveUp
        undefined, // incarnationId
        onIncarnationChange,
      );
      expect(mockPlatformServices.initializeRemoteComms).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        mockRemoteMessageHandler,
        undefined,
        undefined, // incarnationId
        onIncarnationChange,
      );
    });

    it('uses provided keySeed when creating new peer', async () => {
      const providedKeySeed =
        '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {},
        undefined,
        providedKeySeed,
      );
      expect(mockKernelStore.getRemoteIdentityValue('keySeed')).toBe(
        providedKeySeed,
      );
      const peerId = mockKernelStore.getRemoteIdentityValue('peerId');
      expect(peerId).toBeDefined();
      // Verify peerId matches the provided keySeed
      const keyPair = await generateKeyPairFromSeed(
        'Ed25519',
        fromHex(providedKeySeed),
      );
      expect(peerId).toBe(peerIdFromPrivateKey(keyPair).toString());
    });

    it('calls logger.log when existing peer id is found', async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };
      const mockPeerId = 'existing-peer-id';
      const mockKeySeed = 'abcdef';
      mockKernelStore.setRemoteIdentityValue('peerId', mockPeerId);
      mockKernelStore.setRemoteIdentityValue('keySeed', mockKeySeed);
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {},
        mockLogger as unknown as Logger,
      );
      expect(mockLogger.log).toHaveBeenCalledWith(
        `comms init: existing peer id: ${mockPeerId}`,
      );
    });

    it('calls logger.log when new peer id is created', async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {},
        mockLogger as unknown as Logger,
      );
      const peerId = mockKernelStore.getRemoteIdentityValue('peerId');
      expect(mockLogger.log).toHaveBeenCalledWith(
        `comms init: new peer id: ${peerId}`,
      );
    });

    it('calls logger.log with relays', async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };
      const testRelays = ['/dns4/relay.example/tcp/443/wss/p2p/relay'];
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { relays: testRelays },
        mockLogger as unknown as Logger,
      );
      expect(mockLogger.log).toHaveBeenCalledWith(
        `relays: ${JSON.stringify(testRelays)}`,
      );
    });

    it('saves relays to KV store when provided', async () => {
      const testRelays = [
        '/dns4/relay1.example/tcp/443/wss/p2p/relay1',
        '/dns4/relay2.example/tcp/443/wss/p2p/relay2',
      ];
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { relays: testRelays },
      );
      expect(mockKernelStore.getKnownRelayAddresses()).toStrictEqual(
        testRelays,
      );
    });

    it('does not save relays to KV store when empty', async () => {
      const storedRelays = ['/dns4/stored-relay.example/tcp/443/wss/p2p/relay'];
      mockKernelStore.setRelayEntries(makeLearnedRelayEntries(storedRelays));
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {}, // empty relays
      );
      // Should not overwrite existing relays
      expect(mockKernelStore.getKnownRelayAddresses()).toStrictEqual(
        storedRelays,
      );
    });
  });

  describe('initRemoteIdentity', () => {
    it('creates identity with expected keys/methods and stores state in KV', async () => {
      const result = await initRemoteIdentity(mockKernelStore);

      expect(result.identity).toHaveProperty('getPeerId');
      expect(result.identity).toHaveProperty('issueOcapURL');
      expect(result.identity).toHaveProperty('redeemLocalOcapURL');

      const keySeed = mockKernelStore.getRemoteIdentityValue('keySeed');
      expect(keySeed).toBe(
        '0100000000000000000000000000000000000000000000000000000000000000',
      );
      expect(result.keySeed).toBe(keySeed);

      const ocapURLKey = mockKernelStore.getRemoteIdentityValue('ocapURLKey');
      expect(ocapURLKey).toBe(
        '0200000000000000000000000000000000000000000000000000000000000000',
      );

      const peerId = mockKernelStore.getRemoteIdentityValue('peerId');
      const keyPair = await generateKeyPairFromSeed(
        'Ed25519',
        fromHex(keySeed as string),
      );
      expect(peerId).toBe(peerIdFromPrivateKey(keyPair).toString());
      expect(result.identity.getPeerId()).toBe(peerId);
    });

    it('does not require platformServices or messageHandler', async () => {
      // initRemoteIdentity only needs kernelStore - no network dependencies
      const result = await initRemoteIdentity(mockKernelStore);
      expect(result.identity.getPeerId()).toBeDefined();
    });

    it('roundtrips issueOcapURL and redeemLocalOcapURL', async () => {
      const { identity } = await initRemoteIdentity(mockKernelStore);

      const ocapURL = await identity.issueOcapURL('ko42' as KRef);
      const kref = await identity.redeemLocalOcapURL(ocapURL);
      expect(kref).toBe('ko42');
    });

    it('reuses existing identity from KV', async () => {
      const result1 = await initRemoteIdentity(mockKernelStore);
      const peerId1 = result1.identity.getPeerId();

      const result2 = await initRemoteIdentity(mockKernelStore);
      const peerId2 = result2.identity.getPeerId();

      expect(peerId1).toBe(peerId2);
      expect(result1.keySeed).toBe(result2.keySeed);
    });

    it('includes relays in issued URLs when provided', async () => {
      const testRelays = [
        '/dns4/relay1.example.com/tcp/443/wss/p2p-circuit',
        '/dns4/relay2.example.com/tcp/443/wss/p2p-circuit',
      ];
      const { identity } = await initRemoteIdentity(mockKernelStore, {
        relays: testRelays,
      });

      const ocapURL = await identity.issueOcapURL('ko1' as KRef);
      const { hints } = parseOcapURL(ocapURL);
      expect(hints).toStrictEqual(testRelays);
    });

    it('returns keySeed and knownRelays', async () => {
      const testRelays = ['/dns4/relay.example/tcp/443/wss/p2p/relay'];
      const result = await initRemoteIdentity(mockKernelStore, {
        relays: testRelays,
      });

      expect(result.keySeed).toBeDefined();
      expect(result.knownRelays).toStrictEqual(testRelays);
    });

    it('addKnownRelays persists new relays to KV (deduplicated)', async () => {
      const initialRelays = ['/dns4/relay1.example/tcp/443/wss/p2p-circuit'];
      const { identity } = await initRemoteIdentity(mockKernelStore, {
        relays: initialRelays,
      });

      identity.addKnownRelays([
        '/dns4/relay2.example/tcp/443/wss/p2p-circuit',
        '/dns4/relay1.example/tcp/443/wss/p2p-circuit', // duplicate
      ]);

      const stored = mockKernelStore.getKnownRelayAddresses();
      expect(stored).toStrictEqual([
        '/dns4/relay1.example/tcp/443/wss/p2p-circuit',
        '/dns4/relay2.example/tcp/443/wss/p2p-circuit',
      ]);
    });

    it('issueOcapURL embeds newly added relays', async () => {
      const { identity } = await initRemoteIdentity(mockKernelStore);

      // No relays initially
      const url1 = await identity.issueOcapURL('ko1' as KRef);
      expect(parseOcapURL(url1).hints).toStrictEqual([]);

      // Add relays dynamically
      const newRelays = ['/dns4/relay.example/tcp/443/wss/p2p-circuit'];
      identity.addKnownRelays(newRelays);

      // Subsequent URL embeds the new relay
      const url2 = await identity.issueOcapURL('ko2' as KRef);
      expect(parseOcapURL(url2).hints).toStrictEqual(newRelays);
    });

    it('addKnownRelays does nothing when given empty array', async () => {
      const initialRelays = ['/dns4/relay1.example/tcp/443/wss/p2p-circuit'];
      const { identity } = await initRemoteIdentity(mockKernelStore, {
        relays: initialRelays,
      });

      identity.addKnownRelays([]);

      const stored = mockKernelStore.getKnownRelayAddresses();
      expect(stored).toStrictEqual(initialRelays);
    });

    it('issueOcapURL caps relay hints to DEFAULT_MAX_URL_RELAY_HINTS', async () => {
      const relays = Array.from(
        { length: DEFAULT_MAX_URL_RELAY_HINTS + 3 },
        (_, i) => `/dns4/relay${i}.example/tcp/443/wss/p2p-circuit`,
      );
      const { identity } = await initRemoteIdentity(mockKernelStore, {
        relays,
      });

      const ocapURL = await identity.issueOcapURL('ko1' as KRef);
      const { hints } = parseOcapURL(ocapURL);
      expect(hints).toHaveLength(DEFAULT_MAX_URL_RELAY_HINTS);
    });

    it('issueOcapURL prefers bootstrap relays over learned relays', async () => {
      const bootstrapRelays = [
        '/dns4/bootstrap1.example/tcp/443/wss/p2p-circuit',
        '/dns4/bootstrap2.example/tcp/443/wss/p2p-circuit',
      ];
      const { identity } = await initRemoteIdentity(mockKernelStore, {
        relays: bootstrapRelays,
      });

      // Add many learned relays (more recent lastSeen)
      const learnedRelays = Array.from(
        { length: 5 },
        (_, i) => `/dns4/learned${i}.example/tcp/443/wss/p2p-circuit`,
      );
      identity.addKnownRelays(learnedRelays);

      const ocapURL = await identity.issueOcapURL('ko1' as KRef);
      const { hints } = parseOcapURL(ocapURL);
      expect(hints).toHaveLength(DEFAULT_MAX_URL_RELAY_HINTS);
      // Bootstrap relays should be included ahead of learned relays
      for (const bootstrap of bootstrapRelays) {
        expect(hints).toContain(bootstrap);
      }
    });

    it('addKnownRelays enforces DEFAULT_MAX_KNOWN_RELAYS pool cap', async () => {
      const { identity } = await initRemoteIdentity(mockKernelStore);

      // Add more relays than the cap
      const relays = Array.from(
        { length: DEFAULT_MAX_KNOWN_RELAYS + 5 },
        (_, i) => `/dns4/relay${i}.example/tcp/443/wss/p2p-circuit`,
      );
      identity.addKnownRelays(relays);

      const entries = mockKernelStore.getRelayEntries();
      expect(entries).toHaveLength(DEFAULT_MAX_KNOWN_RELAYS);
    });

    it('addKnownRelays evicts oldest non-bootstrap relays when pool is full', async () => {
      const bootstrapRelays = [
        '/dns4/bootstrap.example/tcp/443/wss/p2p-circuit',
      ];
      const { identity } = await initRemoteIdentity(mockKernelStore, {
        relays: bootstrapRelays,
      });

      // Fill pool to the cap
      const fillerRelays = Array.from(
        { length: DEFAULT_MAX_KNOWN_RELAYS },
        (_, i) => `/dns4/relay${i}.example/tcp/443/wss/p2p-circuit`,
      );
      identity.addKnownRelays(fillerRelays);

      const entries = mockKernelStore.getRelayEntries();
      expect(entries).toHaveLength(DEFAULT_MAX_KNOWN_RELAYS);
      // Bootstrap relay must survive eviction
      expect(entries.some((entry) => entry.addr === bootstrapRelays[0])).toBe(
        true,
      );
    });

    it('addKnownRelays updates lastSeen on re-observed relays', async () => {
      const { identity } = await initRemoteIdentity(mockKernelStore);

      identity.addKnownRelays(['/dns4/relay.example/tcp/443/wss/p2p-circuit']);
      const firstSeen = mockKernelStore.getRelayEntries()[0]?.lastSeen ?? 0;

      // SES lockdown freezes Date, preventing vi.useFakeTimers(); use a
      // real delay to guarantee a different Date.now() value.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      identity.addKnownRelays(['/dns4/relay.example/tcp/443/wss/p2p-circuit']);
      const secondSeen = mockKernelStore.getRelayEntries()[0]?.lastSeen ?? 0;

      expect(secondSeen).toBeGreaterThan(firstSeen);
    });

    it('addKnownRelays does not add duplicate entries on re-observation', async () => {
      const { identity } = await initRemoteIdentity(mockKernelStore);

      const relay = '/dns4/relay.example/tcp/443/wss/p2p-circuit';
      identity.addKnownRelays([relay]);
      expect(mockKernelStore.getRelayEntries()).toHaveLength(1);

      // Re-add the same relay — entry count must stay at 1
      identity.addKnownRelays([relay, relay]);
      expect(mockKernelStore.getRelayEntries()).toHaveLength(1);
      expect(mockKernelStore.getRelayEntries()[0]?.addr).toBe(relay);
    });

    it('init clears bootstrap flag on relays removed from the bootstrap set', async () => {
      await initRemoteIdentity(mockKernelStore, {
        relays: ['/dns4/relayA.example/tcp/443/wss/p2p-circuit'],
      });

      // Re-init with a different bootstrap set
      await initRemoteIdentity(mockKernelStore, {
        relays: ['/dns4/relayB.example/tcp/443/wss/p2p-circuit'],
      });

      const entries = mockKernelStore.getRelayEntries();
      expect(
        entries.find((entry) => entry.addr.includes('relayA'))?.isBootstrap,
      ).toBe(false);
      expect(
        entries.find((entry) => entry.addr.includes('relayB'))?.isBootstrap,
      ).toBe(true);
    });

    it('init enforces DEFAULT_MAX_KNOWN_RELAYS pool cap', async () => {
      // Pre-seed DEFAULT_MAX_KNOWN_RELAYS learned relays
      mockKernelStore.setRelayEntries(
        Array.from({ length: DEFAULT_MAX_KNOWN_RELAYS }, (_, i) => ({
          addr: `/dns4/learned${i}.example/tcp/443/wss/p2p-circuit`,
          lastSeen: 100,
          isBootstrap: false,
        })),
      );

      const bootstrapRelays = Array.from(
        { length: 5 },
        (_, i) => `/dns4/bootstrap${i}.example/tcp/443/wss/p2p-circuit`,
      );
      await initRemoteIdentity(mockKernelStore, { relays: bootstrapRelays });

      const entries = mockKernelStore.getRelayEntries();
      expect(entries).toHaveLength(DEFAULT_MAX_KNOWN_RELAYS);
      // All bootstrap relays must survive
      for (const addr of bootstrapRelays) {
        expect(entries.some((entry) => entry.addr === addr)).toBe(true);
      }
    });

    it('init marks bootstrap relays and preserves learned relays', async () => {
      // Pre-seed a learned relay
      mockKernelStore.setRelayEntries([
        {
          addr: '/dns4/learned.example/tcp/443/wss/p2p-circuit',
          lastSeen: 100,
          isBootstrap: false,
        },
      ]);

      const bootstrapRelays = [
        '/dns4/bootstrap.example/tcp/443/wss/p2p-circuit',
      ];
      await initRemoteIdentity(mockKernelStore, {
        relays: bootstrapRelays,
      });

      const entries = mockKernelStore.getRelayEntries();
      expect(entries).toHaveLength(2);
      expect(
        entries.find((entry) => entry.addr === bootstrapRelays[0])?.isBootstrap,
      ).toBe(true);
      expect(
        entries.find(
          (entry) =>
            entry.addr === '/dns4/learned.example/tcp/443/wss/p2p-circuit',
        )?.isBootstrap,
      ).toBe(false);
    });

    it('logs when bootstrap relay count exceeds maxKnownRelays', async () => {
      const mockLogger = { log: vi.fn(), error: vi.fn() };
      const relays = Array.from(
        { length: 5 },
        (_, i) => `/dns4/bootstrap${i}.example/tcp/443/wss/p2p-circuit`,
      );
      await initRemoteIdentity(
        mockKernelStore,
        { relays, maxKnownRelays: 3 },
        mockLogger as unknown as Logger,
      );
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'bootstrap relay count (5) exceeds maxKnownRelays (3)',
        ),
      );
    });

    it('logs eviction count when pool cap is exceeded during init', async () => {
      const mockLogger = { log: vi.fn(), error: vi.fn() };
      mockKernelStore.setRelayEntries(
        Array.from({ length: 20 }, (_, i) => ({
          addr: `/dns4/learned${i}.example/tcp/443/wss/p2p-circuit`,
          lastSeen: 100,
          isBootstrap: false,
        })),
      );
      await initRemoteIdentity(
        mockKernelStore,
        {
          relays: ['/dns4/bootstrap.example/tcp/443/wss/p2p-circuit'],
          maxKnownRelays: 10,
        },
        mockLogger as unknown as Logger,
      );
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('evicted'),
      );
    });

    it('sorts same-tier relays by lastSeen descending in URL hints', async () => {
      mockKernelStore.setRelayEntries([
        {
          addr: '/dns4/relay-old.example/tcp/443/wss/p2p-circuit',
          lastSeen: 100,
          isBootstrap: false,
        },
        {
          addr: '/dns4/relay-new.example/tcp/443/wss/p2p-circuit',
          lastSeen: 300,
          isBootstrap: false,
        },
        {
          addr: '/dns4/relay-mid.example/tcp/443/wss/p2p-circuit',
          lastSeen: 200,
          isBootstrap: false,
        },
      ]);
      const { identity } = await initRemoteIdentity(mockKernelStore);
      const ocapURL = await identity.issueOcapURL('ko1' as KRef);
      const { hints } = parseOcapURL(ocapURL);
      expect(hints).toStrictEqual([
        '/dns4/relay-new.example/tcp/443/wss/p2p-circuit',
        '/dns4/relay-mid.example/tcp/443/wss/p2p-circuit',
        '/dns4/relay-old.example/tcp/443/wss/p2p-circuit',
      ]);
    });

    it('respects custom maxUrlRelayHints option', async () => {
      const relays = Array.from(
        { length: 10 },
        (_, i) => `/dns4/relay${i}.example/tcp/443/wss/p2p-circuit`,
      );
      const { identity } = await initRemoteIdentity(mockKernelStore, {
        relays,
        maxUrlRelayHints: 5,
      });
      const ocapURL = await identity.issueOcapURL('ko1' as KRef);
      const { hints } = parseOcapURL(ocapURL);
      expect(hints).toHaveLength(5);
    });

    it('respects custom maxKnownRelays option', async () => {
      const { identity } = await initRemoteIdentity(mockKernelStore, {
        maxKnownRelays: 5,
      });
      const relays = Array.from(
        { length: 10 },
        (_, i) => `/dns4/relay${i}.example/tcp/443/wss/p2p-circuit`,
      );
      identity.addKnownRelays(relays);
      expect(mockKernelStore.getRelayEntries()).toHaveLength(5);
    });

    it('addKnownRelays logs eviction when pool cap is exceeded', async () => {
      const mockLogger = { log: vi.fn(), error: vi.fn() };
      const { identity } = await initRemoteIdentity(
        mockKernelStore,
        { maxKnownRelays: 5 },
        mockLogger as unknown as Logger,
      );
      const relays = Array.from(
        { length: 10 },
        (_, i) => `/dns4/relay${i}.example/tcp/443/wss/p2p-circuit`,
      );
      identity.addKnownRelays(relays);
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('evicted'),
      );
    });

    it('init truncates pool when bootstrap count exceeds maxKnownRelays', async () => {
      const bootstrapRelays = Array.from(
        { length: 5 },
        (_, i) => `/dns4/bootstrap${i}.example/tcp/443/wss/p2p-circuit`,
      );
      await initRemoteIdentity(mockKernelStore, {
        relays: bootstrapRelays,
        maxKnownRelays: 3,
      });

      const entries = mockKernelStore.getRelayEntries();
      // Pool must be capped at maxKnownRelays even when all entries are bootstrap
      expect(entries).toHaveLength(3);
      // All surviving entries should still be marked as bootstrap
      expect(entries.every((entry) => entry.isBootstrap)).toBe(true);
    });

    it('issueOcapURL includes all relays when count equals maxUrlRelayHints', async () => {
      const relays = Array.from(
        { length: DEFAULT_MAX_URL_RELAY_HINTS },
        (_, i) => `/dns4/relay${i}.example/tcp/443/wss/p2p-circuit`,
      );
      const { identity } = await initRemoteIdentity(mockKernelStore, {
        relays,
      });
      const ocapURL = await identity.issueOcapURL('ko1' as KRef);
      const { hints } = parseOcapURL(ocapURL);
      expect(hints).toHaveLength(DEFAULT_MAX_URL_RELAY_HINTS);
      expect(hints).toStrictEqual(relays);
    });

    it.each([
      ['maxUrlRelayHints', { maxUrlRelayHints: 0 }],
      ['maxUrlRelayHints', { maxUrlRelayHints: 1.5 }],
      ['maxUrlRelayHints', { maxUrlRelayHints: -1 }],
      ['maxKnownRelays', { maxKnownRelays: 0 }],
      ['maxKnownRelays', { maxKnownRelays: 1.5 }],
      ['maxKnownRelays', { maxKnownRelays: -1 }],
    ] as const)(
      'throws when %s is not a positive integer (%o)',
      async (_label, opts) => {
        await expect(initRemoteIdentity(mockKernelStore, opts)).rejects.toThrow(
          /must be positive integers/u,
        );
      },
    );

    it('throws with mnemonic when identity already exists', async () => {
      mockKernelStore.setRemoteIdentityValue('peerId', 'existing-peer-id');
      mockKernelStore.setRemoteIdentityValue(
        'keySeed',
        'abcdef1234567890abcdef1234567890',
      );

      await expect(
        initRemoteIdentity(mockKernelStore, {
          mnemonic:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        }),
      ).rejects.toThrow(
        'Cannot use mnemonic: kernel identity already exists. Use resetStorage to clear existing identity first.',
      );
    });

    it('rejects wrong host in redeemLocalOcapURL', async () => {
      const { identity } = await initRemoteIdentity(mockKernelStore);

      const wrongHostURL = 'ocap:someoid@different-peer-id';
      await expect(identity.redeemLocalOcapURL(wrongHostURL)).rejects.toThrow(
        "ocapURL from a host that's not me",
      );
    });
  });

  describe('registerLocationHints', () => {
    it('calls platformServices.registerLocationHints', async () => {
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );
      await remoteComms.registerLocationHints('peer123', ['hint1', 'hint2']);
      expect(mockPlatformServices.registerLocationHints).toHaveBeenCalledWith(
        'peer123',
        ['hint1', 'hint2'],
      );
    });

    it('is a bound function from platformServices', async () => {
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );
      expect(typeof remoteComms.registerLocationHints).toBe('function');
      await remoteComms.registerLocationHints('peer123', ['hint1', 'hint2']);
      expect(mockPlatformServices.registerLocationHints).toHaveBeenCalled();
    });
  });

  describe('parseOcapURL', () => {
    it('parses ocap URL into constituent parts', () => {
      let sampleOcapURL = 'ocap:oid@peerid';
      const partsNoHints = parseOcapURL(sampleOcapURL);
      expect(partsNoHints).toStrictEqual({
        oid: 'oid',
        host: 'peerid',
        hints: [],
      });
      sampleOcapURL += ',hint1';
      const partsOneHints = parseOcapURL(sampleOcapURL);
      expect(partsOneHints).toStrictEqual({
        oid: 'oid',
        host: 'peerid',
        hints: ['hint1'],
      });
      sampleOcapURL += ',hint2';
      const partsMultiHints = parseOcapURL(sampleOcapURL);
      expect(partsMultiHints).toStrictEqual({
        oid: 'oid',
        host: 'peerid',
        hints: ['hint1', 'hint2'],
      });
    });

    it('rejects unparseable URL', () => {
      expect(() => parseOcapURL('utter nonsense')).toThrow('unparseable URL');
    });

    it('rejects bad ocap URL scheme', () => {
      expect(() => parseOcapURL('yuck:oid@peerid')).toThrow('not an ocap URL');
    });

    it.each([
      ['ocap:oid', 'missing @ separator'],
      ['ocap:oid@peerid@another', 'multiple @ separators'],
      ['ocap:oid@,peerless', 'empty host'],
      ['ocap:@peerid', 'empty oid'],
      ['ocap:oid@', 'empty where part'],
    ])('rejects badly formatted ocap URL: %s', (url, _description) => {
      expect(() => parseOcapURL(url)).toThrow('bad ocap URL');
    });
  });

  describe('edge cases and error handling', () => {
    it('handles redeemLocalOcapURL with wrong host', async () => {
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );

      const wrongHostURL = 'ocap:someoid@different-peer-id';

      await expect(
        remoteComms.redeemLocalOcapURL(wrongHostURL),
      ).rejects.toThrow("ocapURL from a host that's not me");
    });

    it('handles redeemLocalOcapURL with decryption errors', async () => {
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );

      // First create a valid URL
      const validURL = await remoteComms.issueOcapURL('ko42' as KRef);
      const peerId = remoteComms.getPeerId();

      // Then corrupt the encrypted part while keeping valid base58btc format
      // Take the valid oid and modify it slightly to make decryption fail
      const { oid } = parseOcapURL(validURL);
      const corruptedOid = `${oid.slice(0, -5)}zzzzz`; // Change last 5 chars
      const corruptedURL = `ocap:${corruptedOid}@${peerId}`;

      await expect(
        remoteComms.redeemLocalOcapURL(corruptedURL),
      ).rejects.toThrow('ocapURL has bad object reference');
    });

    it('calls logger.error when decryption fails', async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {},
        mockLogger as unknown as Logger,
      );

      const validURL = await remoteComms.issueOcapURL('ko42' as KRef);
      const peerId = remoteComms.getPeerId();
      const { oid } = parseOcapURL(validURL);
      const corruptedOid = `${oid.slice(0, -5)}zzzzz`;
      const corruptedURL = `ocap:${corruptedOid}@${peerId}`;

      await expect(
        remoteComms.redeemLocalOcapURL(corruptedURL),
      ).rejects.toThrow('ocapURL has bad object reference');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'problem deciphering encoded kref: ',
        expect.any(Error),
      );
    });

    it('handles issueOcapURL with short kref', async () => {
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );

      const shortKref = 'ko1' as KRef;
      const ocapURL = await remoteComms.issueOcapURL(shortKref);
      const kref = await remoteComms.redeemLocalOcapURL(ocapURL);
      expect(kref).toBe(shortKref);
    });

    it('handles issueOcapURL with long kref', async () => {
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );

      const longKref = `ko${'1'.repeat(100)}` as KRef;
      const ocapURL = await remoteComms.issueOcapURL(longKref);
      const kref = await remoteComms.redeemLocalOcapURL(ocapURL);
      expect(kref).toBe(longKref);
    });

    it('includes knownRelays in issued ocap URLs', async () => {
      const testRelays = [
        '/dns4/relay1.example/tcp/443/wss/p2p/relay1',
        '/dns4/relay2.example/tcp/443/wss/p2p/relay2',
      ];
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { relays: testRelays },
      );

      const ocapURL = await remoteComms.issueOcapURL('ko42' as KRef);
      const { hints } = parseOcapURL(ocapURL);
      expect(hints).toStrictEqual(testRelays);
    });

    it('includes stored relays in issued ocap URLs when options.relays is empty', async () => {
      const storedRelays = [
        '/dns4/stored-relay1.example/tcp/443/wss/p2p/relay1',
        '/dns4/stored-relay2.example/tcp/443/wss/p2p/relay2',
      ];
      mockKernelStore.setRelayEntries(makeLearnedRelayEntries(storedRelays));
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {},
      );

      const ocapURL = await remoteComms.issueOcapURL('ko42' as KRef);
      const { hints } = parseOcapURL(ocapURL);
      expect(hints).toStrictEqual(storedRelays);
    });
  });

  describe('cross-incarnation wake detection', () => {
    it('resets backoffs when wake is detected', async () => {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1_000;
      mockKernelDatabase.kernelKVStore.set(
        'lastActiveTime',
        String(twoHoursAgo),
      );

      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );

      expect(mockPlatformServices.resetAllBackoffs).toHaveBeenCalledOnce();
    });

    it('does not reset backoffs when no lastActiveTime exists', async () => {
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );

      expect(mockPlatformServices.resetAllBackoffs).not.toHaveBeenCalled();
    });

    it('does not reset backoffs when gap is within threshold', async () => {
      const tenMinutesAgo = Date.now() - 10 * 60 * 1_000;
      mockKernelDatabase.kernelKVStore.set(
        'lastActiveTime',
        String(tenMinutesAgo),
      );

      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );

      expect(mockPlatformServices.resetAllBackoffs).not.toHaveBeenCalled();
    });

    it('updates lastActiveTime after detection', async () => {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1_000;
      mockKernelDatabase.kernelKVStore.set(
        'lastActiveTime',
        String(twoHoursAgo),
      );

      const before = Date.now();
      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
      );
      const after = Date.now();

      const stored = mockKernelDatabase.kernelKVStore.get('lastActiveTime');
      expect(stored).toBeDefined();
      const timestamp = Number(stored);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it('logs when wake is detected', async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1_000;
      mockKernelDatabase.kernelKVStore.set(
        'lastActiveTime',
        String(twoHoursAgo),
      );

      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        {},
        mockLogger as unknown as Logger,
      );

      expect(mockLogger.log).toHaveBeenCalledWith(
        'Cross-incarnation wake detected, resetting backoffs',
      );
    });
  });

  describe('initRemoteComms with mnemonic option', () => {
    // Valid 12-word test mnemonic
    const VALID_12_WORD_MNEMONIC =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    // Valid 24-word test mnemonic
    const VALID_24_WORD_MNEMONIC =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

    it('uses mnemonic to derive seed when provided', async () => {
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { mnemonic: VALID_12_WORD_MNEMONIC },
      );

      const keySeed = mockKernelStore.getRemoteIdentityValue('keySeed');
      expect(keySeed).toBeDefined();
      // The seed should be derived from the mnemonic
      const expectedSeed = await mnemonicToSeed(VALID_12_WORD_MNEMONIC);
      expect(keySeed).toBe(expectedSeed);

      // Verify peerId matches the derived seed
      const peerId = remoteComms.getPeerId();
      const keyPair = await generateKeyPairFromSeed(
        'Ed25519',
        fromHex(expectedSeed),
      );
      expect(peerId).toBe(peerIdFromPrivateKey(keyPair).toString());
    });

    it('produces same peer ID for same mnemonic', async () => {
      // First init with mnemonic
      const remoteComms1 = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { mnemonic: VALID_12_WORD_MNEMONIC },
      );
      const peerId1 = remoteComms1.getPeerId();

      // Reset store
      mockKernelDatabase.kernelKVStore.delete('peerId');
      mockKernelDatabase.kernelKVStore.delete('keySeed');
      mockKernelDatabase.kernelKVStore.delete('ocapURLKey');

      // Second init with same mnemonic
      const remoteComms2 = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { mnemonic: VALID_12_WORD_MNEMONIC },
      );
      const peerId2 = remoteComms2.getPeerId();

      expect(peerId1).toBe(peerId2);
    });

    it('throws error when mnemonic provided but peer ID already exists in store', async () => {
      // Set up existing peer ID
      const existingPeerId = 'existing-peer-id';
      const existingKeySeed = 'abcdef1234567890abcdef1234567890';
      mockKernelStore.setRemoteIdentityValue('peerId', existingPeerId);
      mockKernelStore.setRemoteIdentityValue('keySeed', existingKeySeed);

      await expect(
        initRemoteComms(
          mockKernelStore,
          mockPlatformServices,
          mockRemoteMessageHandler,
          { mnemonic: VALID_12_WORD_MNEMONIC },
        ),
      ).rejects.toThrow(
        'Cannot use mnemonic: kernel identity already exists. Use resetStorage to clear existing identity first.',
      );
    });

    it('logs mnemonic usage when provided', async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };

      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { mnemonic: VALID_12_WORD_MNEMONIC },
        mockLogger as unknown as Logger,
      );

      expect(mockLogger.log).toHaveBeenCalledWith(
        'comms init: using mnemonic for seed recovery',
      );
    });

    it('throws for invalid mnemonic', async () => {
      await expect(
        initRemoteComms(
          mockKernelStore,
          mockPlatformServices,
          mockRemoteMessageHandler,
          { mnemonic: 'invalid mnemonic phrase' },
        ),
      ).rejects.toThrow('Invalid BIP39 mnemonic');
    });

    it('works with 24-word mnemonic', async () => {
      const remoteComms = await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { mnemonic: VALID_24_WORD_MNEMONIC },
      );

      const keySeed = mockKernelStore.getRemoteIdentityValue('keySeed');
      expect(keySeed).toBeDefined();
      const expectedSeed = await mnemonicToSeed(VALID_24_WORD_MNEMONIC);
      expect(keySeed).toBe(expectedSeed);
      expect(remoteComms.getPeerId()).toBeDefined();
    });

    it('mnemonic option takes precedence over keySeed parameter', async () => {
      const providedKeySeed =
        '9999999999999999999999999999999999999999999999999999999999999999';

      await initRemoteComms(
        mockKernelStore,
        mockPlatformServices,
        mockRemoteMessageHandler,
        { mnemonic: VALID_12_WORD_MNEMONIC },
        undefined,
        providedKeySeed, // This should be ignored in favor of mnemonic
      );

      const storedKeySeed = mockKernelStore.getRemoteIdentityValue('keySeed');
      const expectedSeed = await mnemonicToSeed(VALID_12_WORD_MNEMONIC);
      expect(storedKeySeed).toBe(expectedSeed);
      expect(storedKeySeed).not.toBe(providedKeySeed);
    });
  });
});
