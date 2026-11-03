import { describe, expect, it } from 'vitest';

import { parsePerfEnv } from './config.ts';

const makeEnv = (): Record<string, string> => ({
  KREF_PERF_MAX_EXPONENT: '6',
  KREF_PERF_SAMPLES: '50',
  KREF_PERF_PAIRS: '1,4',
  LOAD_PERF_KREFS: '100000',
  LOAD_PERF_PAIRS: '1,8',
  LOAD_PERF_CONCURRENCY: '1,4',
  LOAD_PERF_MESSAGES: '1000',
});

describe('parsePerfEnv', () => {
  it('parses every setting', () => {
    expect(parsePerfEnv(makeEnv())).toStrictEqual({
      KREF_PERF_MAX_EXPONENT: 6,
      KREF_PERF_SAMPLES: 50,
      KREF_PERF_PAIRS: [1, 4],
      LOAD_PERF_KREFS: 100_000,
      LOAD_PERF_PAIRS: [1, 8],
      LOAD_PERF_CONCURRENCY: [1, 4],
      LOAD_PERF_MESSAGES: 1000,
    });
  });

  it('throws on an unknown setting', () => {
    expect(() =>
      parsePerfEnv({ ...makeEnv(), KREF_PERF_SAMPLE: '500' }),
    ).toThrow('KREF_PERF_SAMPLE is not a setting');
  });

  it('throws on a missing setting', () => {
    const { KREF_PERF_SAMPLES: _omitted, ...env } = makeEnv();
    expect(() => parsePerfEnv(env)).toThrow('KREF_PERF_SAMPLES');
  });

  it.each([
    ['KREF_PERF_SAMPLES', ''],
    ['KREF_PERF_SAMPLES', 'abc'],
    ['KREF_PERF_SAMPLES', '1e6x'],
    ['KREF_PERF_SAMPLES', '0'],
    ['KREF_PERF_SAMPLES', '-3'],
    ['KREF_PERF_SAMPLES', '2.5'],
    ['LOAD_PERF_PAIRS', ''],
    ['LOAD_PERF_PAIRS', '1,,4'],
    ['LOAD_PERF_PAIRS', '1,abc'],
    ['LOAD_PERF_PAIRS', '1,-2'],
  ])('throws on %s=%j', (name, value) => {
    expect(() => parsePerfEnv({ ...makeEnv(), [name]: value })).toThrow(name);
  });
});
