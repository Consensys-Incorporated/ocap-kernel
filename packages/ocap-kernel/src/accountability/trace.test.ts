import { is } from '@metamask/superstruct';
import { describe, expect, it } from 'vitest';

import { nextHop, startTrace } from './trace.ts';
import {
  MAX_HOP_LIMIT,
  TraceContextStruct,
  TraceOptionsStruct,
} from './types.ts';

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

describe('TraceContextStruct', () => {
  const id = '0'.repeat(32);
  it.each([
    ['a hop below the limit', { id, hop: 7, hopLimit: 8 }, true],
    ['a hop at the limit', { id, hop: 8, hopLimit: 8 }, false],
    ['a negative hop', { id, hop: -1, hopLimit: 8 }, false],
    ['a fractional hop', { id, hop: 0.5, hopLimit: 8 }, false],
    [
      'the longest limit allowed',
      { id, hop: 0, hopLimit: MAX_HOP_LIMIT },
      true,
    ],
    [
      'a limit beyond the longest allowed',
      { id, hop: 0, hopLimit: MAX_HOP_LIMIT + 1 },
      false,
    ],
    ['a limit of zero', { id, hop: 0, hopLimit: 0 }, false],
    [
      'an id that is not 32 hex digits',
      { id: 't', hop: 0, hopLimit: 8 },
      false,
    ],
  ])('%s is %s', (_what, trace, accepted) => {
    expect(is(trace, TraceContextStruct)).toBe(accepted);
  });
});

describe('TraceOptionsStruct', () => {
  it.each([
    ['no limit', {}, true],
    ['a limit of one', { hopLimit: 1 }, true],
    ['the longest limit allowed', { hopLimit: MAX_HOP_LIMIT }, true],
    ['a limit of zero', { hopLimit: 0 }, false],
    [
      'a limit beyond the longest allowed',
      { hopLimit: MAX_HOP_LIMIT + 1 },
      false,
    ],
    ['an unbounded limit', { hopLimit: Infinity }, false],
    ['a fractional limit', { hopLimit: 1.5 }, false],
  ])('%s is %s', (_what, options, accepted) => {
    expect(is(options, TraceOptionsStruct)).toBe(accepted);
  });
});
