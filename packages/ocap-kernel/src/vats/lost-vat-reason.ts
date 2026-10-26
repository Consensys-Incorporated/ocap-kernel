import type { CapData } from '@endo/marshal';

import { makeKernelError } from '../liveslots/kernel-marshal.ts';
import type { KRef, VatId } from '../types.ts';

/**
 * The reason a vat that lost its channel to its worker is terminated with.
 *
 * @param vatId - The vat.
 * @param error - What its handle reported the channel ending with.
 * @returns The serialized reason.
 */
export const makeLostVatReason = (
  vatId: VatId,
  error: Error,
): CapData<KRef> => {
  // The handle's own error is generic; what the channel ended with is its
  // cause.
  const cause = error.cause instanceof Error ? error.cause : error;
  return makeKernelError(
    'VAT_TERMINATED',
    `Vat ${vatId} lost its channel: ${cause.message}`,
  );
};
