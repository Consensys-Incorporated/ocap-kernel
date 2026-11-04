import '@ocap/repo-tools/test-utils/mock-endoify';

import { describe, it, expect, vi } from 'vitest';

import {
  PARSER_SERVICE_NAME,
  makeKernelParserService,
  makeParserClient,
} from './service.ts';
import type { Parser, SyntaxTree } from './syntax-tree.ts';

// The mock shim has no `HandledPromise`, so eventual sends become local calls.
vi.mock('@endo/eventual-send', () => ({
  E: (target: unknown) => target,
}));

const tree: SyntaxTree = {
  type: 'program',
  text: '',
  isNamed: true,
  children: [],
};

describe('makeKernelParserService', () => {
  it('names the service and delegates parse', async () => {
    const parse = vi.fn(async () => tree);
    const { name, service } = makeKernelParserService({ parse });
    expect(name).toBe(PARSER_SERVICE_NAME);
    expect(await (service as Parser).parse('x;')).toBe(tree);
    expect(parse).toHaveBeenCalledWith('x;');
  });
});

describe('makeParserClient', () => {
  it('sends parse to the service reference', async () => {
    const parse = vi.fn(async () => tree);
    const client = makeParserClient({ parse });
    expect(await client.parse('x;')).toBe(tree);
    expect(parse).toHaveBeenCalledWith('x;');
  });
});
