import { describe, expect, it } from 'vitest';

import { nextHop, startTrace } from './trace.ts';

describe('startTrace', () => {
  it('starts at hop zero with the default limit, under a fresh id', () => {
    const first = startTrace();
    const second = startTrace();
    expect(first).toStrictEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/u),
      hop: 0,
      hopLimit: 8,
    });
    expect(second.id).not.toBe(first.id);
  });

  it('takes the limit asked for', () => {
    expect(startTrace({ hopLimit: 3 }).hopLimit).toBe(3);
  });
});

describe('nextHop', () => {
  it.each([
    ['none', undefined, undefined],
    [
      'one below the limit',
      { id: 't', hop: 1, hopLimit: 3 },
      { id: 't', hop: 2, hopLimit: 3 },
    ],
    ['at the limit', { id: 't', hop: 2, hopLimit: 3 }, undefined],
  ])('carries on from %s', (_what, trace, expected) => {
    expect(nextHop(trace)).toStrictEqual(expected);
  });
});
