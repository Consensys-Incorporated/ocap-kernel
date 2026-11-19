import { describe, it, expect, vi } from 'vitest';

import { exampleCapabilities, getMoonPhase } from './examples.ts';

describe('exampleCapabilities', () => {
  it('contains the correct capabilities', () => {
    expect(exampleCapabilities).toBeDefined();
    expect(Object.keys(exampleCapabilities)).toStrictEqual([
      'search',
      'getMoonPhase',
    ]);
  });
});

describe('getMoonPhase', () => {
  it('runs without entropy', async () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('No entropy in a vat');
    });
    expect(await getMoonPhase.func({} as never)).toStrictEqual(
      expect.any(String),
    );
    random.mockRestore();
  });
});
