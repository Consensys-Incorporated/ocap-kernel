import type { VatCheckpoint } from '@metamask/kernel-store';

/**
 * How much of a vat's error text a termination reason keeps. A reason built
 * from text near JavaScript's maximum string length throws, and a termination
 * that throws is rolled back and retried on every start.
 */
export const MAX_REASON_LENGTH = 10_000;

/**
 * The most a vat may send the kernel in one syscall, in characters of JSON,
 * and the most one entry of its state may hold. SwingSet's xsnap channel
 * refuses a message over 12 MB, and there each write to a vat's state is a
 * message of its own. A value too large for the store would otherwise make a
 * write fail, and stop the kernel over the vat's own message.
 */
export const MAX_VAT_MESSAGE_LENGTH = 12_000_000;

/**
 * Cut text from a vat to {@link MAX_REASON_LENGTH}.
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
 * Whether a message from a vat fits {@link MAX_VAT_MESSAGE_LENGTH}.
 *
 * @param message - The message.
 * @returns True if so, and false for one too large to measure.
 */
export function fitsVatMessageLimit(message: unknown): boolean {
  try {
    return JSON.stringify(message).length <= MAX_VAT_MESSAGE_LENGTH;
  } catch {
    return false;
  }
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
