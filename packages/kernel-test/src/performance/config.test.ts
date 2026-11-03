import { describe, expect, it } from 'vitest';

import { resolveConfig } from './config.ts';
import type { PerfConfig } from './config.ts';

const makeFile = (): PerfConfig => ({
  krefScaling: { maxExponent: 6, samples: 50, pairs: [1, 4] },
  concurrentLoad: {
    krefs: 100_000,
    pairs: [1, 8],
    concurrency: [1, 4],
    messages: 1000,
  },
});

describe('resolveConfig', () => {
  it('uses the file when nothing overrides it', () => {
    expect(resolveConfig(makeFile(), {})).toStrictEqual(makeFile());
  });

  it('applies overrides from the environment', () => {
    expect(
      resolveConfig(makeFile(), {
        KREF_PERF_SAMPLES: '5',
        LOAD_PERF_CONCURRENCY: '1,2',
        HOME: '/home/someone',
      }),
    ).toStrictEqual({
      krefScaling: { maxExponent: 6, samples: 5, pairs: [1, 4] },
      concurrentLoad: {
        krefs: 100_000,
        pairs: [1, 8],
        concurrency: [1, 2],
        messages: 1000,
      },
    });
  });

  it('throws on an unknown setting, naming the known ones', () => {
    expect(() =>
      resolveConfig(makeFile(), { KREF_PERF_SAMPLE: '500' }),
    ).toThrow(/Unknown setting KREF_PERF_SAMPLE; known: .*KREF_PERF_SAMPLES/u);
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
    expect(() => resolveConfig(makeFile(), { [name]: value })).toThrow(
      `${name} must be`,
    );
  });

  it('throws on an invalid file', () => {
    const file = makeFile();
    expect(() =>
      resolveConfig(
        { ...file, krefScaling: { ...file.krefScaling, samples: 0 } },
        {},
      ),
    ).toThrow(/krefScaling\.samples/u);
  });

  it('throws on an unknown key in the file', () => {
    expect(() =>
      resolveConfig({ ...makeFile(), gc: {} } as unknown as PerfConfig, {}),
    ).toThrow(/gc/u);
  });
});
