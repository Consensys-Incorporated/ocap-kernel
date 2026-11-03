import { afterEach, describe, expect, it, vi } from 'vitest';

import { coerceNat, coerceNats, fromEnv, isNat } from './utils.ts';

describe('performance utils', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['1', true],
    ['1000', true],
    ['', false],
    ['0', false],
    ['01', false],
    ['-3', false],
    ['2.5', false],
    ['1e3', false],
    ['abc', false],
  ])('isNat(%j) is %s', (value, expected) => {
    expect(isNat(value)).toBe(expected);
  });

  it('coerces a positive integer', () => {
    expect(coerceNat('50')).toBe(50);
  });

  it('coerces a list of positive integers', () => {
    expect(coerceNats('1,4,16')).toStrictEqual([1, 4, 16]);
  });

  it.each(['', '1,,4', '1,abc', '1,-2'])('rejects the list %j', (value) => {
    expect(() => coerceNats(value)).toThrow(
      `expected a comma-separated list of positive integers, got "${value}"`,
    );
  });

  it('returns undefined for an unset variable', () => {
    expect(fromEnv('PERF_UTILS_TEST', coerceNat)).toBeUndefined();
  });

  it('names the variable when its value is malformed', () => {
    vi.stubEnv('PERF_UTILS_TEST', '1e6x');
    expect(() => fromEnv('PERF_UTILS_TEST', coerceNat)).toThrow(
      'PERF_UTILS_TEST: expected a positive integer, got "1e6x"',
    );
  });
});
