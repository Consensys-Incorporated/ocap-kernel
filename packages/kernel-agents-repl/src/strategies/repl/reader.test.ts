import '@ocap/repo-tools/test-utils/mock-endoify';

import { SampleGenerationError } from '@metamask/kernel-errors';
import type { Logger } from '@metamask/logger';
import { makeTestStream } from '@ocap/kernel-agents/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeReader } from './reader.ts';

describe('reader', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      subLogger: vi.fn(() => logger),
    } as unknown as Logger;
  });

  const transform = (statement: string) => ({ response: statement });

  it('reads a statement from a stream', async () => {
    const stop = '</|>';
    const { stream, abort } = makeTestStream(
      [`console.log("hello");${stop}`],
      transform,
    );
    const reader = makeReader({ logger });
    const statement = await reader({ stream, abort, stop });
    expect(statement.toReplString()).toBe('> console.log("hello");');
  });

  it.each([
    ['an invalid statement', 'const = 1;'],
    ['a valid statement followed by invalid code', 'f();\n```'],
  ])('rejects %s as a sample to retry', async (_case, code) => {
    const stop = '</|>';
    const { stream, abort } = makeTestStream([`${code}${stop}`], transform);
    const reader = makeReader({ logger });
    await expect(reader({ stream, abort, stop })).rejects.toThrow(
      SampleGenerationError,
    );
  });

  it('throws an error if the stream has no stop token', async () => {
    const { stream, abort } = makeTestStream(
      [`console.log("hello");`],
      transform,
    );
    const reader = makeReader({ logger });
    await expect(reader({ stream, abort, stop: '</|>' })).rejects.toThrow(
      'Stream ended without a parse event',
    );
  });

  it('throws an error if the stream is empty', async () => {
    const stop = '</|>';
    const { stream, abort } = makeTestStream([], transform);
    const reader = makeReader({ logger });
    await expect(reader({ stream, abort, stop })).rejects.toThrow(
      'Stream ended without a parse event',
    );
  });
});
