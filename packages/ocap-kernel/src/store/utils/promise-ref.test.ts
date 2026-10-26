import { describe, it, expect } from 'vitest';

import { isPromiseRef } from './promise-ref.ts';
import type { KRef } from '../../types.ts';

describe('promise-ref', () => {
  describe('isPromiseRef', () => {
    it.each([
      // References with 'p' as the second character (should return true)
      ['kp1', true, 'kernel promise'],
      ['rp+7', true, 'remote promise'],
      ['xpyz', true, 'any string with p as second character'],
      // References without 'p' as the second character (should return false)
      ['ko2', false, 'kernel object'],
      ['p+42', false, 'vat promise (p in first position)'],
      ['o+3', false, 'vat object'],
      ['ro+5', false, 'remote object'],
      ['abc', false, 'string without p as second character'],
      ['a', false, 'single character string'],
    ])('returns %s for %s', (ref, expected) => {
      expect(isPromiseRef(ref as KRef)).toBe(expected);
    });
  });
});
