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
import { toSExpression } from './parse/syntax-tree.ts';
import type { SyntaxTree } from './parse/syntax-tree.ts';
import { prepareEvaluation } from './prepare-evaluation.ts';
import { ERROR, RETURN } from './symbols.ts';
import type { EvaluatorState } from './types.ts';

type Validation =
  | { earlyResult: ResultMessage | null }
  | { earlyResult?: never; node: SyntaxTree };

const validateStatement = (statement: StatementMessage): Validation => {
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
  const { code, node } = statement.messageBody;
  if (!(statement instanceof EvaluationMessage) || !node) {
    // This should never happen.
    throw new Error(
      [
        'Internal: Unknown statement',
        `statement: ${code}`,
        `type: ${node ? toSExpression(node) : 'unparsed'}`,
      ].join('\n'),
    );
  }
  // Otherwise, proceed with the evaluation.
  return { node };
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
      validation.node,
      ifDefined({ logger }),
    );

    logger?.info('capabilities:', capabilities);
    logger?.info('endowments:', endowments);
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
