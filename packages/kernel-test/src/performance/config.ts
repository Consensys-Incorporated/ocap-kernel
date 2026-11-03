import type { Infer } from '@metamask/superstruct';
import {
  array,
  coerce,
  integer,
  min,
  nonempty,
  object,
  string,
  validate,
} from '@metamask/superstruct';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const PositiveInteger = coerce(min(integer(), 1), string(), Number);
const PositiveIntegers = coerce(
  nonempty(array(min(integer(), 1))),
  string(),
  (value) => value.split(',').map(Number),
);

const PerfEnvStruct = object({
  KREF_PERF_MAX_EXPONENT: PositiveInteger,
  KREF_PERF_SAMPLES: PositiveInteger,
  KREF_PERF_PAIRS: PositiveIntegers,
  LOAD_PERF_KREFS: PositiveInteger,
  LOAD_PERF_PAIRS: PositiveIntegers,
  LOAD_PERF_CONCURRENCY: PositiveIntegers,
  LOAD_PERF_MESSAGES: PositiveInteger,
});

export type PerfConfig = Infer<typeof PerfEnvStruct>;

/**
 * Say what is wrong with one setting.
 *
 * @param name - The variable's name.
 * @param value - Its value, if it has one.
 * @returns The problem.
 */
function describeProblem(name: string, value: string | undefined): string {
  if (!Object.hasOwn(PerfEnvStruct.schema, name)) {
    return `${name} is not a setting`;
  }
  if (value === undefined) {
    return `${name} is missing`;
  }
  const expected =
    PerfEnvStruct.schema[name as keyof PerfConfig] === PositiveIntegers
      ? 'a comma-separated list of positive integers'
      : 'a positive integer';
  return `${name} must be ${expected}, got ${JSON.stringify(value)}`;
}

/**
 * Parse the profiles' settings. Anything missing, malformed or unknown throws,
 * so a run never quietly uses settings it was not given.
 *
 * @param env - The settings, as `loadEnv` returns them.
 * @returns The parsed settings.
 */
export function parsePerfEnv(env: Record<string, string>): PerfConfig {
  const [error, config] = validate(env, PerfEnvStruct, { coerce: true });
  if (error) {
    const names = new Set(error.failures().map(({ path }) => String(path[0])));
    const problems = [...names].map((name) => describeProblem(name, env[name]));
    throw new Error(`Invalid performance settings: ${problems.join('; ')}`);
  }
  return config;
}

/**
 * The settings profiles run with: `.env.perf`, overridden by any variable of
 * the same name in the environment.
 */
export const perfConfig = parsePerfEnv(
  loadEnv('perf', fileURLToPath(new URL('.', import.meta.url)), [
    'KREF_PERF_',
    'LOAD_PERF_',
  ]),
);
