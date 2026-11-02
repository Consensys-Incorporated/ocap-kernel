import { afterEach, describe, expect, it, vi } from 'vitest';

import { envNumber, envNumbers } from './utils.ts';

const NAME = 'PERF_UTILS_TEST';

describe('performance utils', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('envNumber', () => {
    it('returns the fallback when the variable is unset', () => {
      expect(envNumber(NAME, 7)).toBe(7);
    });

    it('reads a positive integer', () => {
      vi.stubEnv(NAME, '1000');
      expect(envNumber(NAME, 7)).toBe(1000);
    });

    it.each(['', 'abc', '1e6x', '0', '-3', '2.5'])('throws on %j', (value) => {
      vi.stubEnv(NAME, value);
      expect(() => envNumber(NAME, 7)).toThrow(
        `${NAME} must be a positive integer, got "${value}"`,
      );
    });
  });

  describe('envNumbers', () => {
    it('returns the fallback when the variable is unset', () => {
      expect(envNumbers(NAME, [1, 2])).toStrictEqual([1, 2]);
    });

    it('reads a comma-separated list of positive integers', () => {
      vi.stubEnv(NAME, '1,8,64');
      expect(envNumbers(NAME, [1, 2])).toStrictEqual([1, 8, 64]);
    });

    it.each(['', '1,,4', '1,abc', '1,-2'])('throws on %j', (value) => {
      vi.stubEnv(NAME, value);
      expect(() => envNumbers(NAME, [1, 2])).toThrow(
        `${NAME} must be a comma-separated list of positive integers, got "${value}"`,
      );
    });
  });
});
