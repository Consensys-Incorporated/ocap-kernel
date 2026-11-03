import { describe, expect, it } from 'vitest';

import { assertKnownSettings, readSetting } from './constants.ts';

describe('performance constants', () => {
  describe('readSetting', () => {
    it.each([
      ['KREF_PERF_SAMPLES', {}, 50],
      ['KREF_PERF_PAIRS', {}, [1, 4, 16, 64]],
      ['KREF_PERF_SAMPLES', { KREF_PERF_SAMPLES: '5' }, 5],
      ['LOAD_PERF_CONCURRENCY', { LOAD_PERF_CONCURRENCY: '1,2' }, [1, 2]],
    ] as const)('reads %s from %j', (name, env, expected) => {
      expect(readSetting(env, name)).toStrictEqual(expected);
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
    ] as const)('throws on %s=%j', (name, value) => {
      expect(() => readSetting({ [name]: value }, name)).toThrow(
        `${name} must be`,
      );
    });
  });

  describe('assertKnownSettings', () => {
    it('accepts known settings and unrelated variables', () => {
      expect(() =>
        assertKnownSettings({ KREF_PERF_SAMPLES: '5', HOME: '/home/someone' }),
      ).not.toThrow();
    });

    it('throws on an unknown setting, naming the known ones', () => {
      expect(() => assertKnownSettings({ KREF_PERF_SAMPLE: '500' })).toThrow(
        /Unknown performance setting KREF_PERF_SAMPLE\. Expected one of: .*KREF_PERF_SAMPLES/u,
      );
    });
  });
});
