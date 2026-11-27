import '@ocap/repo-tools/test-utils/mock-endoify';

import { describe, it, expect } from 'vitest';

import { makeCompartment } from './compartment.ts';

describe('compartment', () => {
  it('gets the value from an expression', () => {
    const compartment = makeCompartment();
    expect(compartment.evaluate('1 + 1')).toBe(2);
    expect(compartment.evaluate('1 + 1; 2 + 2;')).toBe(4);
  });

  it('gets the value from an async expression', async () => {
    const compartment = makeCompartment();
    expect(
      await compartment.evaluate(
        '(async () => await Promise.resolve(1 + 1))()',
      ),
    ).toBe(2);
    expect(
      await compartment.evaluate(
        '(async () => { await Promise.resolve(1 + 1); return await Promise.resolve(2 + 2); })()',
      ),
    ).toBe(4);
  });
});
