import type { Logger } from '@metamask/logger';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeErrorLogger, writeWithTimeout } from './channel-utils.ts';
import type { Channel } from '../types.ts';

const makeMockLogger = (): Logger => ({ log: vi.fn() }) as unknown as Logger;

describe('channel-utils', () => {
  describe('makeErrorLogger', () => {
    it('creates an error logger function', () => {
      const mockLogger = makeMockLogger();
      const outputError = makeErrorLogger(mockLogger);

      expect(typeof outputError).toBe('function');
    });

    it('logs error with peer context when problem is provided', () => {
      const mockLogger = makeMockLogger();
      const outputError = makeErrorLogger(mockLogger);
      const error = new Error('test error');

      outputError('peer123', 'sending message', error);

      expect(mockLogger.log).toHaveBeenCalledWith(
        'peer123:: error sending message: Error: test error',
      );
    });

    it('logs error without problem details when problem is null', () => {
      const mockLogger = makeMockLogger();
      const outputError = makeErrorLogger(mockLogger);

      outputError('peer123', 'connection failed', null);

      expect(mockLogger.log).toHaveBeenCalledWith(
        'peer123:: error connection failed',
      );
    });

    it('logs error without problem details when problem is undefined', () => {
      const mockLogger = makeMockLogger();
      const outputError = makeErrorLogger(mockLogger);

      outputError('peer123', 'timeout', undefined);

      expect(mockLogger.log).toHaveBeenCalledWith('peer123:: error timeout');
    });

    it('handles non-Error objects as problems', () => {
      const mockLogger = makeMockLogger();
      const outputError = makeErrorLogger(mockLogger);
      const problem = { message: 'custom error' };

      outputError('peer456', 'processing', problem);

      expect(mockLogger.log).toHaveBeenCalledWith(
        'peer456:: error processing: [object Object]',
      );
    });

    it('handles string problems', () => {
      const mockLogger = makeMockLogger();
      const outputError = makeErrorLogger(mockLogger);

      outputError('peer789', 'reading', 'string error');

      expect(mockLogger.log).toHaveBeenCalledWith(
        'peer789:: error reading: string error',
      );
    });
  });

  describe('writeWithTimeout', () => {
    let mockChannel: Channel;
    let writeResolve: () => void;
    let writeReject: (error: Error) => void;

    beforeEach(() => {
      const writePromise = new Promise<void>((resolve, reject) => {
        writeResolve = resolve;
        writeReject = reject;
      });

      mockChannel = {
        peerId: 'testPeer',
        stream: {
          status: 'open',
          inactivityTimeout: 0,
          addEventListener: vi.fn(),
          close: vi.fn(),
          abort: vi.fn(),
        },
        msgStream: {
          write: vi.fn().mockReturnValue(writePromise),
          read: vi.fn(),
          unwrap: vi.fn(),
        },
      } as unknown as Channel;
    });

    it('writes message to channel', async () => {
      const message = new Uint8Array([1, 2, 3]);

      const writePromise = writeWithTimeout(mockChannel, message, 1000);
      writeResolve();
      await writePromise;

      expect(mockChannel.msgStream.write).toHaveBeenCalledWith(message);
    });

    it('resolves when write completes before timeout', async () => {
      const message = new Uint8Array([1, 2, 3]);

      const writePromise = writeWithTimeout(mockChannel, message, 1000);
      writeResolve();

      expect(await writePromise).toBeUndefined();
    });

    it('rejects with timeout error when write takes too long', async () => {
      const message = new Uint8Array([1, 2, 3]);

      const writePromise = writeWithTimeout(mockChannel, message, 50);

      await expect(writePromise).rejects.toThrow(
        'Message send timed out after 50ms',
      );
    });

    it('uses default timeout when not specified', async () => {
      const message = new Uint8Array([1, 2, 3]);

      const writePromise = writeWithTimeout(mockChannel, message);
      writeResolve();

      expect(await writePromise).toBeUndefined();
    });

    it('rejects with write error when write fails', async () => {
      const message = new Uint8Array([1, 2, 3]);
      const writeError = new Error('Write failed');

      const writePromise = writeWithTimeout(mockChannel, message, 1000);
      writeReject(writeError);

      await expect(writePromise).rejects.toThrow('Write failed');
    });

    it.each(['closed', 'closing', 'aborted', 'reset'])(
      'throws immediately when stream status is %s',
      async (status) => {
        const message = new Uint8Array([1, 2, 3]);
        (mockChannel.stream as unknown as { status: string }).status = status;

        await expect(
          writeWithTimeout(mockChannel, message, 1000),
        ).rejects.toThrow(`Stream is ${status}, cannot write`);

        expect(mockChannel.msgStream.write).not.toHaveBeenCalled();
      },
    );

    it('cleans up timeout listener after successful write', async () => {
      const message = new Uint8Array([1, 2, 3]);

      const writePromise = writeWithTimeout(mockChannel, message, 1000);
      writeResolve();
      const result = await writePromise;

      // If cleanup didn't happen, there would be an unhandled rejection
      // when the timeout fires. This test verifies no error is thrown.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(result).toBeUndefined();
    });
  });
});
