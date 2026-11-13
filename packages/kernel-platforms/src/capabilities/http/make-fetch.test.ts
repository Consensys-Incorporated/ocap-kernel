import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { makeFetch } from './make-fetch.ts';
import type { HttpCapability, HttpOptions, HttpResponse } from './types.ts';

vi.mock('@endo/eventual-send', () => ({
  E: (target: Record<string, (...args: unknown[]) => unknown>) =>
    new Proxy(target, {
      get(obj, prop: string) {
        return async (...args: unknown[]) => obj[prop]?.(...args);
      },
    }),
}));

type Reply = Partial<HttpResponse>;

/**
 * Make a stand-in `http` capability answering with each reply in turn, the
 * last one repeating.
 *
 * @param replies - The responses to give.
 * @returns The capability and its `request` mock.
 */
const makeHttp = (...replies: Reply[]) => {
  let index = 0;
  const request = vi.fn(
    async (_host: string[], _path: string[], _options: HttpOptions) => {
      const reply = replies[Math.min(index, replies.length - 1)] ?? {};
      index += 1;
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        ...reply,
      };
    },
  );
  return { http: { request } as unknown as HttpCapability, request };
};

const redirectTo = (status: number, location: string): Reply => ({
  status,
  statusText: 'Redirect',
  headers: { location },
});

