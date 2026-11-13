import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getBaseMethods } from './base.ts';
import { getRemoteMethods } from './remote.ts';
import type { RemoteInfo } from '../../remotes/types.ts';
import type { RemoteId } from '../../types.ts';
import type { StoreContext } from '../types.ts';

vi.mock('./base.ts', () => ({
  getBaseMethods: vi.fn(),
}));

describe('remote store methods', () => {
  let mockKV: Map<string, string>;
  const remoteId1 = 'r1' as RemoteId;
  const remoteId2 = 'r2' as RemoteId;
  const mockGetPrefixedKeys = vi.fn();
  let context: StoreContext;
  let remoteMethods: ReturnType<typeof getRemoteMethods>;
  const remoteInfo1: RemoteInfo = {
    peerId: 'peer1',
    hints: ['hintA', 'hintB'],
  };
  const remoteInfo2: RemoteInfo = {
    peerId: 'peer2',
    hints: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockKV = new Map();

    (getBaseMethods as ReturnType<typeof vi.fn>).mockReturnValue({
      getPrefixedKeys: mockGetPrefixedKeys,
    });

    context = {
      kv: {
        get: (key: string): string | undefined => mockKV.get(key),
        getRequired: (key: string): string => {
          const value = mockKV.get(key);
          if (value === undefined) {
            throw new Error(`Required key ${key} not found`);
          }
          return value;
        },
        set: (key: string, value: string): void => {
          mockKV.set(key, value);
        },
        delete: (key: string): void => {
          mockKV.delete(key);
        },
      },
    } as unknown as StoreContext;

    remoteMethods = getRemoteMethods(context);
  });

  describe('getRemoteInfo', () => {
    it('retrieves remote info from storage', () => {
      mockKV.set(`remote.${remoteId1}`, JSON.stringify(remoteInfo1));

      const result = remoteMethods.getRemoteInfo(remoteId1);

      expect(result).toStrictEqual(remoteInfo1);
    });

    it('throws error if remote info does not exist', () => {
      expect(() => remoteMethods.getRemoteInfo(remoteId1)).toThrow(
        'Required key remote.r1 not found',
      );
    });
  });

  describe('setRemoteInfo', () => {
    it('stores remote info in storage', () => {
      remoteMethods.setRemoteInfo(remoteId1, remoteInfo1);

      const storedInfo = JSON.parse(
        mockKV.get(`remote.${remoteId1}`) as string,
      );
      expect(storedInfo).toStrictEqual(remoteInfo1);
    });

    it('overwrites existing remote info', () => {
      mockKV.set(`remote.${remoteId1}`, JSON.stringify(remoteInfo1));

      const updatedInfo = {
        ...remoteInfo1,
        name: 'updated-remote',
      } as unknown as RemoteInfo;

      remoteMethods.setRemoteInfo(remoteId1, updatedInfo);

      const storedInfo = JSON.parse(
        mockKV.get(`remote.${remoteId1}`) as string,
      );
      expect(storedInfo).toStrictEqual(updatedInfo);
    });
  });

  describe('deleteRemoteInfo', () => {
    it('removes remote info from storage', () => {
      mockKV.set(`remote.${remoteId1}`, JSON.stringify(remoteInfo1));
      mockGetPrefixedKeys.mockReturnValue([]);

      remoteMethods.deleteRemoteInfo(remoteId1);

      expect(mockKV.has(`remote.${remoteId1}`)).toBe(false);
    });

    it('does nothing if remote info does not exist', () => {
      mockGetPrefixedKeys.mockReturnValue([]);
      expect(() => remoteMethods.deleteRemoteInfo(remoteId1)).not.toThrow();
    });

    it('cleans up pending state when deleting remote info', () => {
      mockKV.set(`remote.${remoteId1}`, JSON.stringify(remoteInfo1));
      mockKV.set(`remoteSeq.${remoteId1}.nextSendSeq`, '5');
      mockKV.set(`remoteSeq.${remoteId1}.highestReceivedSeq`, '3');
      mockKV.set(`remoteSeq.${remoteId1}.startSeq`, '2');
      mockKV.set(`remotePending.${remoteId1}.2`, '{"seq":2}');
      mockKV.set(`remotePending.${remoteId1}.3`, '{"seq":3}');
      mockGetPrefixedKeys.mockReturnValue([
        `remotePending.${remoteId1}.2`,
        `remotePending.${remoteId1}.3`,
      ]);

      remoteMethods.deleteRemoteInfo(remoteId1);

      expect(mockKV.has(`remote.${remoteId1}`)).toBe(false);
      expect(mockKV.has(`remoteSeq.${remoteId1}.nextSendSeq`)).toBe(false);
      expect(mockKV.has(`remoteSeq.${remoteId1}.highestReceivedSeq`)).toBe(
        false,
      );
      expect(mockKV.has(`remoteSeq.${remoteId1}.startSeq`)).toBe(false);
      expect(mockKV.has(`remotePending.${remoteId1}.2`)).toBe(false);
      expect(mockKV.has(`remotePending.${remoteId1}.3`)).toBe(false);
    });

    it('clears persisted peer incarnation so a re-established remote starts fresh', () => {
      mockKV.set(`remote.${remoteId1}`, JSON.stringify(remoteInfo1));
      mockKV.set(`peerIncarnation.${remoteInfo1.peerId}`, 'incarnation-A');
      mockGetPrefixedKeys.mockReturnValue([]);

      remoteMethods.deleteRemoteInfo(remoteId1);

      // Without this cleanup a re-established remote with the same peerId
      // would mis-classify its first handshake as a restart against the
      // leftover incarnation.
      expect(mockKV.has(`peerIncarnation.${remoteInfo1.peerId}`)).toBe(false);
    });
  });

  describe('getAllRemoteRecords', () => {
    it('yields all stored remote records', () => {
      mockKV.set(`remote.${remoteId1}`, JSON.stringify(remoteInfo1));
      mockKV.set(`remote.${remoteId2}`, JSON.stringify(remoteInfo2));

      mockGetPrefixedKeys.mockReturnValue([
        `remote.${remoteId1}`,
        `remote.${remoteId2}`,
      ]);

      const records = Array.from(remoteMethods.getAllRemoteRecords());

      expect(records).toStrictEqual([
        { remoteId: remoteId1, remoteInfo: remoteInfo1 },
        { remoteId: remoteId2, remoteInfo: remoteInfo2 },
      ]);
      expect(mockGetPrefixedKeys).toHaveBeenCalledWith('remote.');
    });

    it('yields an empty array when no remotes are extant', () => {
      mockGetPrefixedKeys.mockReturnValue([]);

      const records = Array.from(remoteMethods.getAllRemoteRecords());

      expect(records).toStrictEqual([]);
    });
  });

  describe('getRemoteIDs', () => {
    it('lists every remote the kernel knows about', () => {
      mockGetPrefixedKeys.mockReturnValue([
        `remote.${remoteId1}`,
        `remote.${remoteId2}`,
      ]);

      expect(remoteMethods.getRemoteIDs()).toStrictEqual([
        remoteId1,
        remoteId2,
      ]);
      expect(mockGetPrefixedKeys).toHaveBeenCalledWith('remote.');
    });

    it('lists nothing when no remotes are extant', () => {
      mockGetPrefixedKeys.mockReturnValue([]);

      expect(remoteMethods.getRemoteIDs()).toStrictEqual([]);
    });
  });

  describe('getRemoteSeqState', () => {
    it('returns undefined when no state exists', () => {
      const result = remoteMethods.getRemoteSeqState(remoteId1);
      expect(result).toBeUndefined();
    });

    it('returns sequence state when all values exist', () => {
      mockKV.set(`remoteSeq.${remoteId1}.nextSendSeq`, '10');
      mockKV.set(`remoteSeq.${remoteId1}.highestReceivedSeq`, '5');
      mockKV.set(`remoteSeq.${remoteId1}.startSeq`, '3');

      const result = remoteMethods.getRemoteSeqState(remoteId1);

      expect(result).toStrictEqual({
        nextSendSeq: 10,
        highestReceivedSeq: 5,
        startSeq: 3,
      });
    });

    it('returns defaults for missing values when some state exists', () => {
      mockKV.set(`remoteSeq.${remoteId1}.nextSendSeq`, '10');

      const result = remoteMethods.getRemoteSeqState(remoteId1);

      expect(result).toStrictEqual({
        nextSendSeq: 10,
        highestReceivedSeq: 0,
        startSeq: 0,
      });
    });
  });

  describe('setRemoteNextSendSeq', () => {
    it('sets nextSendSeq', () => {
      remoteMethods.setRemoteNextSendSeq(remoteId1, 42);
      expect(mockKV.get(`remoteSeq.${remoteId1}.nextSendSeq`)).toBe('42');
    });
  });

  describe('setRemoteHighestReceivedSeq', () => {
    it('sets highestReceivedSeq', () => {
      remoteMethods.setRemoteHighestReceivedSeq(remoteId1, 15);
      expect(mockKV.get(`remoteSeq.${remoteId1}.highestReceivedSeq`)).toBe(
        '15',
      );
    });
  });

  describe('setRemoteStartSeq', () => {
    it('sets startSeq', () => {
      remoteMethods.setRemoteStartSeq(remoteId1, 7);
      expect(mockKV.get(`remoteSeq.${remoteId1}.startSeq`)).toBe('7');
    });
  });

  describe('getPendingMessage', () => {
    it('returns undefined for non-existent message', () => {
      const result = remoteMethods.getPendingMessage(remoteId1, 1);
      expect(result).toBeUndefined();
    });

    it('returns stored pending message string', () => {
      const messageString = '{"seq":1,"method":"deliver"}';
      mockKV.set(`remotePending.${remoteId1}.1`, messageString);

      const result = remoteMethods.getPendingMessage(remoteId1, 1);

      expect(result).toBe(messageString);
    });
  });

  describe('setPendingMessage', () => {
    it('stores pending message string', () => {
      const messageString = '{"seq":5,"method":"deliver"}';

      remoteMethods.setPendingMessage(remoteId1, 5, messageString);

      expect(mockKV.get(`remotePending.${remoteId1}.5`)).toBe(messageString);
    });
  });

  describe('deletePendingMessage', () => {
    it('deletes pending message entry', () => {
      mockKV.set(`remotePending.${remoteId1}.3`, '{"seq":3}');

      remoteMethods.deletePendingMessage(remoteId1, 3);

      expect(mockKV.has(`remotePending.${remoteId1}.3`)).toBe(false);
    });

    it('does nothing if message does not exist', () => {
      expect(() =>
        remoteMethods.deletePendingMessage(remoteId1, 99),
      ).not.toThrow();
    });
  });

  describe('deleteRemotePendingState', () => {
    it('deletes all seq state and pending messages', () => {
      mockKV.set(`remoteSeq.${remoteId1}.nextSendSeq`, '10');
      mockKV.set(`remoteSeq.${remoteId1}.highestReceivedSeq`, '5');
      mockKV.set(`remoteSeq.${remoteId1}.startSeq`, '2');
      mockKV.set(`remotePending.${remoteId1}.2`, '{"seq":2}');
      mockKV.set(`remotePending.${remoteId1}.3`, '{"seq":3}');
      mockGetPrefixedKeys.mockReturnValue([
        `remotePending.${remoteId1}.2`,
        `remotePending.${remoteId1}.3`,
      ]);

      remoteMethods.deleteRemotePendingState(remoteId1);

      expect(mockKV.has(`remoteSeq.${remoteId1}.nextSendSeq`)).toBe(false);
      expect(mockKV.has(`remoteSeq.${remoteId1}.highestReceivedSeq`)).toBe(
        false,
      );
      expect(mockKV.has(`remoteSeq.${remoteId1}.startSeq`)).toBe(false);
      expect(mockKV.has(`remotePending.${remoteId1}.2`)).toBe(false);
      expect(mockKV.has(`remotePending.${remoteId1}.3`)).toBe(false);
    });

    it('does nothing when no pending state exists', () => {
      mockGetPrefixedKeys.mockReturnValue([]);
      expect(() =>
        remoteMethods.deleteRemotePendingState(remoteId1),
      ).not.toThrow();
    });
  });

  describe('cleanupOrphanMessages', () => {
    it('deletes messages with seq < startSeq', () => {
      mockKV.set(`remotePending.${remoteId1}.1`, 'message 1');
      mockKV.set(`remotePending.${remoteId1}.2`, 'message 2');
      mockKV.set(`remotePending.${remoteId1}.3`, 'message 3');
      mockKV.set(`remotePending.${remoteId1}.4`, 'message 4');
      mockGetPrefixedKeys.mockReturnValue([
        `remotePending.${remoteId1}.1`,
        `remotePending.${remoteId1}.2`,
        `remotePending.${remoteId1}.3`,
        `remotePending.${remoteId1}.4`,
      ]);

      const deleted = remoteMethods.cleanupOrphanMessages(remoteId1, 3);

      expect(deleted).toBe(2);
      expect(mockKV.has(`remotePending.${remoteId1}.1`)).toBe(false);
      expect(mockKV.has(`remotePending.${remoteId1}.2`)).toBe(false);
      expect(mockKV.has(`remotePending.${remoteId1}.3`)).toBe(true);
      expect(mockKV.has(`remotePending.${remoteId1}.4`)).toBe(true);
    });

    it('returns 0 when no orphans exist', () => {
      mockKV.set(`remotePending.${remoteId1}.3`, 'message 3');
      mockKV.set(`remotePending.${remoteId1}.4`, 'message 4');
      mockGetPrefixedKeys.mockReturnValue([
        `remotePending.${remoteId1}.3`,
        `remotePending.${remoteId1}.4`,
      ]);

      const deleted = remoteMethods.cleanupOrphanMessages(remoteId1, 3);

      expect(deleted).toBe(0);
      expect(mockKV.has(`remotePending.${remoteId1}.3`)).toBe(true);
      expect(mockKV.has(`remotePending.${remoteId1}.4`)).toBe(true);
    });

    it('handles empty pending queue', () => {
      mockGetPrefixedKeys.mockReturnValue([]);

      const deleted = remoteMethods.cleanupOrphanMessages(remoteId1, 5);

      expect(deleted).toBe(0);
    });
  });

  describe('clearRemoteSeqState', () => {
    it('deletes all seq state and pending messages', () => {
      mockKV.set(`remoteSeq.${remoteId1}.nextSendSeq`, '10');
      mockKV.set(`remoteSeq.${remoteId1}.highestReceivedSeq`, '5');
      mockKV.set(`remoteSeq.${remoteId1}.startSeq`, '2');
      mockKV.set(`remotePending.${remoteId1}.2`, '{"seq":2}');
      mockKV.set(`remotePending.${remoteId1}.3`, '{"seq":3}');
      mockGetPrefixedKeys.mockReturnValue([
        `remotePending.${remoteId1}.2`,
        `remotePending.${remoteId1}.3`,
      ]);

      remoteMethods.clearRemoteSeqState(remoteId1);

      expect(mockKV.has(`remoteSeq.${remoteId1}.nextSendSeq`)).toBe(false);
      expect(mockKV.has(`remoteSeq.${remoteId1}.highestReceivedSeq`)).toBe(
        false,
      );
      expect(mockKV.has(`remoteSeq.${remoteId1}.startSeq`)).toBe(false);
      expect(mockKV.has(`remotePending.${remoteId1}.2`)).toBe(false);
      expect(mockKV.has(`remotePending.${remoteId1}.3`)).toBe(false);
    });

    it('does not affect remote relationship info', () => {
      mockKV.set(`remote.${remoteId1}`, JSON.stringify(remoteInfo1));
      mockKV.set(`remoteSeq.${remoteId1}.nextSendSeq`, '10');
      mockGetPrefixedKeys.mockReturnValue([]);

      remoteMethods.clearRemoteSeqState(remoteId1);

      // Remote info should still exist
      expect(mockKV.has(`remote.${remoteId1}`)).toBe(true);
      // Seq state should be cleared
      expect(mockKV.has(`remoteSeq.${remoteId1}.nextSendSeq`)).toBe(false);
    });

    it('does nothing when no state exists', () => {
      mockGetPrefixedKeys.mockReturnValue([]);
      expect(() => remoteMethods.clearRemoteSeqState(remoteId1)).not.toThrow();
    });
  });
});
