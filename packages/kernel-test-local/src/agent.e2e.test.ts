import '@metamask/kernel-shims/endoify-node';

import { makeOpenV1NodejsService } from '@metamask/kernel-language-model-service';
import { makeOllamaNodejsKernelService } from '@metamask/kernel-language-model-service/ollama/nodejs';
import { makeTreeSitterWorkerParser } from '@ocap/kernel-agents-repl/parser/tree-sitter-worker';
import type {
  AgentStrategy,
  AgentVatParameters,
  AgentVatReport,
} from '@ocap/kernel-test/agent-vat';
import { fetchMock } from '@ocap/repo-tools/test-utils/fetch-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAgentVat } from './agent-vat.ts';
import { LMS_BASE_URL, LMS_CHAT_MODEL, LMS_PROVIDER } from './constants.ts';
import { randomLetter } from './utils.ts';

const parser = makeTreeSitterWorkerParser();

// Raw sampling, which the json and repl strategies need, is Ollama-only; chat
// completion is served by any Open /v1 endpoint.
const strategies: AgentStrategy[] =
  LMS_PROVIDER === 'ollama' ? ['json', 'repl', 'chat'] : ['chat'];

const retry = 2;
const timeout = 60_000;

describe('agent vat (e2e)', () => {
  beforeAll(() => {
    fetchMock.disableMocks();
  });

  afterAll(async () => {
    fetchMock.enableMocks();
    await parser.terminate();
  });

  describe.each(strategies)('%s agent', (strategy) => {
    runStrategy(strategy);
  });
});

/**
 * Declare the cases for one strategy.
 *
 * @param strategy - The strategy under test.
 */
function runStrategy(strategy: AgentStrategy): void {
  const run = async (
    parameters: Omit<AgentVatParameters, 'strategy' | 'model'>,
  ): Promise<AgentVatReport> => {
    const { chat } = makeOpenV1NodejsService({
      endowments: { fetch },
      baseUrl: LMS_BASE_URL,
    });
    const sample =
      LMS_PROVIDER === 'ollama'
        ? makeOllamaNodejsKernelService({ endowments: { fetch } }).sample
        : undefined;
    const report = await runAgentVat({
      parameters: { strategy, model: LMS_CHAT_MODEL, ...parameters },
      chat,
      ...(sample && { sample }),
      parser,
    });
    expect(report.error).toBeUndefined();
    return report;
  };

  it('processes a semantic request', { retry, timeout }, async () => {
    const categories = ['animal', 'vegetable', 'mineral'] as const;
    const category = categories[Math.floor(Math.random() * categories.length)];
    const letter = randomLetter().toUpperCase();
    const { result } = await run({
      intent: `Name a kind of ${category} that starts with the letter "${letter}"`,
    });
    expect(result).toMatch(new RegExp(letter, 'iu'));
  });

  it('uses tools', { retry, timeout }, async () => {
    const { invocations } = await run({
      intent: 'Is it a full moon tonight?',
      capabilities: ['getMoonPhase'],
    });
    expect(invocations.some((line) => line.startsWith('getMoonPhase'))).toBe(
      true,
    );
  });

  it('adds with the add capability', { retry, timeout }, async () => {
    const { invocations, result } = await run({
      intent: 'What is 123 plus 456? Use the add capability to compute it.',
      capabilities: ['add'],
    });
    expect(invocations.some((line) => line.startsWith('add'))).toBe(true);
    expect(result).toContain('579');
  });

  it('performs multi-step calculations', { retry, timeout }, async () => {
    const [length, width, height] = [11, 47, 63];
    const { result } = await run({
      intent: `A box with length ${length}, width ${width}, and height ${height} have volume V. How many digits are in the numerical value of V?`,
      capabilities: ['count', 'add', 'multiply'],
    });
    expect(result).toContain(`${length * width * height}`.length.toString());
  });

  it(
    'writes complex code to solve a problem',
    // Caveat: We don't expect the solution to be correct.
    { retry, timeout: 120_000 },
    async () => {
      const { result } = await run({
        intent: [
          'Let S2(42) be the set of all sets of positive two digit numbers that sum to 42.',
          'For example, the sets { 42 }, { 19, 24 }, and { 10, 12, 20 } are elements of S2(42),',
          'but { 10, 12 } is not because 10 + 12 does not equal 42,',
          'and { 2, 40 } is not because 2 is not a two digit number.',
          'What is |S2(42)|?',
        ].join('\n'),
        invocationBudget: 42,
      });
      expect(result).toBeDefined();
    },
  );

  it.skipIf(strategy !== 'repl')(
    'imports capabilities',
    { retry, timeout },
    // TODO: This functionality is not yet implemented.
    async () => {
      const { result } = await run({
        intent: `What is the current moon phase? You may want to import { getMoonPhase } from "@ocap/abilities"`,
      });
      expect(result).toBeDefined();
    },
  );
}
