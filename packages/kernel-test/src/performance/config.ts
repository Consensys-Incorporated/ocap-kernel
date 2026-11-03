import type { Infer } from '@metamask/superstruct';
import {
  array,
  integer,
  min,
  nonempty,
  object,
  validate,
} from '@metamask/superstruct';

import file from './perf.config.json';

const PositiveInteger = min(integer(), 1);
const PositiveIntegers = nonempty(array(PositiveInteger));

const PerfConfigStruct = object({
  krefScaling: object({
    maxExponent: PositiveInteger,
    samples: PositiveInteger,
    pairs: PositiveIntegers,
  }),
  concurrentLoad: object({
    krefs: PositiveInteger,
    pairs: PositiveIntegers,
    concurrency: PositiveIntegers,
    messages: PositiveInteger,
  }),
});

export type PerfConfig = Infer<typeof PerfConfigStruct>;

/**
 * Environment variables that override a setting in `perf.config.json`, each
 * with the profile and key it overrides and whether it takes a list.
 */
const OVERRIDES = {
  KREF_PERF_MAX_EXPONENT: ['krefScaling', 'maxExponent', false],
  KREF_PERF_SAMPLES: ['krefScaling', 'samples', false],
  KREF_PERF_PAIRS: ['krefScaling', 'pairs', true],
  LOAD_PERF_KREFS: ['concurrentLoad', 'krefs', false],
  LOAD_PERF_PAIRS: ['concurrentLoad', 'pairs', true],
  LOAD_PERF_CONCURRENCY: ['concurrentLoad', 'concurrency', true],
  LOAD_PERF_MESSAGES: ['concurrentLoad', 'messages', false],
} as const;

const OVERRIDE_PREFIX = /^(?:KREF|LOAD)_PERF_/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;

/**
 * Parse an override's value.
 *
 * @param name - The variable's name.
 * @param value - Its value.
 * @param isList - Whether it takes a comma-separated list.
 * @returns The number or numbers.
 */
function parseOverride(
  name: string,
  value: string,
  isList: boolean,
): number | number[] {
  const items = isList ? value.split(',') : [value];
  if (!items.every((item) => POSITIVE_INTEGER.test(item))) {
    throw new Error(
      `${name} must be ${isList ? 'a comma-separated list of positive integers' : 'a positive integer'}, got "${value}"`,
    );
  }
  const numbers = items.map(Number);
  return isList ? numbers : (numbers[0] as number);
}

/**
 * Apply environment overrides to a config and validate the result. Anything
 * malformed or unknown throws, so a run never quietly uses settings it was
 * not given.
 *
 * @param base - The config from `perf.config.json`.
 * @param env - The environment.
 * @returns The validated config.
 */
export function resolveConfig(
  base: PerfConfig,
  env: Record<string, string | undefined>,
): PerfConfig {
  const config = structuredClone(base) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [name, value] of Object.entries(env)) {
    if (!OVERRIDE_PREFIX.test(name) || value === undefined) {
      continue;
    }
    if (!Object.hasOwn(OVERRIDES, name)) {
      throw new Error(
        `Unknown setting ${name}; known: ${Object.keys(OVERRIDES).join(', ')}`,
      );
    }
    const [profile, key, isList] = OVERRIDES[name as keyof typeof OVERRIDES];
    (config[profile] as Record<string, unknown>)[key] = parseOverride(
      name,
      value,
      isList,
    );
  }
  const [error, valid] = validate(config, PerfConfigStruct);
  if (error) {
    throw new Error(
      `Invalid performance config: ${error
        .failures()
        .map(({ path, message }) => `${path.join('.')}: ${message}`)
        .join('; ')}`,
    );
  }
  return valid;
}

/**
 * The settings profiles run with: `perf.config.json`, overridden from the
 * environment.
 */
// oxlint-disable-next-line node/no-process-env
export const perfConfig = resolveConfig(file as PerfConfig, process.env);
