import {
  LANGUAGE_MODEL_SERVICE_NAME,
  makeKernelLanguageModelService,
} from '@metamask/kernel-language-model-service';
import type {
  ChatParams,
  ChatResult,
  SampleParams,
  SampleResult,
} from '@metamask/kernel-language-model-service';
import { makeMockSample } from '@metamask/kernel-language-model-service/test-utils';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import {
  PARSER_SERVICE_NAME,
  makeKernelParserService,
} from '@ocap/kernel-agents-repl';
import { makeTreeSitterWorkerParser } from '@ocap/kernel-agents-repl/parser/tree-sitter-worker';
import { afterAll, describe, expect, it } from 'vitest';

import { getAgentVatBundleSpec, reportFromLogs } from './agent-vat.ts';
import type { AgentVatParameters, AgentVatReport } from './agent-vat.ts';
import { makeKernel, makeTestLogger, runTestVats } from './utils.ts';

type Sample = (params: SampleParams) => Promise<SampleResult>;
type Chat = (params: ChatParams) => Promise<ChatResult>;

const parser = makeTreeSitterWorkerParser();

/**
 * Launch the agent vat on a fresh kernel whose language model service answers
 * from the given backends, and wait for the agent to finish.
 *
 * @param args - The arguments.
 * @param args.parameters - The vat's parameters.
 * @param args.sample - The sample backend, for the `json` and `repl` strategies.
 * @param args.chat - The chat backend, for the `chat` strategy.
 * @returns The bootstrap result and the vat's report.
 */
const runAgentVat = async ({
  parameters,
  sample = makeMockSample([]),
  chat = async () => {
    throw new Error('chat not mocked');
  },
}: {
  parameters: AgentVatParameters;
  sample?: Sample;
  chat?: Chat;
}): Promise<{ result: unknown; report: AgentVatReport }> => {
  const kernelDatabase = await makeSQLKernelDatabase({
    dbFilename: ':memory:',
  });
  const { logger, entries } = makeTestLogger();
  const kernel = await makeKernel(kernelDatabase, true, logger);

  const languageModel = makeKernelLanguageModelService({ chat, sample });
  kernel.registerKernelServiceObject(languageModel.name, languageModel.service);
  const parserService = makeKernelParserService(parser);
  kernel.registerKernelServiceObject(parserService.name, parserService.service);

  const result = await runTestVats(kernel, {
    bootstrap: 'agent',
    services: [LANGUAGE_MODEL_SERVICE_NAME, PARSER_SERVICE_NAME],
    vats: {
      agent: { bundleSpec: getAgentVatBundleSpec(), parameters },
    },
  });
  await waitUntilQuiescent(100);
  return { result, report: reportFromLogs(entries) };
};

/**
 * The JSON strategy's prompt ends with `{"messageType":"assistant","`, which
 * the reader prepends to the sample, so a scripted answer starts mid-object.
 *
 * @param messages - The assistant messages to answer with, in order.
 * @returns The sample backend.
 */
const makeJsonSample = (messages: string[]): Sample =>
  makeMockSample(messages.map((message) => `invoke":${message}}`));

/**
 * The REPL strategy's prompt ends with an opening token and a `>` prompt, and
 * its reader collects the sample up to the matching closing token, which is
 * random per task. This backend recovers the token from each prompt.
 *
 * @param statements - The statements to answer with, in order.
 * @returns The sample backend.
 */
const makeReplSample = (statements: string[]): Sample => {
  let index = 0;
  return async ({ prompt }) => {
    const match = /〚(?<token>[^〛]+)〛>$/u.exec(prompt);
    const token = match?.groups?.token;
    if (!token) {
      throw new Error(`No REPL token at the end of the prompt: ${prompt}`);
    }
    const statement = statements[index] ?? '';
    index += 1;
    return harden({ text: ` ${statement}〚/${token}〛` });
  };
};

/**
 * @param turns - The assistant turns to answer with, in order: tool calls,
 * or a final content string.
 * @returns The chat backend.
 */
const makeChat = (
  turns: ({ name: string; args: object }[] | string)[],
): Chat => {
  let index = 0;
  return async () => {
    const turn = turns[index] ?? '';
    index += 1;
    const message =
      typeof turn === 'string'
        ? { role: 'assistant' as const, content: turn }
        : {
            role: 'assistant' as const,
            content: null,
            tool_calls: turn.map(({ name, args }, callIndex) => ({
              id: `call-${index}-${callIndex}`,
              type: 'function' as const,
              function: { name, arguments: JSON.stringify(args) },
            })),
          };
    return harden({
      id: `chat-${index}`,
      model: 'test-model',
      choices: [{ index: 0, message, finish_reason: 'stop' as const }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  };
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
        chat: makeChat([[{ name: 'add', args: { summands: [1, 2] } }], final]),
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
