import type { expect as Expect } from 'vitest';

/**
 * Creates a function that can be used to match errors in tests. Assumes that
 * the error will have a `message`, and optionally:
 * - a `string` stack
 * - an `Error` cause
 *
 * The matcher recurs on `cause` to allow for matching nested errors. Throws if
 * a `cause` is not an `Error`.
 *
 * @param expect - The expect function to use.
 * @returns A function that can be used to match errors in tests.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export const makeErrorMatcherFactory = (expect: typeof Expect) => {
  const makeErrorMatcher = (
    error: Error | string,
  ): ReturnType<typeof expect.objectContaining> => {
    if (typeof error === 'string') {
      return expect.objectContaining({
        message: error,
        stack: expect.any(String),
      });
    }

    return expect.objectContaining({
      message: error.message,
      ...(error.stack !== undefined && { stack: expect.any(String) }),
      ...(error.cause !== undefined && {
        cause:
          error.cause instanceof Error
            ? makeErrorMatcher(error.cause)
            : error.cause,
      }),
    });
  };

  return makeErrorMatcher;
};
