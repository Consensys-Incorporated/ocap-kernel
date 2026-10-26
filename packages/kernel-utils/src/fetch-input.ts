export type FetchInput = Parameters<typeof fetch>[0];

export type ResolvedFetchInput = {
  /** The URL that `fetch` will request. */
  url: URL;
  /**
   * To hand to `fetch` in place of the caller's input: resolving it again
   * always yields `url`. The guarantee is over the destination only — a
   * `Request` body stream is still the caller's.
   */
  input: FetchInput;
};

/**
 * The `url` accessor is not always an own property of `Request.prototype`:
 * jsdom exposes a `Request` subclass whose own prototype carries only
 * `constructor`, leaving the accessor a level up.
 *
 * @returns The accessor, or `undefined` where `url` is a data property rather
 * than an accessor, as a polyfill assigning `this.url` leaves it.
 */
const findRequestUrlAccessor = (): ((this: Request) => string) | undefined => {
  // Not an `instanceof` guard's problem: this runs at module load, where a
  // realm without `Request` would otherwise fail the import outright.
  let proto: object | null =
    typeof Request === 'undefined' ? null : Request.prototype;
  while (proto) {
    // Deliberately unbound: applied to whichever `Request` a caller passes.
    // oxlint-disable-next-line typescript/unbound-method
    const { get } = Object.getOwnPropertyDescriptor(proto, 'url') ?? {};
    if (get) {
      return get as (this: Request) => string;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
};

/**
 * Captured at module load so that later tampering cannot redirect the read.
 * `fetch` takes a `Request`'s URL from the internal slot this accessor reads,
 * whereas `request.url` may be an override on a subclass.
 */
const getRequestUrl = findRequestUrlAccessor();

/**
 * Resolve a `fetch` input to the URL that will actually be requested, along
 * with a stand-in input that cannot resolve to any other URL.
 *
 * `fetch` accepts any object with a stringifier and stringifies it itself, so
 * code that validates `new URL(input)` and then forwards the caller's `input`
 * lets the input decide what each read returns — validating one URL while
 * requesting another (CWE-367). A `Request` is no safer: a subclass can
 * override `url`, and on some runtimes the state behind it is a mutable own
 * property. Forwarding the returned `input` closes both: its destination comes
 * from a string resolved here, so the check and the request cannot disagree.
 *
 * The result is deliberately not hardened: `harden` would transitively freeze
 * `URL.prototype`.
 *
 * @param input - The first argument to `fetch`: a string, `URL`, `Request`, or
 * anything else `fetch` would stringify.
 * @returns The resolved URL and the input to forward in its place.
 * @throws If the input does not resolve to a valid absolute URL.
 */
export const resolveFetchInput = (input: FetchInput): ResolvedFetchInput => {
  // A string is immutable, so it is already its own stand-in.
  if (typeof input === 'string') {
    return { url: new URL(input), input };
  }
  if (input instanceof Request) {
    // Copy first, so that only a genuine `Request`'s internals are read below.
    // The rebuild reads its argument as a `RequestInit`, by string name, so a
    // `dispatcher` planted on the caller's own object — undici's hook for where
    // the bytes go — would route the request anywhere. Also throws for anything
    // wearing `Request.prototype` without the backing state.
    const genuine = new Request(input);
    // Copying alone is not enough: undici on Node 22 keeps a `Request`'s state
    // in a configurable own property, so a caller can leave a `URL` it still
    // holds in there — copied by reference, mutated after the check, re-read at
    // send time. Parsing a string fixes the destination.
    //
    // Preferring the captured accessor is hardening, not the invariant: whatever
    // `href` turns out to be, the guard checks `new URL(href)` and the stand-in
    // is built from `url.href`, and `RequestInit` has no `url` member for
    // `genuine` to override. So check and request are pinned to the same string
    // either way; reading the slot only denies a lying subclass the choice of
    // which URL gets submitted for approval.
    const href = getRequestUrl ? getRequestUrl.call(genuine) : genuine.url;
    const url = new URL(href);
    return { url, input: new Request(url.href, genuine) };
  }
  // A `URL`, or an object with a stringifier. Parsed from the captured
  // primitive, so `input` is never consulted again.
  const href = String(input);
  const url = new URL(href);
  // Forwarding a primitive already makes a second read harmless, but an input
  // that answers differently each time is an escape attempt, not a mistake:
  // surface it rather than silently requesting whichever URL came first.
  if (String(input) !== href) {
    throw new Error('fetch input resolved to a different URL when read again.');
  }
  return { url, input: url.href };
};
harden(resolveFetchInput);
