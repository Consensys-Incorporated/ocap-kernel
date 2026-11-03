/**
 * Settings for the performance profiles. Override any one for a run with an
 * environment variable of the same name:
 * KREF_PERF_MAX_EXPONENT=4 yarn workspace @ocap/kernel-test test:perf kref-scaling
 *
 * A malformed value, or a `KREF_PERF_*` or `LOAD_PERF_*` variable that names
 * no setting, throws before any profile runs.
 */
const DEFAULTS = {
  // kref-scaling: live krefs grow to 1e<MAX_EXPONENT>, with SAMPLES sends timed
  // at each power of ten, over each count of holder/minter pairs.
  KREF_PERF_MAX_EXPONENT: 6,
  KREF_PERF_SAMPLES: 50,
  KREF_PERF_PAIRS: [1, 4, 16, 64],
  // concurrent-load: KREFS live krefs over each count of pairs, MESSAGES per
  // cell at each concurrency.
  LOAD_PERF_KREFS: 100_000,
  LOAD_PERF_PAIRS: [1, 8, 64],
  LOAD_PERF_CONCURRENCY: [1, 4, 16, 64, 256],
  LOAD_PERF_MESSAGES: 1000,
};

type Setting = keyof typeof DEFAULTS;
type Env = Record<string, string | undefined>;

const POSITIVE_INTEGER = /^[1-9]\d*$/u;

/**
 * Throw if the environment names a setting that does not exist, as a
 * misspelled override would otherwise leave its setting at the default.
 *
 * @param env - The environment.
 */
export function assertKnownSettings(env: Env): void {
  for (const name of Object.keys(env)) {
    if (/^(?:KREF|LOAD)_PERF_/u.test(name) && !Object.hasOwn(DEFAULTS, name)) {
      throw new Error(
        `Unknown performance setting ${name}. Expected one of: ${Object.keys(DEFAULTS).join(', ')}`,
      );
    }
  }
}

/**
 * Read a setting, overridden from the environment if set there.
 *
 * @param env - The environment.
 * @param name - The setting.
 * @returns Its value.
 */
export function readSetting<Name extends Setting>(
  env: Env,
  name: Name,
): (typeof DEFAULTS)[Name] {
  const fallback = DEFAULTS[name];
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  const isList = Array.isArray(fallback);
  const items = isList ? value.split(',') : [value];
  if (!items.every((item) => POSITIVE_INTEGER.test(item))) {
    throw new Error(
      `${name} must be ${isList ? 'a comma-separated list of positive integers' : 'a positive integer'}, got "${value}"`,
    );
  }
  const numbers = items.map(Number);
  return (isList ? numbers : numbers[0]) as (typeof DEFAULTS)[Name];
}

const { env } = process;
assertKnownSettings(env);

export const KREF_PERF_MAX_EXPONENT = readSetting(
  env,
  'KREF_PERF_MAX_EXPONENT',
);
export const KREF_PERF_SAMPLES = readSetting(env, 'KREF_PERF_SAMPLES');
export const KREF_PERF_PAIRS = readSetting(env, 'KREF_PERF_PAIRS');
export const LOAD_PERF_KREFS = readSetting(env, 'LOAD_PERF_KREFS');
export const LOAD_PERF_PAIRS = readSetting(env, 'LOAD_PERF_PAIRS');
export const LOAD_PERF_CONCURRENCY = readSetting(env, 'LOAD_PERF_CONCURRENCY');
export const LOAD_PERF_MESSAGES = readSetting(env, 'LOAD_PERF_MESSAGES');
