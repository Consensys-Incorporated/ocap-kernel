/**
 * Settings for the performance profiles. Override one for a run with an
 * environment variable of the same name:
 * KREF_PERF_MAX_EXPONENT=4 yarn workspace @ocap/kernel-test test:perf kref-scaling
 */

/**
 * Whether a string is a positive integer, written without sign, exponent or
 * leading zeros.
 *
 * @param value - The string.
 * @returns Whether it is one.
 */
export const isNat = (value: string): boolean => /^[1-9]\d*$/u.test(value);

/**
 * Parse a positive integer.
 *
 * @param value - The string.
 * @returns The number.
 */
export function coerceNat(value: string): number {
  if (!isNat(value)) {
    throw new Error(`expected a positive integer, got "${value}"`);
  }
  return Number(value);
}

/**
 * Parse a comma-separated list of positive integers.
 *
 * @param value - The string.
 * @returns The numbers.
 */
export const coerceNats = (value: string): number[] =>
  value.split(',').map(coerceNat);

/**
 * Read an environment variable, if set, so that a malformed value throws
 * rather than leaving a profile to run on `NaN` or zero.
 *
 * @param name - The variable's name.
 * @param coerce - Parses its value.
 * @returns The parsed value, or `undefined` if it is unset.
 */
export function fromEnv<Value>(
  name: string,
  coerce: (value: string) => Value,
): Value | undefined {
  // oxlint-disable-next-line node/no-process-env
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  try {
    return coerce(value);
  } catch (error) {
    throw new Error(`${name}="${value}": ${(error as Error).message}`, {
      cause: error,
    });
  }
}

// kref-scaling: live krefs grow to 1e<MAX_EXPONENT>, with SAMPLES sends timed
// at each power of ten, over each count of holder/minter pairs.
export const KREF_PERF_MAX_EXPONENT =
  fromEnv('KREF_PERF_MAX_EXPONENT', coerceNat) ?? 6;
export const KREF_PERF_SAMPLES = fromEnv('KREF_PERF_SAMPLES', coerceNat) ?? 50;
export const KREF_PERF_PAIRS = fromEnv('KREF_PERF_PAIRS', coerceNats) ?? [
  1, 4, 16, 64,
];

// concurrent-load: KREFS live krefs over each count of pairs, MESSAGES per
// cell at each concurrency.
export const LOAD_PERF_KREFS = fromEnv('LOAD_PERF_KREFS', coerceNat) ?? 100_000;
export const LOAD_PERF_PAIRS = fromEnv('LOAD_PERF_PAIRS', coerceNats) ?? [
  1, 8, 64,
];
export const LOAD_PERF_CONCURRENCY = fromEnv(
  'LOAD_PERF_CONCURRENCY',
  coerceNats,
) ?? [1, 4, 16, 64, 256];
export const LOAD_PERF_MESSAGES =
  fromEnv('LOAD_PERF_MESSAGES', coerceNat) ?? 1000;
