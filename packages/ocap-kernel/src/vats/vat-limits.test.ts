import { describe, it, expect } from 'vitest';

import {
  MAX_VAT_MESSAGE_LENGTH,
  capReasonText,
  fitsVatStateLimit,
} from './vat-limits.ts';

describe('capReasonText', () => {
  it.each([
    [
      'keeps a text of 10,000 characters whole',
      'x'.repeat(10_000),
      'x'.repeat(10_000),
    ],
    [
      'cuts a longer text to 10,000 characters and counts the rest',
      'x'.repeat(10_005),
      `${'x'.repeat(10_000)}… (5 more characters)`,
    ],
  ])('%s', (_title, text, capped) => {
    expect(capReasonText(text)).toBe(capped);
  });
});

describe('fitsVatStateLimit', () => {
  const half = 'x'.repeat(MAX_VAT_MESSAGE_LENGTH / 2);

  it.each([
    [
      'true for entries over the limit only together',
      [
        ['a', half],
        ['b', half],
        ['c', half],
      ] as [string, string][],
      [],
      true,
    ],
    [
      'false for an entry over the limit',
      [['key', 'x'.repeat(MAX_VAT_MESSAGE_LENGTH)]] as [string, string][],
      [],
      false,
    ],
    [
      'false for a deleted key over the limit',
      [] as [string, string][],
      ['x'.repeat(MAX_VAT_MESSAGE_LENGTH + 1)],
      false,
    ],
  ])('returns %s', (_title, sets, deletes, fits) => {
    expect(fitsVatStateLimit([sets, deletes])).toBe(fits);
  });
});
