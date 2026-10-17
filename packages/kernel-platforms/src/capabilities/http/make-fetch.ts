import { E } from '@endo/eventual-send';
import type { ERef } from '@endo/eventual-send';
import { makeGuardedFetch, raceAbort } from '@metamask/kernel-utils';

import { fromUrl, toHeaderRecord } from './shared.ts';
import type { HttpCapability, HttpMethods } from './types.ts';

// `E()` drops a method that a type marks optional, as `HttpCapability` does
// every method, since a narrowing may have removed it.
type HttpRequester = Pick<HttpMethods, 'request'>;

const nullBodyStatuses = new Set([101, 204, 205, 304]);

const requiredGlobals = ['URL', 'Request', 'Headers', 'Response'] as const;

/**
 * Make a `fetch` that makes one request through `http` and follows nothing,
 * as `makeGuardedFetch` requires of the `fetch` it wraps.
 *
 * @param http - The capability to send requests through.
 * @returns The single-hop `fetch`.
 */
const makeHttpTransport =
  (http: ERef<HttpRequester>): typeof fetch =>
  async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    // `http` takes a string body, and a `Request`'s is a stream.
    if (request?.body) {
      throw new TypeError('fetch: pass the body in init, not on the Request');
    }
    if (
      init.body !== undefined &&
      init.body !== null &&
      typeof init.body !== 'string'
    ) {
      throw new TypeError('fetch: only string bodies are supported');
    }
    // Every `Request` carries one, so it is honoured rather than refused.
    // An explicit `null` clears it, as `fetch` merges the two.
    const signal = init.signal === undefined ? request?.signal : init.signal;
    // Before sending: `raceAbort` sees the signal only once the request is.
    signal?.throwIfAborted();
    const { host, path, options } = fromUrl(
      new URL(
        request?.url ??
          (typeof input === 'string' ? input : (input as URL).href),
      ),
    );
    const headers = toHeaderRecord(
      new Headers(init.headers ?? request?.headers),
    );
    const {
      status,
      statusText,
      headers: responseHeaders,
      body,
    } = await raceAbort(
      E(http).request(host, path, {
        ...options,
        method: init.method ?? request?.method ?? 'GET',
        ...(Object.keys(headers).length > 0 && { headers }),
        ...(typeof init.body === 'string' && { body: init.body }),
      }),
      signal,
    );
    return new Response(nullBodyStatuses.has(status) ? null : body, {
      status,
      statusText,
      headers: responseHeaders,
    });
  };

/**
 * Make a `fetch` that sends every request through an `http` capability, so
 * that a vat names hosts as `api.example.com` while `http` is narrowed by
 * labels.
 *
 * Redirects, `integrity`, and the request's other semantics are those of
 * `makeGuardedFetch`, which follows each hop through `http` and so through
 * whatever narrowing it carries. Bodies are strings. Aborting the `signal`
 * rejects the `fetch`, though a request already sent still completes. In a
 * browser, which hides a redirect's target, a redirect fails. A response's
 * `url` is empty.
 *
 * A vat must request the `URL`, `Request`, `Headers`, and `Response` globals,
 * and `crypto` to check an `integrity`.
 *
 * @param http - The capability to send requests through.
 * @returns The `fetch`.
 */
export const makeFetch = (http: ERef<HttpCapability>): typeof fetch => {
  const missing = requiredGlobals.filter(
    (name) => typeof globalThis[name] !== 'function',
  );
  if (missing.length > 0) {
    throw new TypeError(
      `makeFetch: missing the ${missing.join(', ')} global; request it in VatConfig.globals`,
    );
  }
  return makeGuardedFetch({
    baseFetch: makeHttpTransport(http as ERef<HttpRequester>),
    // The narrowing is the guard: every hop is a call on `http`.
    guard: async () => undefined,
  });
};
