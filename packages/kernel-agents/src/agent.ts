import type { LanguageModel } from '@metamask/kernel-language-model-service';
import { mergeDisjointRecords } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';

import { doAttempt } from './attempt.ts';
import { TaskManager } from './task.ts';
import type { Message, MessageTypeBase } from './types/messages.ts';
import type {
  Agent,
  CapabilityRecord,
  PrepareAttempt,
  TaskArgs,
} from './types.ts';
import { ifDefined } from './utils.ts';

export type MakeAgentArgs = {
  languageModel: LanguageModel<unknown, { response: string }>;
  capabilities: CapabilityRecord;
  logger?: Logger;
};

/**
 * Make a capability-augmented agent
 *
 * @param args - The arguments to make the agent.
 * @param args.languageModel - The language model to use for the agent
 * @param args.capabilities - The agent's capabilities
 * @param args.logger - The logger to use for the agent
 * @param prepareAttempt - A strategy function to prepare the attempt.
 * @returns A kernel agent
 */
export const makeAgent = <
  State extends Message<MessageTypeBase>[],
  Action extends Message<MessageTypeBase>,
  Observation extends Message<MessageTypeBase>,
>(
  {
    languageModel,
    capabilities: agentCapabilities,
    logger: agentLogger,
  }: MakeAgentArgs,
  prepareAttempt: PrepareAttempt<State, Action, Observation>,
): Agent => {
  const taskManager = new TaskManager();

  return {
    /**
     * Task the agent to fulfill an objective.
     *
     * @param intent - A string specifying the objective of the task.
     * @param judgment - A function that determines if the task is complete.
     * @param options - The options for the task.
     * @param options.invocationBudget - The maximum number of steps the agent is allowed to take.
     * @param options.seed - The seed for the task.
     * @param options.logger - The logger for the task.
     * @param options.capabilities - The capabilities for the task.
     * @param options.nAttempts - The number of attempts the agent is allowed to make.
     * @returns The result of the task.
     */
    task: async <Result>(
      intent: string,
      judgment?: (result: unknown) => result is Result,
      {
        invocationBudget = 10,
        seed = Date.now().valueOf(), // XXX: Replace with something more real
        logger: printLogger,
        capabilities: taskCapabilities = {},
        nAttempts = 1,
      }: TaskArgs = {},
    ) => {
      const capabilities = mergeDisjointRecords(
        agentCapabilities,
        taskCapabilities,
      ) as CapabilityRecord;

      const thisTask = taskManager.makeTask<Result>({
        intent,
        capabilities,
        ...ifDefined({ judgment }),
      });
      const { id: taskId, objective, context } = thisTask;
      const taskLogger = agentLogger?.subLogger({ tags: [taskId] });
      taskLogger?.info('intent:', intent);

      for (let attempt = 0; attempt < nAttempts; attempt++) {
        taskLogger?.info(`Attempt ${attempt + 1} of ${nAttempts}`);

        const [prep, state] = prepareAttempt({
          objective,
          context,
          options: ifDefined({ seed, printLogger, taskLogger }),
        });
        const { history } = state;
        try {
          const result = await doAttempt(
            prep,
            state,
            languageModel,
            ifDefined({ maxSteps: invocationBudget, logger: taskLogger }),
          );
          thisTask.attempts.push({ history, result });
          return result;
        } catch (error) {
          if (error instanceof Error) {
            thisTask.attempts.push({ history, error });
          } else {
            throw new Error(`Unknown error: ${error as string}`, {
              cause: error,
            });
          }
        }
      }
      const howManyAttempts = `${nAttempts} attempt${nAttempts === 1 ? '' : 's'}`;
      throw new Error(
        [
          `Failed to complete task in ${howManyAttempts}`,
          ...thisTask.attempts.map(
            (attempt, index) =>
              `${index + 1}: ${attempt.error?.message ?? 'Unknown'}`,
          ),
        ].join('\n'),
      );
    },
    /**
     * Get the experiences of the agent. Used for learning.
     *
     * @returns An iterator over the experiences.
     */
    get experiences() {
      return (async function* () {
        for (const task of taskManager.tasks) {
          for (const attempt of task.attempts) {
            yield {
              objective: task.objective,
              context: task.context,
              ...attempt,
            };
          }
        }
      })();
    },
  };
};
