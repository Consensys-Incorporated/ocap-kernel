import { EvaluatorError } from '@metamask/kernel-errors';
import { mergeDisjointRecords } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import { extractCapabilities } from '@ocap/kernel-agents/capabilities/capability';
import type { CapabilityRecord } from '@ocap/kernel-agents/types';
import { ifDefined } from '@ocap/kernel-agents/utils';

import { makeCompartment } from './compartment.ts';
import { processEvaluationError } from './evaluator-error.ts';
import {
  CommentMessage,
  EvaluationMessage,
  ImportMessage,
  ResultMessage,
} from './messages.ts';
import type { ReplTranscript, StatementMessage } from './messages.ts';
import { prepareEvaluation } from './prepare-evaluation.ts';
import { ERROR, RETURN } from './symbols.ts';
import type { EvaluatorState } from './types.ts';

const validateStatement = (
  statement: StatementMessage,
): { earlyResult?: ResultMessage | null } => {
  if (statement instanceof CommentMessage) {
    // Comments are not evaluated.
    return { earlyResult: null };
  }
  if (statement instanceof ImportMessage) {
    // Imports are not implemented yet.
    return {
      earlyResult: new ResultMessage({
        [ERROR]: new SyntaxError('Additional imports are not allowed.'),
      }),
    };
  }
  if (!(statement instanceof EvaluationMessage)) {
    // This should never happen.
    throw new Error(
      [
        'Internal: Unknown statement',
        `statement: ${statement.messageBody.node.text}`,
        `type: ${statement.messageBody.node.toString()}`,
      ].join('\n'),
    );
  }
  // Otherwise, proceed with the evaluation.
  return {};
};

export const makeEvaluator = ({
  capabilities = {},
  logger,
  // For testing purposes.
  initState = () => ({ consts: {}, lets: {} }),
}: {
  capabilities?: CapabilityRecord;
  logger?: Logger;
  initState?: () => EvaluatorState;
}) => {
  const state: EvaluatorState = initState();

  return async (
    history: ReplTranscript,
    statement: StatementMessage,
  ): Promise<ResultMessage | null> => {
    // Validate the statement.
    const validation = validateStatement(statement);
    if ('earlyResult' in validation) {
      const { earlyResult } = validation;
      history.push(statement, ...(earlyResult ? [earlyResult] : []));
      return earlyResult;
    }

    // Prepare the evaluation.
    const { code, endowments, result, commit } = prepareEvaluation(
      state,
      statement.messageBody.node,
      ifDefined({ logger }),
    );

    logger?.info('capabilities:', capabilities);
    logger?.info('evaluating:', code);

    // Prepare the compartment.
    const compartmentEndowments = mergeDisjointRecords(
      endowments,
      extractCapabilities(capabilities),
    );
    const compartment = makeCompartment(compartmentEndowments);

    try {
      await compartment.evaluate(code);
    } catch (cause) {
      const asError = (error: unknown): Error =>
        error instanceof Error ? error : new Error(String(error));
      // Errors that evade $catch are always an EvaluationError
      throw new EvaluatorError(
        'REPL evaluation failed',
        code,
        // If the error is already an EvaluatorError, we rethrow with the code,
        cause instanceof EvaluatorError
          ? (cause.cause as Error)
          : // Otherwise, wrap the error as EvaluatorError
            asError(cause),
      );
    }

    // Handle errors caught by $catch (user code errors)
    processEvaluationError(result, code);

    // Update the state and return the result
    const stepResult = [ERROR, RETURN, 'value'].some((key) =>
      Object.hasOwn(result, key),
    )
      ? new ResultMessage(result)
      : null;
    history.push(statement, ...(stepResult ? [stepResult] : []));
    commit();

    return stepResult;
  };
};
