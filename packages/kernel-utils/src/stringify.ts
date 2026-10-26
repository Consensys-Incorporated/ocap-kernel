import { hasProperty } from '@metamask/utils';

/**
 * Stringify an evaluation result.
 *
 * @param value - The result to stringify.
 * @param indent - The number of spaces to use for indentation (optional).
 * @returns The stringified result.
 */
export const stringify = (value: unknown, indent: number = 2): string => {
  try {
    if (value instanceof Error) {
      const errorObject = stringifyError(value);
      return JSON.stringify(errorObject, null, indent);
    }

    const result = JSON.stringify(value, null, indent);
    return result ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * Helper function to process an error.
 *
 * @param error - The error to process.
 * @returns The processed object.
 */
function stringifyError(error: Error): Record<string, unknown> {
  const errorObject: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  if (error.cause) {
    errorObject.cause =
      error.cause instanceof Error
        ? stringifyError(error.cause)
        : stringify(error.cause);
  }

  if (error instanceof AggregateError) {
    errorObject.errors = error.errors.map((inner: unknown) =>
      inner instanceof Error ? stringifyError(inner) : stringify(inner),
    );
  }

  // By our convention, these properties may be present on errors
  // and should be preserved.
  if (hasProperty(error, 'code')) {
    errorObject.code = error.code;
  }

  if (hasProperty(error, 'data')) {
    errorObject.data = stringify(error.data);
  }

  return errorObject;
}
