import { SampleGenerationError } from '@metamask/kernel-errors';
import type { LanguageModel } from '@metamask/kernel-language-model-service';
import type { Logger } from '@metamask/logger';

import type { Message, MessageTypeBase } from './types/messages.ts';
import type { PREP, Progress } from './types.ts';
import { withRetries } from './utils.ts';

export const doAttempt = async <
  Result,
  State extends Message<MessageTypeBase>[],
  Action extends Message<MessageTypeBase>,
  Observation extends Message<MessageTypeBase>,
>(
  [prompter, reader, evaluator, printer]: PREP<State, Action, Observation>,
  progress: Progress<Result, State>,
  languageModel: LanguageModel<unknown, { response: string }>,
  {
    maxSteps = 10,
    maxRetries = 3,
    logger,
  }: {
    maxSteps?: number;
    maxRetries?: number;
    logger?: Logger;
  },
): Promise<Result> => {
  const { history } = progress;

  for (let step = 1; step <= maxSteps; step++) {
    logger?.info(`Step ${step} of ${maxSteps}`);

    const actionAndOutcome = await withRetries(
      async () => {
        // Observe
        const { prompt, readerArgs } = prompter(history);

        // Act
        const { stream, abort } = await languageModel.sample(prompt);
        const action = await reader({ stream, abort, ...readerArgs });

        // Step
        const outcome = await evaluator(history, action);
        return [action, outcome];
      },
      maxRetries,
      (error) => error instanceof SampleGenerationError,
    );

    // If done, exit
    if (progress.isDone()) {
      const { result } = progress;
      logger?.info('done:', result);
      return result as Result;
    }

    // Render
    printer(...actionAndOutcome);
  }
  throw new Error('Invocation budget exceeded');
};
