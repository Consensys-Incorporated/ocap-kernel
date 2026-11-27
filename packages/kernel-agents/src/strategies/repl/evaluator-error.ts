import { SampleGenerationError, EvaluatorError } from '@metamask/kernel-errors';

import type { EvaluationResult } from './prepare-evaluation.ts';
import { ERROR } from './symbols.ts';

/**
 * Strips stack traces from an error while preserving the message and cause chain.
 *
 * @param error - The error to strip stack traces from.
 * @returns The error without stack traces.
 */
export const stripStackTrace = (error: unknown): unknown => {
  if (!(error instanceof Error)) {
    return error;
  }
  return new Error(
    error.message,
    ...(error.cause ? [{ cause: stripStackTrace(error.cause) }] : []),
  );
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const isSyntaxError = (error: unknown): boolean =>
  error instanceof SyntaxError ||
  (error instanceof Error && error.name === 'SyntaxError');

const isReferenceError = (error: unknown): boolean =>
  error instanceof ReferenceError ||
  (error instanceof Error && error.name === 'ReferenceError');

/**
 * Processes any error in the evaluation result. If an error exists, classifies it
 * and either throws (for retry/exit errors) or processes and assigns it back to
 * the result (for valid feedback errors).
 *
 * @param result - The evaluation result object that may contain an error.
 * @param code - The code that was being evaluated.
 * @throws {SampleGenerationError} For syntax/reference errors that should trigger retry.
 * @throws {EvaluatorError} For internal errors that should exit the attempt.
 */
export const processEvaluationError = (
  result: EvaluationResult,
  code: string,
): void => {
  if (!Object.hasOwn(result, ERROR)) {
    return;
  }
  const error = result[ERROR];

  // Check if this is already an EvaluatorError (thrown by safe wrappers)
  if (error instanceof EvaluatorError) {
    throw error;
  }

  // Check if this is a sample generation error (syntax/reference errors)
  if (isSyntaxError(error) || isReferenceError(error)) {
    throw new SampleGenerationError(
      code,
      stripStackTrace(asError(error)) as Error,
    );
  }

  // All other errors are valid feedback (capability errors, NotImplemented, etc.)
  result[ERROR] = stripStackTrace(asError(error));
};