describe('makeFetch', () => {
  it('splits the URL into the arguments of a request', async () => {
    const { http, request } = makeHttp({});
    await makeFetch(http)('https://api.example.com:8443/a/b%2Cc?x=1&y=2');
    expect(request).toHaveBeenCalledWith(
      ['com', 'example', 'api'],
      ['a', 'b,c'],
      {
        protocol: 'https',
        method: 'GET',
        port: 8443,
        query: [
          ['x', '1'],
          ['y', '2'],
        ],
      },
    );
  });

  it('requests the root path as no segments', async () => {
    const { http, request } = makeHttp({});
    await makeFetch(http)(new URL('http://localhost/'));
    expect(request).toHaveBeenCalledWith(['localhost'], [], {
      protocol: 'http',
      method: 'GET',
    });
  });

  // As `fetch` does: the six standard methods are uppercased, others kept.
  it.each([
    ['get', 'GET'],
    ['Post', 'POST'],
    ['delete', 'DELETE'],
    ['patch', 'patch'],
  ])('sends a %j method as %j', async (method, sent) => {
    const { http, request } = makeHttp({});
    await makeFetch(http)('https://example.com/', { method });
    expect(request).toHaveBeenCalledWith(['com', 'example'], [], {
      protocol: 'https',
      method: sent,
    });
  });

  it.each([
    [
      'init',
      'https://example.com/rpc',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    ],
    [
      'a Request',
      new Request('https://example.com/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
      { body: '{}' },
    ],
  ])(
    'forwards the method, headers, and body given in %s',
    async (_, input, init) => {
      const { http, request } = makeHttp({});
      await makeFetch(http)(input, init);
      expect(request).toHaveBeenCalledWith(['com', 'example'], ['rpc'], {
        protocol: 'https',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    },
  );

  it('sends a header named __proto__ as a header', async () => {
    const { http, request } = makeHttp({});
    await makeFetch(http)('https://example.com/', {
      headers: [['__proto__', 'p']],
    });
    const headers = request.mock.lastCall?.[2].headers;
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    expect(Object.entries(headers ?? {})).toStrictEqual([['__proto__', 'p']]);
  });

  it('answers with a Response built from the record', async () => {
    const { http } = makeHttp({
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    const response = await makeFetch(http)('https://example.com/');
    expect(response).toBeInstanceOf(Response);
    expect({
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('Content-Type'),
      json: await response.json(),
    }).toStrictEqual({
      status: 201,
      statusText: 'Created',
      contentType: 'application/json',
      json: { a: 1 },
    });
  });

  it('answers a null-body status without a body', async () => {
    const { http } = makeHttp({
      status: 204,
      statusText: 'No Content',
      body: 'x',
    });
    const response = await makeFetch(http)('https://example.com/');
    expect([response.status, response.body]).toStrictEqual([204, null]);
  });

  it.each([
    ['a non-HTTP protocol', 'ftp://example.com/', {}, /unsupported protocol/u],
    ['an IPv6 host', 'http://[::1]/', {}, /IPv6 hosts are unsupported/u],
    [
      'credentials in the URL',
      'https://user:pass@example.com/',
      {},
      /credentials in the URL/u,
    ],
    [
      'a malformed path segment',
      'https://example.com/a%zz',
      {},
      /malformed path segment a%zz/u,
    ],
    [
      'a signal already aborted',
      'https://example.com/',
      { signal: AbortSignal.abort(new Error('gave up')) },
      /gave up/u,
    ],
    [
      'a non-string body',
      'https://example.com/',
      { method: 'POST', body: new Uint8Array() },
      /only string bodies/u,
    ],
    [
      'a body on a Request',
      new Request('https://example.com/', { method: 'POST', body: 'x' }),
      {},
      /pass the body in init/u,
    ],
  ])('refuses %s', async (_, input, init, message) => {
    const { http, request } = makeHttp({});
    await expect(makeFetch(http)(input, init)).rejects.toThrow(message);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects with the reason when the signal aborts mid-request', async () => {
    const { http, request } = makeHttp({});
    request.mockReturnValueOnce(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = makeFetch(http)('https://example.com/', {
      signal: controller.signal,
    });
    controller.abort(new Error('gave up'));
    await expect(pending).rejects.toThrow('gave up');
  });

  it("ignores a Request's aborted signal that init clears with null", async () => {
    const { http, request } = makeHttp({});
    await makeFetch(http)(
      new Request('https://example.com/', { signal: AbortSignal.abort() }),
      { signal: null },
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect for a Request, whose signal every hop carries', async () => {
    const { http, request } = makeHttp(redirectTo(302, '/next'), {
      body: 'done',
    });
    const response = await makeFetch(http)(
      new Request('https://example.com/start'),
    );
    expect(await response.text()).toBe('done');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('throws when a global it needs is missing', () => {
    vi.stubGlobal('Response', undefined);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    expect(() => makeFetch(makeHttp({}).http)).toThrow(
      'missing the Response global',
    );
  });

  // The redirect rules are `makeGuardedFetch`'s, tested in `kernel-utils`;
  // these show that its hops go through `http`.
  it('follows a redirect by requesting the location through http', async () => {
    const { http, request } = makeHttp(redirectTo(302, '/next'), {
      body: 'done',
    });
    const response = await makeFetch(http)('https://example.com/start', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'payload',
    });
    expect(request).toHaveBeenLastCalledWith(['com', 'example'], ['next'], {
      protocol: 'https',
      method: 'GET',
    });
    expect({
      redirected: response.redirected,
      body: await response.text(),
    }).toStrictEqual({ redirected: true, body: 'done' });
  });

  it('fails when http refuses a redirect hop', async () => {
    const { http, request } = makeHttp(
      redirectTo(302, 'https://elsewhere.test/'),
    );
    request
      .mockImplementationOnce(async () => ({
        status: 302,
        statusText: 'Found',
        headers: { location: 'https://elsewhere.test/' },
        body: '',
      }))
      .mockRejectedValueOnce(new Error('outside the narrowing'));
    await expect(makeFetch(http)('https://example.com/')).rejects.toThrow(
      'outside the narrowing',
    );
  });

  it.each([
    // Of `done`.
    [
      'matches',
      'sha256-pMPtBKlaPaFKnSNcg9hovtfA9Fz38/qnUe6PUFmNIhE=',
      'body: done',
    ],
    [
      'does not match',
      'sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=',
      'error',
    ],
  ])(
    'checks an integrity that %s against the body the chain ends on',
    async (_, integrity, outcome) => {
      const { http } = makeHttp(redirectTo(302, '/next'), { body: 'done' });
      const result = await makeFetch(http)('https://example.com/', {
        integrity,
      }).then(
        async (response) => `body: ${await response.text()}`,
        () => 'error',
      );
      expect(result).toBe(outcome);
    },
  );
});
