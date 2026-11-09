import { describe, it, expect } from 'vitest';

import {
  MAX_VAT_MESSAGE_LENGTH,
  capReasonText,
  fitsVatMessageLimit,
  fitsVatStateLimit,
} from './vat-limits.ts';

describe('capReasonText', () => {
  it.each([
    { text: 'short', capped: 'short' },
    { text: 'x'.repeat(10_000), capped: 'x'.repeat(10_000) },
    {
      text: 'x'.repeat(10_005),
      capped: `${'x'.repeat(10_000)}… (5 more characters)`,
    },
  ])(
    'keeps at most the limit of text of length $text.length',
    ({ text, capped }) => {
      expect(capReasonText(text)).toBe(capped);
    },
  );
});

describe('fitsVatMessageLimit', () => {
  it.each([
    { what: 'a small message', message: { params: ['x'] }, fits: true },
    {
      what: 'a message over the limit',
      message: { params: ['x'.repeat(MAX_VAT_MESSAGE_LENGTH)] },
      fits: false,
    },
    { what: 'a message JSON cannot measure', message: { n: 1n }, fits: false },
  ])('takes $what as fitting: $fits', ({ message, fits }) => {
    expect(fitsVatMessageLimit(message)).toBe(fits);
  });
});

describe('fitsVatStateLimit', () => {
  const half = 'x'.repeat(MAX_VAT_MESSAGE_LENGTH / 2);

  it.each([
    {
      what: 'entries over the limit only in all',
      sets: [
        ['a', half],
        ['b', half],
        ['c', half],
      ] as [string, string][],
      deletes: [],
      fits: true,
    },
    {
      what: 'an entry over the limit',
      sets: [['key', 'x'.repeat(MAX_VAT_MESSAGE_LENGTH)]] as [string, string][],
      deletes: [],
      fits: false,
    },
    {
      what: 'a deleted key over the limit',
      sets: [],
      deletes: ['x'.repeat(MAX_VAT_MESSAGE_LENGTH + 1)],
      fits: false,
    },
  ])('takes $what as fitting: $fits', ({ sets, deletes, fits }) => {
    expect(fitsVatStateLimit([sets, deletes])).toBe(fits);
  });
});
