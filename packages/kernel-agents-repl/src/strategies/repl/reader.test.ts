import '@ocap/repo-tools/test-utils/mock-endoify';

import type { Logger } from '@metamask/logger';
import { makeTestStream } from '@ocap/kernel-agents/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeTreeSitterParser } from './parse/tree-sitter.ts';
import { makeReader } from './reader.ts';

describe('reader', () => {
  const parser = makeTreeSitterParser();
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
    const reader = makeReader({ parser, logger });
    const statement = await reader({ stream, abort, stop });
    expect(statement.toReplString()).toBe('> console.log("hello");');
  });

  it('throws an error if the stream has no stop token', async () => {
    const { stream, abort } = makeTestStream(
      [`console.log("hello");`],
      transform,
    );
    const reader = makeReader({ parser, logger });
    await expect(reader({ stream, abort, stop: '</|>' })).rejects.toThrow(
      'Stream ended without a parse event',
    );
  });

  it('throws an error if the stream is empty', async () => {
    const stop = '</|>';
    const { stream, abort } = makeTestStream([], transform);
    const reader = makeReader({ parser, logger });
    await expect(reader({ stream, abort, stop })).rejects.toThrow(
      'Stream ended without a parse event',
    );
  });
});
