import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import type { Reader, Writer } from '@endo/stream';
import { makePipe } from '@endo/stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mocked } from 'vitest';

import { makeExoGenerator } from './exo-generator.ts';

vi.mock('@endo/eventual-send', () => ({
  E: vi.fn((obj) => obj),
}));

vi.mock('@endo/stream', () => ({
  makePipe: vi.fn(),
}));

vi.mock('./reader-ref.ts', () => ({
  makeIteratorRef: vi.fn((reader) => reader),
}));

describe('far-generator', () => {
  const mockWriter: Mocked<Writer<unknown>> = {
    next: vi.fn(),
    return: vi.fn(),
    throw: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(),
  };
  const mockReader: Mocked<Reader<unknown>> = {
    next: vi.fn(),
    return: vi.fn(),
    throw: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(() => mockReader),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(makePipe).mockReturnValue([mockWriter, mockReader]);
  });

  describe('makeExoGenerator', () => {
    it('should wrap a generator', async () => {
      const result = makeExoGenerator(
        (async function* () {
          // Empty generator
        })(),
      );

      // Verify that makeIteratorRef was called with the reader
      const { makeIteratorRef } = await import('./reader-ref.ts');
      expect(makeIteratorRef).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });

    it('should pipe values from the generator to the writer', async () => {
      const generated = makePromiseKit<string>();
      const result = makeExoGenerator(
        (async function* () {
          yield 'test';
          generated.resolve('yielded');
        })(),
      );

      await E(result).next();

      expect(await generated.promise).toBe('yielded');

      expect(mockWriter.next).toHaveBeenCalledOnce();
      expect(mockWriter.next).toHaveBeenCalledWith('test');
    });

    it('calls writer.throw if the generator throws', async () => {
      const generated = makePromiseKit<string>();
      const error = new Error('test');
      const result = makeExoGenerator(
        // oxlint-disable-next-line require-yield
        (async function* () {
          generated.resolve('threw');
          throw error;
        })(),
      );

      await E(result).next();

      expect(await generated.promise).toBe('threw');

      expect(mockWriter.throw).toHaveBeenCalledOnce();
      expect(mockWriter.throw).toHaveBeenCalledWith(error);
    });
  });
});
