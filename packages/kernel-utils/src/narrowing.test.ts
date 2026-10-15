import { matches } from '@endo/patterns';
import { describe, it, expect } from 'vitest';

import { join, pathUnder } from './narrowing.ts';

const makeBase = (): object => ({ readFile: () => 'contents' });

// `narrow`, and every path of `join` that reaches a minted ref, are exercised
// end to end in `@ocap/kernel-test`. They cannot be exercised here: `E` reads
// `globalThis.HandledPromise` when it loads, and this package's tests run under
// `mock-endoify`, which sets that to plain `Promise`. What is reachable here is
// the refusal `join` raises before it mints anything.
describe('join', () => {
  it.each([
    { scenario: 'no ref was minted by narrowing', refs: [makeBase()] },
    { scenario: 'no refs were given at all', refs: [] },
  ])('refuses a join where $scenario', async ({ refs }) => {
    await expect(join({ name: 'Joined', refs })).rejects.toThrow(
      'Cannot join "Joined": no ref was minted by narrowing.',
    );
  });
});

describe('pathUnder', () => {
  it.each([
    { specimen: ['srv', 'data'], expected: true },
    { specimen: ['srv', 'data', 'x'], expected: true },
    { specimen: ['srv', 'data', 'a', 'b'], expected: true },
    { specimen: ['srv'], expected: false },
    { specimen: ['srv', 'logs'], expected: false },
    { specimen: ['var', 'data', 'x'], expected: false },
    { specimen: ['srv', 'data', '..', 'logs'], expected: false },
    { specimen: ['srv', 'data', 1], expected: false },
    { specimen: 'srv/data', expected: false },
  ])(
    'matches $specimen under a prefix: $expected',
    ({ specimen, expected }) => {
      expect(matches(specimen, pathUnder(['srv', 'data']))).toBe(expected);
    },
  );

  it.each([
    { specimen: [], expected: true },
    { specimen: ['etc', 'passwd'], expected: true },
    { specimen: ['..'], expected: false },
  ])(
    'matches $specimen under no prefix: $expected',
    ({ specimen, expected }) => {
      expect(matches(specimen, pathUnder([]))).toBe(expected);
    },
  );

  it('excludes .. only past the prefix', () => {
    expect(matches(['..', 'etc'], pathUnder(['..']))).toBe(true);
  });
});
