import { describe, it, expect } from 'vitest';

import {
  MAX_VAT_MESSAGE_LENGTH,
  capReasonText,
  fitsVatMessageLimit,
} from './vat-limits.ts';

describe('capReasonText', () => {
  it.each([
    { text: 'short', capped: 'short' },
    { text: 'x'.repeat(10_000), capped: 'x'.repeat(10_000) },
    {
      text: 'x'.repeat(10_005),
      capped: `${'x'.repeat(10_000)}… (5 more characters)`,
    },
  ])('cuts text of length $text.length to its limit', ({ text, capped }) => {
    expect(capReasonText(text)).toBe(capped);
  });
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
