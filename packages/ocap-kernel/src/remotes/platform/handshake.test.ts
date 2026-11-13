import { UnexpectedEOFError } from '@libp2p/utils';
import { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  isHandshakeMessage,
  performInboundHandshake,
  performOutboundHandshake,
} from './handshake.ts';
import type { HandshakeDeps } from './handshake.ts';
import type { Channel } from '../types.ts';

type Chunk = Awaited<ReturnType<Channel['msgStream']['read']>>;

/**
 * Make a chunk as the length-prefixed stream yields it.
 *
 * @param text - The chunk's content.
 * @returns The chunk.
 */
const makeChunk = (text: string): Chunk =>
  ({ subarray: () => new TextEncoder().encode(text) }) as unknown as Chunk;

describe('handshake', () => {
  describe('isHandshakeMessage', () => {
    it.each([
      // Valid messages
      {
        input: { method: 'handshake', params: { incarnationId: 'test-id' } },
        expected: true,
        description: 'handshake message',
      },
      {
        input: { method: 'handshakeAck', params: { incarnationId: 'test-id' } },
        expected: true,
        description: 'handshakeAck message',
      },
      // Non-objects
      { input: null, expected: false, description: 'null' },
      { input: 'string', expected: false, description: 'string' },
      { input: 123, expected: false, description: 'number' },
      { input: undefined, expected: false, description: 'undefined' },
      // Wrong method
      {
        input: { method: 'delivery' },
        expected: false,
        description: 'delivery method',
      },
      {
        input: { method: 'other' },
        expected: false,
        description: 'other method',
      },
      { input: { params: {} }, expected: false, description: 'missing method' },
      // Missing params
      {
        input: { method: 'handshake' },
        expected: false,
        description: 'handshake without params',
      },
      {
        input: { method: 'handshakeAck' },
        expected: false,
        description: 'handshakeAck without params',
      },
      // Invalid params
      {
        input: { method: 'handshake', params: null },
        expected: false,
        description: 'null params',
      },
      {
        input: { method: 'handshake', params: 'string' },
        expected: false,
        description: 'string params',
      },
      {
        input: { method: 'handshake', params: {} },
        expected: false,
        description: 'empty params',
      },
      {
        input: { method: 'handshakeAck', params: { other: 'data' } },
        expected: false,
        description: 'params without incarnationId',
      },
      // Invalid incarnationId
      {
        input: { method: 'handshake', params: { incarnationId: 123 } },
        expected: false,
        description: 'number incarnationId',
      },
      {
        input: { method: 'handshakeAck', params: { incarnationId: null } },
        expected: false,
        description: 'null incarnationId',
      },
    ])('returns $expected for $description', ({ input, expected }) => {
      expect(isHandshakeMessage(input)).toBe(expected);
    });
  });

  describe('performOutboundHandshake', () => {
    let mockChannel: Channel;
    let mockDeps: HandshakeDeps;
    let logger: Logger;

    beforeEach(() => {
      logger = new Logger();
      vi.spyOn(logger, 'log');

      mockChannel = {
        peerId: 'test-peer-id',
        stream: { status: 'open' },
        msgStream: {
          write: vi.fn().mockResolvedValue(undefined),
          read: vi.fn(),
          unwrap: vi.fn(),
        },
      } as unknown as Channel;

      mockDeps = {
        localIncarnationId: 'local-incarnation-123',
        logger,
        setRemoteIncarnation: vi.fn().mockReturnValue(false),
      };
    });

    it('sends handshake and waits for handshakeAck', async () => {
      const handshakeAck = JSON.stringify({
        method: 'handshakeAck',
        params: { incarnationId: 'remote-incarnation-456' },
      });
      vi.spyOn(mockChannel.msgStream, 'read').mockResolvedValueOnce(
        makeChunk(handshakeAck),
      );

      const result = await performOutboundHandshake(mockChannel, mockDeps);

      // Verify handshake was sent
      expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(1);
      const writeCall = mockChannel.msgStream.write as ReturnType<typeof vi.fn>;
      const sentData = new TextDecoder().decode(
        writeCall.mock.calls[0]?.[0] as Uint8Array,
      );
      const sentMessage = JSON.parse(sentData);
      expect(sentMessage).toStrictEqual({
        method: 'handshake',
        params: { incarnationId: 'local-incarnation-123' },
      });

      // Verify result
      expect(result.remoteIncarnationId).toBe('remote-incarnation-456');
      expect(result.incarnationChanged).toBe(false);

      // Verify incarnation was set
      expect(mockDeps.setRemoteIncarnation).toHaveBeenCalledWith(
        'test-peer-id',
        'remote-incarnation-456',
      );
    });

    it('returns incarnationChanged=true when incarnation changes', async () => {
      const handshakeAck = JSON.stringify({
        method: 'handshakeAck',
        params: { incarnationId: 'new-incarnation' },
      });
      vi.spyOn(mockChannel.msgStream, 'read').mockResolvedValueOnce(
        makeChunk(handshakeAck),
      );
      (
        mockDeps.setRemoteIncarnation as ReturnType<typeof vi.fn>
      ).mockReturnValue(true);

      const result = await performOutboundHandshake(mockChannel, mockDeps);

      expect(result.incarnationChanged).toBe(true);
    });

    it('throws when response is not handshakeAck', async () => {
      const wrongResponse = JSON.stringify({
        method: 'handshake', // Wrong! Should be handshakeAck
        params: { incarnationId: 'remote-incarnation' },
      });
      vi.spyOn(mockChannel.msgStream, 'read').mockResolvedValueOnce(
        makeChunk(wrongResponse),
      );

      await expect(
        performOutboundHandshake(mockChannel, mockDeps),
      ).rejects.toThrow('Expected handshakeAck');
    });

    it('throws when response is not valid JSON', async () => {
      vi.spyOn(mockChannel.msgStream, 'read').mockResolvedValueOnce(
        makeChunk('not json'),
      );

      await expect(
        performOutboundHandshake(mockChannel, mockDeps),
      ).rejects.toThrow('JSON');
    });
  });

  describe('performInboundHandshake', () => {
    let mockChannel: Channel;
    let mockDeps: HandshakeDeps;
    let logger: Logger;

    beforeEach(() => {
      logger = new Logger();
      vi.spyOn(logger, 'log');

      mockChannel = {
        peerId: 'test-peer-id',
        stream: { status: 'open' },
        msgStream: {
          write: vi.fn().mockResolvedValue(undefined),
          read: vi.fn(),
          unwrap: vi.fn(),
        },
      } as unknown as Channel;

      mockDeps = {
        localIncarnationId: 'local-incarnation-123',
        logger,
        setRemoteIncarnation: vi.fn().mockReturnValue(false),
      };
    });

    it('waits for handshake and sends handshakeAck', async () => {
      const handshake = JSON.stringify({
        method: 'handshake',
        params: { incarnationId: 'remote-incarnation-456' },
      });
      vi.spyOn(mockChannel.msgStream, 'read').mockResolvedValueOnce(
        makeChunk(handshake),
      );

      const result = await performInboundHandshake(mockChannel, mockDeps);

      // Verify handshakeAck was sent
      expect(mockChannel.msgStream.write).toHaveBeenCalledTimes(1);
      const writeCall = mockChannel.msgStream.write as ReturnType<typeof vi.fn>;
      const sentData = new TextDecoder().decode(
        writeCall.mock.calls[0]?.[0] as Uint8Array,
      );
      const sentMessage = JSON.parse(sentData);
      expect(sentMessage).toStrictEqual({
        method: 'handshakeAck',
        params: { incarnationId: 'local-incarnation-123' },
      });

      // Verify result
      expect(result.remoteIncarnationId).toBe('remote-incarnation-456');
      expect(result.incarnationChanged).toBe(false);

      // Verify incarnation was set
      expect(mockDeps.setRemoteIncarnation).toHaveBeenCalledWith(
        'test-peer-id',
        'remote-incarnation-456',
      );
    });

    it('returns incarnationChanged=true when incarnation changes', async () => {
      const handshake = JSON.stringify({
        method: 'handshake',
        params: { incarnationId: 'new-incarnation' },
      });
      vi.spyOn(mockChannel.msgStream, 'read').mockResolvedValueOnce(
        makeChunk(handshake),
      );
      (
        mockDeps.setRemoteIncarnation as ReturnType<typeof vi.fn>
      ).mockReturnValue(true);

      const result = await performInboundHandshake(mockChannel, mockDeps);

      expect(result.incarnationChanged).toBe(true);
    });

    it('throws when first message is not handshake', async () => {
      const wrongMessage = JSON.stringify({
        method: 'handshakeAck', // Wrong! Should be handshake
        params: { incarnationId: 'remote-incarnation' },
      });
      vi.spyOn(mockChannel.msgStream, 'read').mockResolvedValueOnce(
        makeChunk(wrongMessage),
      );

      await expect(
        performInboundHandshake(mockChannel, mockDeps),
      ).rejects.toThrow('Expected handshake');
    });

    it('throws when channel closes during read', async () => {
      vi.spyOn(mockChannel.msgStream, 'read').mockRejectedValueOnce(
        new UnexpectedEOFError('stream closed'),
      );

      await expect(
        performInboundHandshake(mockChannel, mockDeps),
      ).rejects.toThrow(UnexpectedEOFError);
    });
  });
});
