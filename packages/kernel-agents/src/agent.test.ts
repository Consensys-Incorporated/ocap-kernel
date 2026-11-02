import '@ocap/repo-tools/test-utils/mock-endoify';

import { Logger } from '@metamask/logger';
import { vi, describe, it, expect } from 'vitest';

import { makeJsonAgent } from './strategies/json-agent.ts';

const prompt = 'test prompt';
const prefix = '{"messageType":"assistant","';

vi.mock('./strategies/json/prompter.ts', () => ({
  makePrompter: vi.fn(() => () => ({ prompt, readerArgs: { prefix } })),
}));

const logger = new Logger('test');

describe.each([
  ['Json', makeJsonAgent, [`invoke":[{"name":"end","args":{"final":"x"}}]}`]],
])('make%sAgent', (strategy, makeAgent, endStatement) => {
  const mockLlm = (...chunks: string[]) => ({
    getInfo: vi.fn(),
    load: vi.fn(),
    unload: vi.fn(),
    sample: vi.fn().mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) {
            yield { response: chunk };
          }
        },
      },
      abort: vi.fn(),
    }),
  });

  it('makes an agent', () => {
    const languageModel = mockLlm();
    const agent = makeAgent({ languageModel, capabilities: {} });
    expect(agent).toBeDefined();
    expect(agent).toHaveProperty('task');
  });

  describe('task', () => {
    it('invokes the LLM', async () => {
      const languageModel = mockLlm(...endStatement);
      const agent = makeAgent({ languageModel, capabilities: {}, logger });
      const result = await agent.task('');
      expect(result).toBe('x');
      // This is a massive understatement, but we don't want to test the prompt
      expect(languageModel.sample).toHaveBeenCalledWith(prompt);
    });

    it.skipIf(strategy !== 'Json')(
      'throws if the LLM did not invoke a capability',
      async () => {
        // LLM finishes valid JSON, but no invoke property
        const languageModel = mockLlm(`content":""}`);
        const agent = makeAgent({ languageModel, capabilities: {} });
        const task = agent.task('');
        await expect(task).rejects.toThrow('No invoke in message');
      },
    );

    it('runs without a clock', async () => {
      const now = vi.spyOn(Date, 'now').mockImplementation(() => {
        throw new Error('No clock in a vat');
      });
      const languageModel = mockLlm(...endStatement);
      const agent = makeAgent({ languageModel, capabilities: {} });
      expect(await agent.task('')).toBe('x');
      now.mockRestore();
    });

    it('throws if invocation budget is exceeded', async () => {
      const languageModel = mockLlm(...endStatement);
      const agent = makeAgent({ languageModel, capabilities: {} });
      const task = agent.task('', undefined, { invocationBudget: 0 });
      await expect(task).rejects.toThrow('Invocation budget exceeded');
    });

    it('logs to the provided logger', async () => {
      const languageModel = mockLlm(...endStatement);
      const testLogger = {
        info: vi.fn(),
        subLogger: vi.fn(() => testLogger),
      } as unknown as Logger;
      const agent = makeAgent({
        languageModel,
        capabilities: {},
        logger: testLogger,
      });
      await agent.task('test', undefined, { invocationBudget: 1 });
      expect(testLogger.info).toHaveBeenCalledWith('intent:', 'test');
      expect(testLogger.subLogger).toHaveBeenCalledWith({ tags: ['t001'] });
    });
  });
});
