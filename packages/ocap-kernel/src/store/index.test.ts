import type { KernelDatabase } from '@metamask/kernel-store';
import { describe, it, expect, beforeEach } from 'vitest';

import { makeKernelStore } from './index.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';
import type { RunQueueItem } from '../types.ts';

/**
 * Mock RunQueueItem: A stupid TS hack to allow trivial use of plain strings
 * as if they were RunQueueItems, since, for testing purposes here, all
 * that's necessary to be a "message" is to be stringifiable.
 *
 * @param str - A string.
 * @returns The same string coerced to type RunQueueItem.
 */
function tm(str: string): RunQueueItem {
  return str as unknown as RunQueueItem;
}

describe('kernel store', () => {
  let mockKernelDatabase: KernelDatabase;

  beforeEach(() => {
    mockKernelDatabase = makeMapKernelDatabase();
  });

  describe('initialization', () => {
    it('has a working KV store', () => {
      makeKernelStore(mockKernelDatabase);
      const kv = mockKernelDatabase.kernelKVStore;
      expect(kv.get('foo')).toBeUndefined();
      kv.set('foo', 'some value');
      expect(kv.get('foo')).toBe('some value');
      kv.delete('foo');
      expect(kv.get('foo')).toBeUndefined();
      expect(() => kv.getRequired('foo')).toThrow(
        'No value found for key foo.',
      );
    });
    it('has all the expected parts', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      expect(Object.keys(ks).sort()).toStrictEqual([
        'addAnonymousKernelObject',
        'addCListEntry',
        'addGCActions',
        'addPromiseSubscriber',
        'addSubcluster',
        'addSubclusterVat',
        'allocateErefForKref',
        'assertRefCountsIfAuditing',
        'auditRefCounts',
        'beginOutOfCrank',
        'bufferCrankOutput',
        'cleanupOrphanMessages',
        'cleanupTerminatedVat',
        'clear',
        'clearEmptySubclusters',
        'clearReachableFlag',
        'clearRemoteSeqState',
        'collectGarbage',
        'createCrankSavepoint',
        'createSavepoint',
        'decRefCount',
        'decrementRefCount',
        'deleteCListEntry',
        'deleteEndpoint',
        'deleteKernelObject',
        'deleteKernelPromise',
        'deleteKernelServiceKref',
        'deletePendingMessage',
        'deleteRemoteInfo',
        'deleteRemotePendingState',
        'deleteSubcluster',
        'deleteSubclusterVat',
        'deleteSystemSubclusterMapping',
        'deleteVat',
        'deleteVatConfig',
        'dequeueRun',
        'detectWake',
        'endCrank',
        'endOutOfCrank',
        'enqueuePromiseMessage',
        'enqueueRun',
        'erefToKref',
        'exportFromEndpoint',
        'flushCrankBuffer',
        'forgetEndpointImports',
        'forgetEref',
        'forgetKref',
        'forgetTerminatedVat',
        'formatRefCountViolations',
        'getAllRemoteRecords',
        'getAllSystemSubclusterMappings',
        'getAllVatRecords',
        'getAnonymousKernelObjects',
        'getGCActions',
        'getImporters',
        'getKernelPromise',
        'getKernelPromiseMessageQueue',
        'getKernelServiceKref',
        'getKnownRelayAddresses',
        'getKpidsToRetire',
        'getNextObjectId',
        'getNextPromiseId',
        'getNextRemoteId',
        'getNextVatId',
        'getObjectRefCount',
        'getOcapURLIssuanceCount',
        'getOcapURLObjects',
        'getOwner',
        'getPeerIncarnation',
        'getPendingMessage',
        'getPinCount',
        'getPinnedObjects',
        'getPromisesByDecider',
        'getQueueLength',
        'getReachableAndVatSlot',
        'getReachableFlag',
        'getRefCount',
        'getRelayEntries',
        'getRemoteIdentityValue',
        'getRemoteIdentityValueRequired',
        'getRemoteIds',
        'getRemoteInfo',
        'getRemoteSeqState',
        'getRootObject',
        'getSubcluster',
        'getSubclusterVats',
        'getSubclusters',
        'getSystemSubclusterMapping',
        'getTerminatedVats',
        'getVatConfig',
        'getVatIDs',
        'getVatSubcluster',
        'hasCListEntry',
        'importsKernelSlot',
        'incRefCount',
        'incrementRefCount',
        'initEndpoint',
        'initKernelObject',
        'initKernelPromise',
        'invertRRef',
        'isInCrank',
        'isInitialized',
        'isObjectPinned',
        'isRevoked',
        'isRootObject',
        'isVatActive',
        'isVatTerminated',
        'kernelRefExists',
        'krefToEref',
        'krefsToErefs',
        'makeVatStore',
        'markInitialized',
        'markVatAsTerminated',
        'nextReapAction',
        'nextTerminatedVatCleanup',
        'orphanKernelObject',
        'outOfCrankWorkPending',
        'pinObject',
        'provideIncarnationId',
        'recomputeRefCounts',
        'recordLastActiveTime',
        'releaseAllSavepoints',
        'releaseOcapURLRetentions',
        'releaseSavepoint',
        'removeAnonymousKernelObject',
        'removeVatFromSubcluster',
        'reset',
        'resolveKernelPromise',
        'retainForOcapURL',
        'retireKernelObjects',
        'revoke',
        'rollbackCrank',
        'rollbackSavepoint',
        'runQueueLength',
        'scheduleReap',
        'setGCActions',
        'setKernelServiceKref',
        'setObjectRefCount',
        'setPeerIncarnation',
        'setPendingMessage',
        'setPromiseDecider',
        'setReachableFlag',
        'setRefCountAuditing',
        'setRelayEntries',
        'setRemoteHighestReceivedSeq',
        'setRemoteIdentityValue',
        'setRemoteInfo',
        'setRemoteNextSendSeq',
        'setRemoteStartSeq',
        'setRevoked',
        'setSystemSubclusterMapping',
        'setVatConfig',
        'startCrank',
        'translateCapDataEtoK',
        'translateCapDataKtoE',
        'translateMessageEtoK',
        'translateMessageKtoE',
        'translateRefEtoK',
        'translateRefKtoE',
        'translateSyscallVtoK',
        'undoOcapURLRetention',
        'unpinObject',
        'waitForCrank',
      ]);
    });
  });

  describe('kernel entity management', () => {
    it('generates IDs', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      expect(ks.getNextVatId()).toBe('v1');
      expect(ks.getNextVatId()).toBe('v2');
      expect(ks.getNextVatId()).toBe('v3');
      expect(ks.getNextRemoteId()).toBe('r1');
      expect(ks.getNextRemoteId()).toBe('r2');
      expect(ks.getNextRemoteId()).toBe('r3');
    });
    it('manages kernel objects', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const ko1Owner = 'v47';
      const ko2Owner = 'r23';
      expect(ks.initKernelObject(ko1Owner)).toBe('ko1');

      expect(ks.getObjectRefCount('ko1')).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });

      // Increment the reference count
      ks.incrementRefCount('ko1', 'test');
      expect(ks.getObjectRefCount('ko1')).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });

      // Increment again
      ks.incrementRefCount('ko1', 'test');
      expect(ks.getObjectRefCount('ko1')).toStrictEqual({
        reachable: 2,
        recognizable: 2,
      });

      ks.decrementRefCount('ko1', 'test');
      ks.decrementRefCount('ko1', 'test');
      expect(ks.getObjectRefCount('ko1')).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });

      // Create another object
      expect(ks.initKernelObject(ko2Owner)).toBe('ko2');

      // Check owners
      expect(ks.getOwner('ko1')).toBe(ko1Owner);
      expect(ks.getOwner('ko2')).toBe(ko2Owner);

      // Delete an object
      ks.deleteKernelObject('ko1');
      expect(ks.getOwner('ko1')).toBeUndefined();
      expect(ks.getOwner('ko99')).toBeUndefined();
    });
    it('manages kernel promises', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const kp1 = {
        state: 'unresolved',
        subscribers: [],
      };
      const kp2 = {
        state: 'unresolved',
        subscribers: [],
      };
      expect(ks.initKernelPromise()).toStrictEqual(['kp1', kp1]);
      expect(ks.getRefCount('kp1')).toBe(1);
      expect(ks.incRefCount('kp1')).toBe(2);
      ks.incRefCount('kp1');
      expect(ks.getRefCount('kp1')).toBe(3);
      expect(ks.decRefCount('kp1')).toBe(2);
      ks.decRefCount('kp1');
      ks.decRefCount('kp1');
      expect(ks.getRefCount('kp1')).toBe(0);
      expect(ks.initKernelPromise()).toStrictEqual(['kp2', kp2]);
      expect(ks.getKernelPromise('kp1')).toStrictEqual(kp1);
      expect(ks.getKernelPromise('kp2')).toStrictEqual(kp2);
      const msg1 = {
        methargs: {
          body: 'first message to kp1',
          slots: [],
        },
        result: null,
      };
      ks.enqueuePromiseMessage('kp1', msg1);
      const msg2 = {
        methargs: {
          body: 'second message to kp1',
          slots: [],
        },
        result: null,
      };
      ks.enqueuePromiseMessage('kp1', msg2);
      expect(ks.getKernelPromiseMessageQueue('kp1')).toStrictEqual([
        msg1,
        msg2,
      ]);
      expect(ks.getKernelPromiseMessageQueue('kp1')).toStrictEqual([]);
      ks.enqueuePromiseMessage('kp1', {
        methargs: {
          body: 'sacrificial message',
          slots: [],
        },
        result: null,
      });
      ks.deleteKernelPromise('kp1');
      expect(() => ks.getKernelPromise('kp1')).toThrow(
        'unknown kernel promise kp1',
      );
      expect(() => ks.getKernelPromise('kp99')).toThrow(
        'unknown kernel promise kp99',
      );
    });
    it('manages the run queue', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      ks.enqueueRun(tm('first message'));
      ks.enqueueRun(tm('second message'));
      expect(ks.dequeueRun()).toBe('first message');
      ks.enqueueRun(tm('third message'));
      expect(ks.dequeueRun()).toBe('second message');
      expect(ks.dequeueRun()).toBe('third message');
      expect(ks.dequeueRun()).toBeUndefined();
      ks.enqueueRun(tm('fourth message'));
      expect(ks.dequeueRun()).toBe('fourth message');
      expect(ks.dequeueRun()).toBeUndefined();
    });
    it('manages clists', () => {
      const ks = makeKernelStore(mockKernelDatabase);

      // Create objects first to ensure they exist in the kernel
      const ko42 = ks.initKernelObject('v2');
      const ko51 = ks.initKernelObject('v2');
      const [kp60] = ks.initKernelPromise();
      const [kp61] = ks.initKernelPromise();

      // Add C-list entries
      ks.addCListEntry('v2', ko42, 'o-63');
      ks.addCListEntry('v2', ko51, 'o-74');
      ks.addCListEntry('v2', kp60, 'p+85');
      ks.addCListEntry('r7', ko42, 'ro+11');
      ks.addCListEntry('r7', kp61, 'rp-99');

      // Verify mappings
      expect(ks.krefToEref('v2', ko42)).toBe('o-63');
      expect(ks.erefToKref('v2', 'o-63')).toBe(ko42);
      expect(ks.krefToEref('v2', ko51)).toBe('o-74');
      expect(ks.erefToKref('v2', 'o-74')).toBe(ko51);
      expect(ks.krefToEref('v2', kp60)).toBe('p+85');
      expect(ks.erefToKref('v2', 'p+85')).toBe(kp60);
      expect(ks.krefToEref('r7', ko42)).toBe('ro+11');
      expect(ks.erefToKref('r7', 'ro+11')).toBe(ko42);
      expect(ks.krefToEref('r7', kp61)).toBe('rp-99');
      expect(ks.erefToKref('r7', 'rp-99')).toBe(kp61);

      // Test forgetting entries
      ks.forgetKref('v2', ko42);
      expect(ks.krefToEref('v2', ko42)).toBeUndefined();
      expect(ks.erefToKref('v2', 'o-63')).toBeUndefined();

      ks.forgetEref('r7', 'rp-99');
      expect(ks.krefToEref('r7', kp61)).toBeUndefined();
      expect(ks.erefToKref('r7', 'rp-99')).toBeUndefined();

      // Verify C-list entry existence
      expect(ks.hasCListEntry('r7', ko42)).toBe(true);
      expect(ks.hasCListEntry('v2', ko42)).toBe(false); // We forgot this one
    });
  });

  describe('ocap URL retention', () => {
    it('pins the target and records it', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const kref = ks.initKernelObject('v1');

      ks.retainForOcapURL(kref);

      expect(ks.isObjectPinned(kref)).toBe(true);
      expect(ks.getOcapURLObjects()).toStrictEqual([kref]);
    });

    it('counts an issuance for each URL naming the same target, and pins it once', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const kref = ks.initKernelObject('v1');

      ks.retainForOcapURL(kref);
      ks.retainForOcapURL(kref);

      expect(ks.getOcapURLObjects()).toStrictEqual([kref]);
      expect(ks.getOcapURLIssuanceCount(kref)).toBe(2);
      expect(ks.getPinCount(kref)).toBe(1);
      expect(ks.getObjectRefCount(kref)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });
    });

    it('undoes one retention of a target that several URLs name', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const kref = ks.initKernelObject('v1');
      ks.retainForOcapURL(kref);
      ks.retainForOcapURL(kref);

      ks.undoOcapURLRetention(kref);

      expect(ks.getOcapURLIssuanceCount(kref)).toBe(1);
      expect(ks.isObjectPinned(kref)).toBe(true);
      expect(ks.getObjectRefCount(kref)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });
    });

    it('refuses to retain a kref the kernel has deleted', () => {
      const ks = makeKernelStore(mockKernelDatabase);

      expect(() => ks.retainForOcapURL('ko99')).toThrow(
        'cannot issue an ocap URL for deleted kref "ko99"',
      );
      expect(ks.getOcapURLObjects()).toStrictEqual([]);
    });

    it('undoing the last retention clears the record entirely', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const kref = ks.initKernelObject('v1');
      const otherKref = ks.initKernelObject('v1');
      ks.retainForOcapURL(kref);
      ks.retainForOcapURL(otherKref);

      ks.undoOcapURLRetention(kref);
      expect(ks.isObjectPinned(kref)).toBe(false);
      expect(ks.getOcapURLObjects()).toStrictEqual([otherKref]);

      ks.undoOcapURLRetention(otherKref);
      expect(ks.getOcapURLObjects()).toStrictEqual([]);
      expect(
        mockKernelDatabase.kernelKVStore.get(`ocapURLObjects.${otherKref}`),
      ).toBeUndefined();
    });

    it('undoing a retention that was never taken leaves the pin alone', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const kref = ks.initKernelObject('v1');
      ks.pinObject(kref);

      ks.undoOcapURLRetention(kref);

      expect(ks.isObjectPinned(kref)).toBe(true);
    });

    it('releases every retention of a target at once', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const kref = ks.initKernelObject('v1');
      ks.retainForOcapURL(kref);
      ks.retainForOcapURL(kref);
      ks.retainForOcapURL(kref);

      ks.releaseOcapURLRetentions(kref);

      expect(ks.getOcapURLObjects()).toStrictEqual([]);
      expect(ks.isObjectPinned(kref)).toBe(false);
      expect(ks.getObjectRefCount(kref)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });
    });

    it('releasing retentions of a target that has none leaves other pins alone', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const kref = ks.initKernelObject('v1');
      ks.pinObject(kref);

      ks.releaseOcapURLRetentions(kref);

      expect(ks.isObjectPinned(kref)).toBe(true);
    });

    it('does not mistake the ocap URL cipher key for a retained object', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const kref = ks.initKernelObject('v1');
      // `ocapURLKey` is a neighbour of the retention keys in key order, and
      // holds the key the tokens are encrypted with rather than a kref.
      mockKernelDatabase.kernelKVStore.set('ocapURLKey', 'some-cipher-key');
      ks.retainForOcapURL(kref);

      expect(ks.getOcapURLObjects()).toStrictEqual([kref]);
    });
  });

  describe('reset', () => {
    it('clears store and resets counters', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      ks.getNextVatId();
      ks.getNextVatId();
      ks.getNextRemoteId();
      const koId = ks.initKernelObject('v1');
      const [kpId] = ks.initKernelPromise();
      ks.addCListEntry('v1', koId, 'o-1');
      ks.enqueueRun(tm('test message'));
      ks.reset();
      expect(ks.getNextVatId()).toBe('v1');
      expect(ks.getNextRemoteId()).toBe('r1');
      expect(ks.getOwner(koId)).toBeUndefined();
      expect(() => ks.getKernelPromise(kpId)).toThrow(
        `unknown kernel promise ${kpId}`,
      );
      expect(ks.krefToEref('v1', koId)).toBeUndefined();
      expect(ks.dequeueRun()).toBeUndefined();
    });

    it('preserves specified keys when resetting', () => {
      const ks = makeKernelStore(mockKernelDatabase);

      // Set up some state
      ks.getNextVatId();
      ks.getNextVatId();
      const koId = ks.initKernelObject('v1');
      ks.enqueueRun(tm('test message'));

      // Set some custom keys that we want to preserve
      mockKernelDatabase.kernelKVStore.set('keySeed', 'preserved-seed');
      mockKernelDatabase.kernelKVStore.set('peerId', 'preserved-peer');
      mockKernelDatabase.kernelKVStore.set('ocapURLKey', 'preserved-url');
      mockKernelDatabase.kernelKVStore.set('someOtherKey', 'should-be-cleared');

      // Reset with except parameter
      ks.reset({ except: ['keySeed', 'peerId', 'ocapURLKey'] });

      // Check that counters are reset
      expect(ks.getNextVatId()).toBe('v1');
      expect(ks.getNextRemoteId()).toBe('r1');

      // Check that state is cleared
      expect(ks.getOwner(koId)).toBeUndefined();
      expect(ks.dequeueRun()).toBeUndefined();

      // Check that preserved keys are still there
      expect(mockKernelDatabase.kernelKVStore.get('keySeed')).toBe(
        'preserved-seed',
      );
      expect(mockKernelDatabase.kernelKVStore.get('peerId')).toBe(
        'preserved-peer',
      );
      expect(mockKernelDatabase.kernelKVStore.get('ocapURLKey')).toBe(
        'preserved-url',
      );

      // Check that non-preserved keys are cleared
      expect(
        mockKernelDatabase.kernelKVStore.get('someOtherKey'),
      ).toBeUndefined();
    });

    it('does not restore keys with undefined values', () => {
      const ks = makeKernelStore(mockKernelDatabase);

      // Set up some state
      ks.getNextVatId();
      const koId = ks.initKernelObject('v1');

      // Set some keys with values and some without
      mockKernelDatabase.kernelKVStore.set('existingKey', 'has-value');
      // Don't set 'undefinedKey' - it will be undefined
      // Don't set 'nullKey' - it will be undefined

      // Reset with except parameter including undefined keys
      ks.reset({ except: ['existingKey', 'undefinedKey', 'nullKey'] });

      // Check that counters are reset
      expect(ks.getNextVatId()).toBe('v1');
      expect(ks.getOwner(koId)).toBeUndefined();

      // Check that only keys with values are restored
      expect(mockKernelDatabase.kernelKVStore.get('existingKey')).toBe(
        'has-value',
      );
      expect(
        mockKernelDatabase.kernelKVStore.get('undefinedKey'),
      ).toBeUndefined();
      expect(mockKernelDatabase.kernelKVStore.get('nullKey')).toBeUndefined();
    });

    it('resets all keys when no except parameter provided', () => {
      const ks = makeKernelStore(mockKernelDatabase);

      // Set up some state
      ks.getNextVatId();
      const koId = ks.initKernelObject('v1');
      mockKernelDatabase.kernelKVStore.set('customKey', 'should-be-cleared');

      // Reset without except parameter
      ks.reset();

      // Check that everything is reset
      expect(ks.getNextVatId()).toBe('v1');
      expect(ks.getOwner(koId)).toBeUndefined();
      expect(mockKernelDatabase.kernelKVStore.get('customKey')).toBeUndefined();
    });
  });

  describe('incarnation ID', () => {
    it('generates a new incarnation ID on first call', () => {
      const ks = makeKernelStore(mockKernelDatabase);

      const incarnationId = ks.provideIncarnationId();

      expect(typeof incarnationId).toBe('string');
      expect(incarnationId).toHaveLength(36); // UUID format
      expect(mockKernelDatabase.kernelKVStore.get('incarnationId')).toBe(
        incarnationId,
      );
    });

    it('returns the same incarnation ID on subsequent calls', () => {
      const ks = makeKernelStore(mockKernelDatabase);

      const first = ks.provideIncarnationId();
      const second = ks.provideIncarnationId();
      const third = ks.provideIncarnationId();

      expect(first).toBe(second);
      expect(second).toBe(third);
    });

    it('preserves incarnation ID across store instances', () => {
      const ks1 = makeKernelStore(mockKernelDatabase);
      const incarnationId = ks1.provideIncarnationId();

      // Create a new store instance pointing to the same database
      const ks2 = makeKernelStore(mockKernelDatabase);
      const loaded = ks2.provideIncarnationId();

      expect(loaded).toBe(incarnationId);
    });

    it('regenerates incarnation ID after storage reset', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const original = ks.provideIncarnationId();

      // Reset storage (clears incarnationId since it's not in except list)
      ks.reset();

      const regenerated = ks.provideIncarnationId();

      expect(regenerated).not.toBe(original);
      expect(regenerated).toHaveLength(36);
    });

    it('preserves incarnation ID when reset with except list', () => {
      const ks = makeKernelStore(mockKernelDatabase);
      const original = ks.provideIncarnationId();

      // Reset with incarnationId in except list
      ks.reset({ except: ['incarnationId'] });

      const preserved = ks.provideIncarnationId();

      expect(preserved).toBe(original);
    });
  });
});
