import { StreamReadError } from '@metamask/kernel-errors';
import { describe, it, expect } from 'vitest';

import { makeLostVatReason } from './lost-vat-reason.ts';
import { asVatId } from '../../test/branded.ts';
import { kunser } from '../liveslots/kernel-marshal.ts';

describe('makeLostVatReason', () => {
  it('cuts what the channel ended with to the reason limit', () => {
    const frame = new Error('x'.repeat(10_005));

    const reason = makeLostVatReason(
      asVatId('v1'),
      new StreamReadError({ vatId: 'v1' }, { cause: frame }),
    );

    expect((kunser(reason) as Error).message).toBe(
      `[KERNEL:VAT_TERMINATED] Vat v1 lost its channel: ${'x'.repeat(10_000)}… (5 more characters)`,
    );
  });
});
