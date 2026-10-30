import { makeMockChat } from '@metamask/kernel-language-model-service/test-utils';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { makeTreeSitterWorkerParser } from '@ocap/kernel-agents-repl/parser/tree-sitter-worker';
import { afterAll, describe, expect, it } from 'vitest';

import {
  launchAgentVat,
  makeJsonSample,
  makeReplSample,
  reportFromLogs,
} from './agent-vat.ts';
import type {
  AgentVatParameters,
  AgentVatReport,
  ChatBackend,
  SampleBackend,
} from './agent-vat.ts';
import { makeKernel, makeTestLogger } from './utils.ts';

const parser = makeTreeSitterWorkerParser();

/**
 * `launchAgentVat` on a fresh kernel.
 *
 * @param args - As for `launchAgentVat`, less the parser.
 * @returns The bootstrap result and the vat's report.
 */
const runAgentVat = async (args: {
  parameters: AgentVatParameters;
  sample?: SampleBackend;
  chat?: ChatBackend;
}): Promise<{ result: unknown; report: AgentVatReport }> => {
  const kernelDatabase = await makeSQLKernelDatabase({
    dbFilename: ':memory:',
  });
  const { logger, entries } = makeTestLogger();
  const kernel = await makeKernel(kernelDatabase, true, logger);
  const result = await launchAgentVat(kernel, { ...args, parser });
  return { result, report: reportFromLogs(entries) };
};

const intent = 'What is 1 plus 2?';
const final = 'The sum is 3.';

describe('agent vat', () => {
  afterAll(async () => {
    await parser.terminate();
  });

  it.each([
    [
      'json',
      {
        sample: makeJsonSample([
          '[{"name":"add","args":{"summands":[1,2]}}]',
          `[{"name":"end","args":{"final":"${final}"}}]`,
        ]),
      },
    ],
    [
      'repl',
      {
        sample: makeReplSample([
          'await add({ summands: [1, 2] });',
          `await end({ final: "${final}" });`,
        ]),
      },
    ],
    [
      'chat',
      {
        chat: makeMockChat([
          [{ name: 'add', args: { summands: [1, 2] } }],
          final,
        ]),
      },
    ],
  ] as const)(
    'runs the %s agent against the kernel language model service',
    async (strategy, backends) => {
      const { result, report } = await runAgentVat({
        parameters: {
          strategy,
          model: 'test-model',
          intent,
          capabilities: ['add'],
        },
        ...backends,
      });
      expect(report).toStrictEqual({
        invocations: ['add {"summands":[1,2]}'],
        result: final,
      });
      expect(result).toBe(final);
    },
  );

  it('reports an agent that exhausts its budget', async () => {
    const { result, report } = await runAgentVat({
      parameters: {
        strategy: 'json',
        model: 'test-model',
        intent,
        capabilities: ['count'],
        invocationBudget: 1,
      },
      sample: makeJsonSample(['[{"name":"count","args":{"word":"three"}}]']),
    });
    expect(report).toStrictEqual({
      invocations: ['count {"word":"three"}'],
      error:
        'Failed to complete task in 1 attempt\n1: Invocation budget exceeded',
    });
    expect(result).toBeUndefined();
  });
});
