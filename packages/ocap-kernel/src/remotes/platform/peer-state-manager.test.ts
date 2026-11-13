import type { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

import { PeerStateManager } from './peer-state-manager.ts';
import type { Channel } from '../types.ts';

describe('PeerStateManager', () => {
  let manager: PeerStateManager;
  let mockLogger: { log: Mock<Logger['log']> };
  let logger: Logger;

  beforeEach(() => {
    mockLogger = { log: vi.fn() };
    logger = mockLogger as unknown as Logger;
    manager = new PeerStateManager(logger);
  });

  describe('getState', () => {
    it('creates new state for unknown peer', () => {
      const state = manager.getState('peer1');

      expect(state).toStrictEqual({
        channel: undefined,
        locationHints: [],
        remoteIncarnationId: undefined,
      });
    });

    it('returns same state for same peer', () => {
      const state1 = manager.getState('peer1');
      const state2 = manager.getState('peer1');

      expect(state1).toBe(state2);
    });

    it('returns different state for different peers', () => {
      const state1 = manager.getState('peer1');
      const state2 = manager.getState('peer2');

      expect(state1).not.toBe(state2);
    });

    it('initializes lastConnectionTime on first access', async () => {
      // Use very short timeout for testing
      const shortTimeoutManager = new PeerStateManager(logger, 10);
      shortTimeoutManager.getState('peer1');

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Verify by checking getStalePeers behavior
      const stalePeers = shortTimeoutManager.getStalePeers();
      expect(stalePeers).toContain('peer1');
    });
  });

  describe('countActiveConnections', () => {
    it('returns 0 when no connections', () => {
      expect(manager.countActiveConnections()).toBe(0);
    });

    it('counts peers with channels', () => {
      const mockChannel = { peerId: 'peer1' } as Channel;
      const state1 = manager.getState('peer1');
      state1.channel = mockChannel;

      expect(manager.countActiveConnections()).toBe(1);
    });

    it('does not count peers without channels', () => {
      manager.getState('peer1');
      manager.getState('peer2');

      expect(manager.countActiveConnections()).toBe(0);
    });

    it('counts multiple active connections', () => {
      const state1 = manager.getState('peer1');
      const state2 = manager.getState('peer2');
      manager.getState('peer3'); // peer3 has no channel

      state1.channel = { peerId: 'peer1' } as Channel;
      state2.channel = { peerId: 'peer2' } as Channel;

      expect(manager.countActiveConnections()).toBe(2);
    });
  });

  describe('updateConnectionTime', () => {
    it('updates connection time for peer', async () => {
      // Use very short timeout for testing
      const shortTimeoutManager = new PeerStateManager(logger, 50);
      shortTimeoutManager.getState('peer1');

      // Wait a bit, then update connection time
      await new Promise((resolve) => setTimeout(resolve, 30));
      shortTimeoutManager.updateConnectionTime('peer1');

      // Wait a bit more - total time is ~60ms but we updated at ~30ms
      // So the effective time since update is ~30ms, less than 50ms timeout
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Peer should not be stale because we updated the connection time
      expect(shortTimeoutManager.getStalePeers()).not.toContain('peer1');
    });
  });

  describe('intentionally closed tracking', () => {
    describe('isIntentionallyClosed', () => {
      it('returns false for new peer', () => {
        expect(manager.isIntentionallyClosed('peer1')).toBe(false);
      });

      it('returns true after marking as closed', () => {
        manager.markIntentionallyClosed('peer1');

        expect(manager.isIntentionallyClosed('peer1')).toBe(true);
      });
    });

    describe('markIntentionallyClosed', () => {
      it('marks peer as intentionally closed', () => {
        manager.markIntentionallyClosed('peer1');

        expect(manager.isIntentionallyClosed('peer1')).toBe(true);
      });

      it('is idempotent', () => {
        manager.markIntentionallyClosed('peer1');
        manager.markIntentionallyClosed('peer1');

        expect(manager.isIntentionallyClosed('peer1')).toBe(true);
      });

      it('does not affect other peers', () => {
        manager.markIntentionallyClosed('peer1');

        expect(manager.isIntentionallyClosed('peer2')).toBe(false);
      });
    });

    describe('clearIntentionallyClosed', () => {
      it('clears intentionally closed flag', () => {
        manager.markIntentionallyClosed('peer1');
        manager.clearIntentionallyClosed('peer1');

        expect(manager.isIntentionallyClosed('peer1')).toBe(false);
      });

      it('works on peer that was not marked', () => {
        manager.clearIntentionallyClosed('peer1');

        expect(manager.isIntentionallyClosed('peer1')).toBe(false);
      });
    });
  });

  describe('incarnation tracking', () => {
    describe('setRemoteIncarnation', () => {
      it('returns false for first incarnation (not a change)', () => {
        const changed = manager.setRemoteIncarnation('peer1', 'incarnation-1');

        expect(changed).toBe(false);
      });

      it('returns false when setting same incarnation', () => {
        manager.setRemoteIncarnation('peer1', 'incarnation-1');
        const changed = manager.setRemoteIncarnation('peer1', 'incarnation-1');

        expect(changed).toBe(false);
      });

      it('returns true when incarnation changes', () => {
        manager.setRemoteIncarnation('peer1', 'incarnation-1');
        const changed = manager.setRemoteIncarnation('peer1', 'incarnation-2');

        expect(changed).toBe(true);
      });

      it('stores the new incarnation when changed', () => {
        manager.setRemoteIncarnation('peer1', 'incarnation-1');
        manager.setRemoteIncarnation('peer1', 'incarnation-2');

        expect(manager.getState('peer1').remoteIncarnationId).toBe(
          'incarnation-2',
        );
      });

      it('logs when first incarnation is received', () => {
        manager.setRemoteIncarnation('peer1', 'incarnation-id-12345');

        expect(mockLogger.log).toHaveBeenCalledWith(
          expect.stringContaining('first incarnation ID received'),
        );
      });

      it('logs when incarnation changes', () => {
        manager.setRemoteIncarnation('peer1', 'incarnation-1');
        mockLogger.log.mockClear();
        manager.setRemoteIncarnation('peer1', 'incarnation-2');

        expect(mockLogger.log).toHaveBeenCalledWith(
          expect.stringContaining('incarnation changed'),
        );
      });

      it('does not affect other peers', () => {
        manager.setRemoteIncarnation('peer1', 'incarnation-1');
        manager.setRemoteIncarnation('peer2', 'incarnation-2');

        expect(manager.getState('peer1').remoteIncarnationId).toBe(
          'incarnation-1',
        );
        expect(manager.getState('peer2').remoteIncarnationId).toBe(
          'incarnation-2',
        );
      });
    });
  });

  describe('addLocationHints', () => {
    it('adds hints to empty list', () => {
      manager.addLocationHints('peer1', ['hint1', 'hint2']);

      const state = manager.getState('peer1');
      expect(state.locationHints).toStrictEqual(['hint1', 'hint2']);
    });

    it('merges hints with existing hints', () => {
      manager.addLocationHints('peer1', ['hint1', 'hint2']);
      manager.addLocationHints('peer1', ['hint2', 'hint3']);

      const state = manager.getState('peer1');
      expect(state.locationHints).toContain('hint1');
      expect(state.locationHints).toContain('hint2');
      expect(state.locationHints).toContain('hint3');
      expect(state.locationHints).toHaveLength(3);
    });

    it('deduplicates hints when merging', () => {
      manager.addLocationHints('peer1', ['hint1']);
      manager.addLocationHints('peer1', ['hint1', 'hint2']);

      const state = manager.getState('peer1');
      expect(state.locationHints).toHaveLength(2);
      expect(state.locationHints).toContain('hint1');
      expect(state.locationHints).toContain('hint2');
    });

    it('creates state if it does not exist', () => {
      manager.addLocationHints('newpeer', ['hint1']);

      const state = manager.getState('newpeer');
      expect(state.locationHints).toStrictEqual(['hint1']);
    });
  });

  describe('getStalePeers', () => {
    it('returns empty array when no peers', () => {
      expect(manager.getStalePeers()).toStrictEqual([]);
    });

    it('returns empty array when peers have active channels', () => {
      // Use a very short timeout for testing
      const shortTimeoutManager = new PeerStateManager(logger, 1);
      const state = shortTimeoutManager.getState('peer1');
      state.channel = { peerId: 'peer1' } as Channel;

      // Even with a tiny timeout, peers with channels are not stale
      expect(shortTimeoutManager.getStalePeers()).toStrictEqual([]);
    });

    it('returns stale peers without channels after timeout', async () => {
      // Use a very short timeout (10ms) for testing
      const shortTimeoutManager = new PeerStateManager(logger, 10);
      shortTimeoutManager.getState('peer1');

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(shortTimeoutManager.getStalePeers()).toContain('peer1');
    });

    it('does not return peers with recent activity', () => {
      // Use 1 hour timeout (default)
      manager.getState('peer1');

      // Peer should not be stale immediately
      expect(manager.getStalePeers()).not.toContain('peer1');
    });

    it('respects custom stale timeout', async () => {
      // Use a very short timeout (10ms)
      const customManager = new PeerStateManager(logger, 10);
      customManager.getState('peer1');

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(customManager.getStalePeers()).toContain('peer1');
    });
  });

  describe('removePeer', () => {
    it('removes peer state', () => {
      const state = manager.getState('peer1');
      state.channel = { peerId: 'peer1' } as Channel;

      manager.removePeer('peer1');

      // New call should create fresh state
      const newState = manager.getState('peer1');
      expect(newState.channel).toBeUndefined();
    });

    it('clears intentionally closed flag', () => {
      manager.markIntentionallyClosed('peer1');

      manager.removePeer('peer1');

      expect(manager.isIntentionallyClosed('peer1')).toBe(false);
    });

    it('logs cleanup message', () => {
      manager.getState('peer1');

      manager.removePeer('peer1');

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('Cleaning up stale peer peer1'),
      );
    });

    it('handles removal of non-existent peer', () => {
      expect(() => manager.removePeer('nonexistent')).not.toThrow();
    });
  });

  describe('getAllStates', () => {
    it('returns empty iterator when no peers', () => {
      const states = Array.from(manager.getAllStates());

      expect(states).toStrictEqual([]);
    });

    it('returns all peer states', () => {
      manager.getState('peer1');
      manager.getState('peer2');

      const states = Array.from(manager.getAllStates());

      expect(states).toHaveLength(2);
    });

    it('returns states with correct structure', () => {
      const state = manager.getState('peer1');
      state.channel = { peerId: 'peer1' } as Channel;
      state.locationHints = ['hint1'];

      const states = Array.from(manager.getAllStates());

      expect(states[0]).toStrictEqual({
        channel: { peerId: 'peer1' },
        locationHints: ['hint1'],
        remoteIncarnationId: undefined,
      });
    });
  });

  describe('clear', () => {
    it('removes all peer states', () => {
      manager.getState('peer1');
      manager.getState('peer2');

      manager.clear();

      expect(Array.from(manager.getAllStates())).toStrictEqual([]);
    });

    it('clears intentionally closed flags', () => {
      manager.markIntentionallyClosed('peer1');

      manager.clear();

      expect(manager.isIntentionallyClosed('peer1')).toBe(false);
    });

    it('clears connection times', () => {
      manager.getState('peer1');

      manager.clear();

      // After clear, getStalePeers should be empty because there are no peers
      expect(manager.getStalePeers()).toStrictEqual([]);
    });
  });
});
