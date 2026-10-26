import '@ocap/repo-tools/test-utils/mock-endoify';

import type { Logger } from '@metamask/logger';
import type { LanguageModel } from '@ocap/kernel-language-model-service';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { doAttempt } from './attempt.ts';
import { makeTestStream } from './test-utils.ts';
import type { PREP, Progress } from './types/agent.ts';
import { Message } from './types/messages.ts';

class TestMessage extends Message<string> {
  constructor(messageType: string, messageBody: Record<string, unknown> = {}) {
    super(messageType, messageBody);
  }
}

describe('doAttempt', () => {
  let mockPrompter: ReturnType<typeof vi.fn>;
  let mockReader: ReturnType<typeof vi.fn>;
  let mockEvaluator: ReturnType<typeof vi.fn>;
  let mockPrinter: ReturnType<typeof vi.fn>;
  let mockLanguageModel: { sample: ReturnType<typeof vi.fn> };
  let prep: PREP<TestMessage[], TestMessage, TestMessage>;
  let logger: Logger;

  beforeEach(() => {
    mockPrompter = vi.fn();
    mockReader = vi.fn();
    mockEvaluator = vi.fn();
    mockPrinter = vi.fn();
    mockLanguageModel = { sample: vi.fn() };
    logger = {
      info: vi.fn(),
      subLogger: vi.fn(() => logger),
    } as unknown as Logger;
    prep = [
      mockPrompter,
      mockReader,
      mockEvaluator,
      mockPrinter,
    ] as unknown as PREP<TestMessage[], TestMessage, TestMessage>;
  });

  const makeProgress = (
    history: TestMessage[],
    isDone: () => boolean,
    result?: string,
  ): Progress<string, TestMessage[]> => {
    const progress: Progress<string, TestMessage[]> = {
      history,
      isDone,
    };
    if (result !== undefined) {
      progress.result = result;
    }
    return progress;
  };

  it('returns result when done on first step', async () => {
    const history: TestMessage[] = [];
    const action = new TestMessage('action');
    const observation = new TestMessage('observation');
    const result = 'test result';

    mockPrompter.mockReturnValue({ prompt: 'test prompt', readerArgs: {} });
    mockLanguageModel.sample.mockResolvedValue(makeTestStream(['response']));
    mockReader.mockResolvedValue(action);
    mockEvaluator.mockResolvedValue(observation);

    const actual = await doAttempt(
      prep,
      makeProgress(
        history,
        vi.fn(() => true),
        result,
      ),
      mockLanguageModel as unknown as LanguageModel<
        unknown,
        { response: string }
      >,
      { maxSteps: 10, logger },
    );

    expect(actual).toBe(result);
    expect(mockPrompter).toHaveBeenCalledWith(history);
    expect(mockLanguageModel.sample).toHaveBeenCalledWith('test prompt');
    expect(mockEvaluator).toHaveBeenCalledWith(history, action);
    expect(mockPrinter).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Step 1 of 10');
    expect(logger.info).toHaveBeenCalledWith('done:', result);
  });

  it('returns result after multiple steps', async () => {
    const history: TestMessage[] = [];
    const action1 = new TestMessage('action1');
    const action2 = new TestMessage('action2');
    const observation1 = new TestMessage('observation1');
    const observation2 = new TestMessage('observation2');
    const result = 'final result';

    let callCount = 0;
    mockPrompter.mockImplementation(() => ({
      // The ++ operator is exactly what we want here.
      // oxlint-disable-next-line no-plusplus
      prompt: `prompt ${++callCount}`,
      readerArgs: {},
    }));
    mockLanguageModel.sample.mockResolvedValue(makeTestStream(['response']));
    mockReader.mockResolvedValueOnce(action1).mockResolvedValueOnce(action2);
    mockEvaluator
      .mockResolvedValueOnce(observation1)
      .mockResolvedValueOnce(observation2);

    const actual = await doAttempt(
      prep,
      makeProgress(
        history,
        vi.fn(() => callCount === 2),
        result,
      ),
      mockLanguageModel as unknown as LanguageModel<
        unknown,
        { response: string }
      >,
      { maxSteps: 10 },
    );

    expect(actual).toBe(result);
    expect(mockPrompter).toHaveBeenCalledTimes(2);
    expect(mockPrinter).toHaveBeenCalledWith(action1, observation1);
  });

  it('passes readerArgs to reader', async () => {
    const history: TestMessage[] = [];
    const action = new TestMessage('action');
    const readerArgs = { stop: '</|>', prefix: 'test' };

    mockPrompter.mockReturnValue({ prompt: 'test prompt', readerArgs });
    mockLanguageModel.sample.mockResolvedValue(makeTestStream(['response']));
    mockReader.mockResolvedValue(action);
    mockEvaluator.mockResolvedValue(new TestMessage('observation'));

    await doAttempt(
      prep,
      makeProgress(
        history,
        vi.fn(() => true),
        'result',
      ),
      mockLanguageModel as unknown as LanguageModel<
        unknown,
        { response: string }
      >,
      { maxSteps: 10 },
    );

    expect(mockReader).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: expect.anything(),
        abort: expect.any(Function),
        ...readerArgs,
      }),
    );
  });

  it('throws error when maxSteps is exceeded', async () => {
    const history: TestMessage[] = [];
    const action = new TestMessage('action');

    mockPrompter.mockReturnValue({ prompt: 'test prompt', readerArgs: {} });
    mockLanguageModel.sample.mockResolvedValue(makeTestStream(['response']));
    mockReader.mockResolvedValue(action);
    mockEvaluator.mockResolvedValue(new TestMessage('observation'));

    const attempt = doAttempt(
      prep,
      makeProgress(
        history,
        vi.fn(() => false),
      ),
      mockLanguageModel as unknown as LanguageModel<
        unknown,
        { response: string }
      >,
      { maxSteps: 3 },
    );

    await expect(attempt).rejects.toThrow('Invocation budget exceeded');
    expect(mockPrompter).toHaveBeenCalledTimes(3);
    expect(mockPrinter).toHaveBeenCalledTimes(3);
  });

  it('handles null observation from evaluator', async () => {
    const history: TestMessage[] = [];
    const action = new TestMessage('action');

    mockPrompter.mockReturnValue({ prompt: 'test prompt', readerArgs: {} });
    mockLanguageModel.sample.mockResolvedValue(makeTestStream(['response']));
    mockReader.mockResolvedValue(action);
    mockEvaluator.mockResolvedValue(null);

    await doAttempt(
      prep,
      makeProgress(
        history,
        vi
          .fn(() => false)
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true),
        'result',
      ),
      mockLanguageModel as unknown as LanguageModel<
        unknown,
        { response: string }
      >,
      { maxSteps: 10 },
    );

    expect(mockPrinter).toHaveBeenCalledWith(action, null);
  });
});
