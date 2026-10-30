import '@metamask/kernel-shims/endoify-node';

import { makeTreeSitterWorkerParser } from '@ocap/kernel-agents-repl/parser/tree-sitter-worker';
import { makeJsonSample } from '@ocap/kernel-test/agent-vat';
import { afterAll, describe, expect, it } from 'vitest';

import { runAgentVat } from './agent-vat.ts';

const parser = makeTreeSitterWorkerParser();

describe('runAgentVat', () => {
  afterAll(async () => {
    await parser.terminate();
  });

  it('runs an agent on a kernel and reports what it did', async () => {
    const report = await runAgentVat({
      parameters: {
        strategy: 'json',
        model: 'test-model',
        intent: 'What is 1 plus 2?',
        capabilities: ['add'],
      },
      sample: makeJsonSample([
        '[{"name":"add","args":{"summands":[1,2]}}]',
        '[{"name":"end","args":{"final":"The sum is 3."}}]',
      ]),
      parser,
    });
    expect(report).toStrictEqual({
      invocations: ['add {"summands":[1,2]}'],
      result: 'The sum is 3.',
    });
  });
});
