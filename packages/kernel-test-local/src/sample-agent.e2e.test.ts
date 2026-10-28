import '@ocap/repo-tools/test-utils/mock-endoify';

import { makeOllamaNodejsKernelService } from '@metamask/kernel-language-model-service/ollama/nodejs';
import { makeConsoleTransport, Logger } from '@metamask/logger';
import type { MakeAgentArgs, Agent } from '@ocap/kernel-agents';
import { getMoonPhase } from '@ocap/kernel-agents/capabilities/examples';
import { count, add, multiply } from '@ocap/kernel-agents/capabilities/math';
import { makeJsonAgent } from '@ocap/kernel-agents/json';
import { makeReplAgent } from '@ocap/kernel-agents-repl';
import { fetchMock } from '@ocap/repo-tools/test-utils/fetch-mock';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { DEFAULT_MODEL, LMS_PROVIDER } from './constants.ts';
import { filterTransports, randomLetter } from './utils.ts';

const logger = new Logger({
  tags: ['test'],
  transports: [filterTransports(makeConsoleTransport())],
});

const makeJsonAgentWithMathCapabilities = (args: MakeAgentArgs) =>
  makeJsonAgent({
    ...args,
    capabilities: { count, add, multiply, ...args.capabilities },
  });

describe.skipIf(LMS_PROVIDER !== 'ollama').each([
  ['json', makeJsonAgentWithMathCapabilities],
  ['repl', makeReplAgent],
])(
  '%s agent',
  (strategy: string, makeAgent: (args: MakeAgentArgs) => Agent) => {
    let result: unknown;
    const retry = 2;
    const timeout = 60_000;

    const printLogger = new Logger({
      tags: [strategy],
      transports: [
        ({ message, data, level }) => console[level](message, ...(data ?? [])),
      ],
    });

    const catchErrorAsResult = <
      Func extends (...args: unknown[]) => Promise<unknown>,
    >(
      func: Func,
    ): Func =>
      (async (...args: unknown[]) => {
        try {
          return await func(...args);
        } catch (error) {
          result = error;
          throw error;
        }
      }) as Func;

    beforeAll(() => {
      fetchMock.disableMocks();
    });

    afterAll(() => {
      fetchMock.enableMocks();
    });

    let service: ReturnType<typeof makeOllamaNodejsKernelService>;
    beforeEach(() => {
      result = undefined;
      service = makeOllamaNodejsKernelService({ endowments: { fetch } });
      printLogger.log(`\n<== New ${strategy.toUpperCase()} ===`);
    });

    afterEach(() => {
      printLogger.log('=== ======== ===');
      printLogger.log(`~ ${result as string}`);
      printLogger.log(`=== End ${strategy.toUpperCase()} ==>`);
    });

    const makeLanguageModel = (svc: typeof service) => ({
      getInfo: async () => ({ model: DEFAULT_MODEL, options: {} }),
      load: async () => undefined,
      unload: async () => undefined,
      sample: async (prompt: string) =>
        svc.sample({ model: DEFAULT_MODEL, prompt, stream: true }),
    });

    it(
      'processes a semantic request',
      { retry, timeout },
      catchErrorAsResult(async () => {
        const languageModel = makeLanguageModel(service);
        const agent = makeAgent({ languageModel, capabilities: {}, logger });
        expect(agent).toBeDefined();

        const categories = ['animal', 'vegetable', 'mineral'] as const;
        const category =
          categories[Math.floor(Math.random() * categories.length)];

        const letter = randomLetter().toUpperCase();
        const query = `Name a kind of ${category} that starts with the letter "${letter}"`;
        const containsLetter = (content: string): boolean =>
          content.includes(letter) || content.includes(letter.toLowerCase());
        type CategoryElement = string;
        const judgment = (content: unknown): content is CategoryElement =>
          // In a multi-agent system, we might another LLM to judge the result.
          // For now, we'll just check the type and length.
          typeof content === 'string' &&
          content.length > 0 &&
          containsLetter(content);
        result = await agent.task(query, judgment, { logger: printLogger });
        expect(result).toBeDefined();
        expect((result as string).length).toBeGreaterThan(0);
        expect(containsLetter(result as string)).toBe(true);
      }),
    );

    it(
      'uses tools',
      { retry, timeout },
      catchErrorAsResult(async () => {
        const languageModel = makeLanguageModel(service);
        const getMoonPhaseSpy = vi.spyOn(getMoonPhase, 'func');
        const agent = makeAgent({
          languageModel,
          capabilities: { getMoonPhase },
          logger,
        });
        expect(agent).toBeDefined();
        const query = `Is it a full moon tonight?`;
        result = await agent.task(query, undefined, { logger: printLogger });

        expect(result).toBeDefined();
        expect(getMoonPhaseSpy).toHaveBeenCalled();
      }),
    );

    it(
      'performs multi-step calculations',
      { retry, timeout },
      catchErrorAsResult(async () => {
        const languageModel = makeLanguageModel(service);
        const capabilities = {};
        const agent = makeAgent({ languageModel, capabilities, logger });
        expect(agent).toBeDefined();
        const [length, width, height] = [11, 47, 63];
        const query = `A box with length ${length}, width ${width}, and height ${height} have volume V. How many digits are in the numerical value of V?`;
        result = await agent.task(query, undefined, { logger: printLogger });
        expect(result).toBeDefined();
        expect(result).includes(`${length * width * height}`.length.toString());
      }),
    );

    it(
      'writes complex code to solve a problem',
      // Caveat: We don't expect the solution to be correct.
      { retry, timeout: 120_000 },
      catchErrorAsResult(async () => {
        const languageModel = makeLanguageModel(service);
        const capabilities = {};
        const agent = makeAgent({ languageModel, capabilities, logger });
        expect(agent).toBeDefined();
        const query = [
          'Let S2(42) be the set of all sets of positive two digit numbers that sum to 42.',
          'For example, the sets { 42 }, { 19, 24 }, and { 10, 12, 20 } are elements of S2(42),',
          'but { 10, 12 } is not because 10 + 12 does not equal 42,',
          'and { 2, 40 } is not because 2 is not a two digit number.',
          'What is |S2(42)|?',
        ].join('\n');
        result = await agent.task(query, undefined, {
          logger: printLogger,
          invocationBudget: 42,
        });
        expect(result).toBeDefined();
      }),
    );

    it.skipIf(strategy === 'json')(
      'imports capabilities',
      { retry, timeout },
      // TODO: This functionality is not yet implemented.
      catchErrorAsResult(async () => {
        const languageModel = makeLanguageModel(service);
        const capabilities = {};
        const agent = makeAgent({ languageModel, capabilities, logger });
        expect(agent).toBeDefined();
        const query = `What is the current moon phase? You may want to import { getMoonPhase } from "@ocap/abilities"`;
        result = await agent.task(query, undefined, { logger: printLogger });
        expect(result).toBeDefined();
      }),
    );
  },
);
