/**
 * Settings for the performance profiles. Override one for a run with an
 * environment variable of the same name:
 * KREF_PERF_MAX_EXPONENT=4 yarn workspace @ocap/kernel-test test:perf kref-scaling
 */

import { coerceNat, coerceNats, fromEnv } from './utils.ts';

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
