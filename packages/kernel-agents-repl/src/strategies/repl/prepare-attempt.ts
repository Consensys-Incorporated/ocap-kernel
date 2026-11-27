import { mergeDisjointRecords } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import { extractCapabilitySchemas } from '@ocap/kernel-agents/capabilities/capability';
import { makeEnd } from '@ocap/kernel-agents/capabilities/end';
import type {
  PREP,
  Objective,
  Context,
  CapabilityRecord,
  Progress,
  PrepareAttempt,
} from '@ocap/kernel-agents/types';
import { ifDefined } from '@ocap/kernel-agents/utils';

import { makeEvaluator } from './evaluator.ts';
import type { State, Observation, Action } from './messages.ts';
import {
  InterjectionMessage,
  ImportMessage,
  ResultMessage,
} from './messages.ts';
import { makePrinter } from './printer.ts';
import { makePrompter } from './prompter.ts';
import { makeReader } from './reader.ts';

export const prepareAttempt: PrepareAttempt<State, Action, Observation> = <
  Result,
>({
  objective: { intent, judgment },
  context,
  options = {},
}: {
  objective: Objective<Result>;
  context: Context;
  options?: {
    seed?: number;
    tokenLength?: number;
    taskLogger?: Logger;
    printLogger?: Logger;
  };
}): [PREP<State, Action, Observation>, Progress<Result, State>] => {
  const { seed, tokenLength, taskLogger, printLogger } = options;

  const [end, didEnd, getEnd] = makeEnd();

  const capabilities = mergeDisjointRecords(context.capabilities, {
    end,
  }) as CapabilityRecord;

  const history = [
    new InterjectionMessage(intent),
    ImportMessage.fromNames(Object.keys(capabilities)),
    new ResultMessage({ value: extractCapabilitySchemas(capabilities) }),
  ];

  const progress: Progress<Result, State> = {
    history,
    isDone: () => {
      if (didEnd()) {
        const result = getEnd();
        if (!judgment(result)) {
          throw new Error(`Invalid result: ${result as string}`, {
            cause: result,
          });
        }
        Object.assign(progress, { result });
        return true;
      }
      return false;
    },
    // result: not defined until judgment is satisfied
  };

  const readLogger = taskLogger?.subLogger({ tags: ['read'] });
  const evalLogger = taskLogger?.subLogger({ tags: ['eval'] });

  return [
    [
      makePrompter(ifDefined({ seed, tokenLength })),
      makeReader(ifDefined({ logger: readLogger })),
      makeEvaluator(ifDefined({ capabilities, logger: evalLogger })),
      makePrinter({ history, ...ifDefined({ logger: printLogger }) }),
      // TODO: Fix these types
    ] as unknown as PREP<State, Action, Observation>,
    progress,
  ];
};
