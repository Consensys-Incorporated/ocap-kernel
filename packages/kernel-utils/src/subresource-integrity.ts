import { bytesToBase64 } from '@metamask/utils';

/**
 * The hash algorithms subresource integrity is defined over, weakest first:
 * metadata naming several of them is checked against the strongest, and this
 * order is what "strongest" means.
 *
 * @see https://w3c.github.io/webappsec-subresource-integrity/#valid-sri-hash-algorithm-token-set
 */
const SRI_ALGORITHMS = harden([
  { token: 'sha256', digest: 'SHA-256' },
  { token: 'sha384', digest: 'SHA-384' },
  { token: 'sha512', digest: 'SHA-512' },
] as const);

/** The whitespace integrity metadata separates its digests with. */
const ASCII_WHITESPACE = /[\t\n\f\r ]+/u;

export type IntegrityCheck = {
  /** The `crypto.subtle` name of the algorithm to digest with. */
  algorithm: (typeof SRI_ALGORITHMS)[number]['digest'];
  /** The digests, any one of which the bytes may match. */
  values: readonly string[];
};

/**
 * A digest is written base64 or base64url, padded or unpadded, and all four
 * spellings name the same bytes. Normalized rather than decoded, so that a
 * value which is not base64 at all fails to match instead of failing to parse.
 *
 * @param value - A digest as written.
 * @returns The same digest, comparable to any other spelling of itself.
 */
const normalizeDigest = (value: string): string =>
  value.replace(/[=]+$/u, '').replace(/-/gu, '+').replace(/_/gu, '/');

/**
 * Read integrity metadata — the `integrity` member of a `fetch` init — as the
 * single check a body has to pass.
 *
 * A token naming an algorithm that is not one of SRI's is dropped rather than
 * refused, because metadata may name several and only the strongest of those
 * understood is checked. Metadata naming nothing understood therefore comes
 * back as `undefined`, which is the caller's to answer for: `fetch` ignores
 * such metadata and hands back the body unchecked.
 *
 * @param metadata - The caller's integrity metadata; `''` for none.
 * @returns The strongest algorithm named and the digests written for it, or
 * `undefined` if the metadata names no digest that can be checked.
 */
export const parseIntegrityMetadata = (
  metadata: string,
): IntegrityCheck | undefined => {
  let strongest = -1;
  let values: string[] = [];
  for (const token of metadata.split(ASCII_WHITESPACE)) {
    // Whatever follows a `?` is an option, which SRI defines no use for and
    // reads past.
    const [expression] = token.split('?') as [string];
    const separator = expression.indexOf('-');
    // A token carrying no `-` names no digest, so there is nothing to check it
    // against — as there is not for the empty token an empty metadata splits to.
    if (separator < 0) {
      continue;
    }
    const index = SRI_ALGORITHMS.findIndex(
      ({ token: name }) => name === expression.slice(0, separator),
    );
    if (index < 0) {
      continue;
    }
    // A stronger algorithm discards what the weaker ones asked for; a second
    // digest for the algorithm already in hand is another way to satisfy it.
    if (index > strongest) {
      strongest = index;
      values = [];
    }
    if (index === strongest) {
      values.push(expression.slice(separator + 1));
    }
  }
  const algorithm = SRI_ALGORITHMS[strongest]?.digest;
  return algorithm === undefined ? undefined : harden({ algorithm, values });
};
harden(parseIntegrityMetadata);

/**
 * Digest bytes and compare — the check `fetch` runs itself when it is given
 * both a body and an `integrity`.
 *
 * @param bytes - The body to check.
 * @param check - What it has to match, from {@link parseIntegrityMetadata}.
 * @returns Whether the bytes match any digest in `check`.
 */
export const bytesMatchIntegrity = async (
  bytes: Uint8Array,
  check: IntegrityCheck,
): Promise<boolean> => {
  const { algorithm, values } = check;
  const digest = new Uint8Array(
    // The `crypto` global is what a browser realm has too, and the only place a
    // digest can come from there.
    // The bytes never come from a `SharedArrayBuffer`, so the cast is sound.
    await globalThis.crypto.subtle.digest(
      algorithm,
      bytes as Uint8Array<ArrayBuffer>,
    ),
  );
  const actual = normalizeDigest(bytesToBase64(digest));
  return values.some((value) => normalizeDigest(value) === actual);
};
harden(bytesMatchIntegrity);
