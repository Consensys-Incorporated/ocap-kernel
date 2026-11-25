import '@ocap/repo-tools/test-utils/mock-endoify';

import { describe, it, expect, vi } from 'vitest';

import { serveParser } from './tree-sitter-worker.ts';
import type { ParseRequest, ParseResponse } from './tree-sitter-worker.ts';

const makePort = () => {
  let listener: ((request: ParseRequest) => void) | undefined;
  const responses: ParseResponse[] = [];
  return {
    port: {
      on: vi.fn((_event: 'message', next: (request: ParseRequest) => void) => {
        listener = next;
      }),
      postMessage: vi.fn((response: ParseResponse) => {
        responses.push(response);
      }),
    },
    request: (request: ParseRequest) => listener?.(request),
    responses,
  };
};

describe('serveParser', () => {
  it('answers a request with the parsed tree', () => {
    const { port, request, responses } = makePort();
    serveParser(port);
    request({ id: 7, code: 'x;' });
    expect(responses).toStrictEqual([
      {
        id: 7,
        tree: {
          type: 'program',
          text: 'x;',
          isNamed: true,
          children: [
            {
              type: 'expression_statement',
              text: 'x;',
              isNamed: true,
              children: [
                { type: 'identifier', text: 'x', isNamed: true, children: [] },
                { type: ';', text: ';', isNamed: false, children: [] },
              ],
            },
          ],
        },
      },
    ]);
  });

  it('answers a failed parse with the error message', () => {
    const { port, request, responses } = makePort();
    serveParser(port);
    // tree-sitter rejects a non-string input.
    request({ id: 1, code: 1 as unknown as string });
    expect(responses).toStrictEqual([{ id: 1, error: expect.any(String) }]);
  });
});
