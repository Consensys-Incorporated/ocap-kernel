import { makeTwoFacedFetchInput } from '@ocap/repo-tools/test-utils/fetch-input';
import { describe, expect, it } from 'vitest';

import { resolveFetchInput } from './fetch-input.ts';

describe('resolveFetchInput', () => {
  it.each([
    { name: 'string', makeInput: () => 'https://example.test/path' },
    {
      name: 'URL object',
      makeInput: () => new URL('https://example.test/path'),
    },
    {
      name: 'Request',
      makeInput: () => new Request('https://example.test/path'),
    },
  ])('resolves the URL of a $name input', ({ makeInput }) => {
    const { url } = resolveFetchInput(makeInput());
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe('https://example.test/path');
  });

  it('forwards a string input unchanged', () => {
    const original = 'https://example.test/path';
    expect(resolveFetchInput(original).input).toBe(original);
  });

  it('forwards a copy of a Request, never the caller’s own', async () => {
    const original = new Request('https://example.test/path', {
      method: 'POST',
      body: 'payload',
      headers: { 'x-test': '1' },
    });

    const forwarded = resolveFetchInput(original).input as Request;

    expect(forwarded).not.toBe(original);
    expect(forwarded).toBeInstanceOf(Request);
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get('x-test')).toBe('1');
    expect(await forwarded.text()).toBe('payload');
  });

  it('replaces a URL object with its href', () => {
    const { input } = resolveFetchInput(new URL('https://example.test/path'));
    expect(input).toBe('https://example.test/path');
  });

  it('throws for malformed URLs', () => {
    expect(() => resolveFetchInput('not a url')).toThrow(/Invalid URL/u);
  });

  it('throws for an input that resolves differently on a second read', () => {
    const { input } = makeTwoFacedFetchInput(
      'https://example.test/decoy',
      'https://evil.test/target',
    );

    expect(() => resolveFetchInput(input)).toThrow(
      'fetch input resolved to a different URL when read again.',
    );
  });

  it('accepts a stable stringifier and forwards the string it resolved to', () => {
    const { input, getReads } = makeTwoFacedFetchInput(
      'https://example.test/path',
      'https://example.test/path',
    );
    const resolved = resolveFetchInput(input);

    expect(resolved.url.href).toBe('https://example.test/path');
    expect(resolved.input).toBe('https://example.test/path');
    expect(getReads()).toBe(2);
  });

  it('reads a Request subclass through the internal slot, not an overridden getter', () => {
    class SpoofedRequest extends Request {
      // @ts-expect-error Deliberately shadows the `url` property with a getter.
      override get url(): string {
        return 'https://example.test/decoy';
      }
    }
    const request = new SpoofedRequest('https://evil.test/target');

    // The override is what naive validation would trust...
    expect(request.url).toBe('https://example.test/decoy');
    // ...but `fetch` uses the internal slot, and so does the resolver.
    expect(resolveFetchInput(request).url.href).toBe(
      'https://evil.test/target',
    );
    expect(new Request(request).url).toBe('https://evil.test/target');
  });

  it('resolves a Request whose backing state answers differently on each read', () => {
    const decoy = 'https://example.test/decoy';
    const target = 'https://evil.test/target';
    const request = new Request(decoy);

    // Tamper with the backing state where the runtime lets us — see
    // `resolveFetchInput`. Where it is a private field this loop finds nothing
    // to redefine and the assertions below are simply the ordinary case.
    for (const key of Object.getOwnPropertySymbols(request)) {
      const state = Reflect.get(request, key) as { urlList?: URL[] };
      if (!state?.urlList) {
        continue;
      }
      const tampered = {
        ...state,
        url: new URL(target),
        urlList: [new URL(target)],
      };
      let reads = 0;
      Object.defineProperty(request, key, {
        configurable: true,
        get: () => {
          reads += 1;
          return reads === 1 ? state : tampered;
        },
      });
    }

    const resolved = resolveFetchInput(request);

    // The property under test: what `fetch` resolves the forwarded input to is
    // what was validated.
    expect(resolved.input).not.toBe(request);
    expect(new Request(resolved.input as Request).url).toBe(resolved.url.href);
  });

  it('resolves a Request to a URL the caller cannot mutate afterwards', () => {
    const href = 'https://example.test/path';
    const request = new Request(href);
    // Same conditional tampering as above; here the planted `URL` is mutated
    // after the check.
    const planted = new URL(href);
    for (const key of Object.getOwnPropertySymbols(request)) {
      const state = Reflect.get(request, key) as { urlList?: URL[] };
      if (!state?.urlList) {
        continue;
      }
      Object.defineProperty(request, key, {
        configurable: true,
        value: { ...state, url: planted, urlList: [planted] },
      });
    }

    const resolved = resolveFetchInput(request);
    planted.hostname = 'evil.test';

    expect(resolved.url.href).toBe(href);
    expect(new Request(resolved.input as Request).url).toBe(href);
  });

  // A dispatcher planted on the caller's `Request` is shed by the copy that
  // precedes the rebuild. Only observable on the wire — the rebuilt `Request`
  // keeps a dispatcher out of reach whether or not it carried one — so it is
  // asserted against a live server in `guarded-fetch.test.ts`.

  it('throws for an object wearing Request.prototype without the internal slot', () => {
    const fake = Object.create(Request.prototype);
    Object.defineProperty(fake, 'url', { value: 'https://example.test/decoy' });

    expect(fake).toBeInstanceOf(Request);
    expect(() => resolveFetchInput(fake)).toThrow(TypeError);
  });
});
