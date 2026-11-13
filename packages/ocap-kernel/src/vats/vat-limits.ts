import type { VatCheckpoint } from '@metamask/kernel-store';

/**
 * How much of a vat's text the kernel keeps in a reason or error it builds,
 * some of which it stores. Building one from text near JavaScript's maximum
 * string length throws.
 */
const MAX_REASON_LENGTH = 10_000;

/**
 * The most a vat may send in one syscall, in characters of JSON, and the most
 * one entry of its state may hold. SwingSet's vat channel refuses a message
 * over 12 MB, and there each write to a vat's state is a message of its own.
 * SwingSet then panics, which would recur on every start; here the vat is
 * terminated. A message is measured once received, so this bounds what is
 * stored, not memory.
 */
export const MAX_VAT_MESSAGE_LENGTH = 12_000_000;

/**
 * Cut text from a vat to {@link MAX_REASON_LENGTH}, noting how much was cut.
 *
 * @param text - The text.
 * @returns The text, cut short if it is longer.
 */
export function capReasonText(text: string): string {
  const over = text.length - MAX_REASON_LENGTH;
  return over > 0
    ? `${text.slice(0, MAX_REASON_LENGTH)}… (${over} more characters)`
    : text;
}

/**
 * Whether every entry of a change to a vat's state fits
 * {@link MAX_VAT_MESSAGE_LENGTH}.
 *
 * @param checkpoint - The change.
 * @returns True if so.
 */
export function fitsVatStateLimit(checkpoint: VatCheckpoint): boolean {
  const [sets, deletes] = checkpoint;
  return (
    sets.every(
      ([key, value]) => key.length + value.length <= MAX_VAT_MESSAGE_LENGTH,
    ) && deletes.every((key) => key.length <= MAX_VAT_MESSAGE_LENGTH)
  );
}
