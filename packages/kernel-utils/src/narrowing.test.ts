import { matches } from '@endo/patterns';
import { describe, it, expect } from 'vitest';

import { join, narrow, pathUnder } from './narrowing.ts';

const makeBase = (): object => ({ readFile: () => 'contents' });

describe('narrow', () => {
  it('is not implemented', async () => {
    await expect(
      narrow({ name: 'Scoped', base: makeBase(), delta: { readFile: [] } }),
    ).rejects.toThrow('narrow is not implemented');
  });
});

describe('join', () => {
  it('is not implemented', async () => {
    await expect(
      join({ name: 'Joined', refs: [makeBase(), makeBase()] }),
    ).rejects.toThrow('join is not implemented');
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
