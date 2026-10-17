import { GET_INTERFACE_GUARD } from '@endo/exo';
import { getInterfaceGuardPayload, M } from '@endo/patterns';
import type { MethodGuard } from '@endo/patterns';
import { pathUnder } from '@metamask/kernel-utils';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPlainLabels,
  compileHttpDelta,
  fromUrl,
  makeHttpBase,
  makeHttpSpecification,
  makeRequest,
  toHostLabels,
  toUrl,
} from './shared.ts';
import type { HttpCapability } from './types.ts';

// The narrowed capability is covered in `@ocap/kernel-test`; here `narrow`
// passes the base through, so a request reaches whichever `fetch` it wraps.
vi.mock('@metamask/kernel-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@metamask/kernel-utils')>()),
  narrow: vi.fn(async ({ base }: { base: unknown }) => base),
}));

const makeBaseFetch = (response: Response = new Response('ok')) =>
  vi.fn<typeof fetch>().mockResolvedValue(response);

describe('assertPlainLabels', () => {
  it('accepts lowercase labels', () => {
    expect(() =>
      assertPlainLabels(['com', 'example', 'api-v2', 'xn--bcher-kva'], 'host'),
    ).not.toThrow();
  });

  it.each([
    { name: 'a dot', host: ['com', 'example.evil'] },
    { name: 'an uppercase letter', host: ['com', 'Example'] },
    { name: 'a port', host: ['com', 'example:8080'] },
    { name: 'credentials', host: ['com', 'user@example'] },
    { name: 'an empty label', host: ['com', ''] },
  ])('rejects a label containing $name', ({ host }) => {
    expect(() => assertPlainLabels(host, 'host')).toThrow(
      'host contains an invalid label',
    );
  });

  it('rejects an empty host', () => {
    expect(() => assertPlainLabels([], 'host')).toThrow('host names no host');
  });
});

describe('toUrl', () => {
  it.each([
    {
      name: 'reverses the labels into a host',
      parts: { host: ['com', 'example', 'api'], path: ['v1', 'users'] },
      href: 'https://api.example.com/v1/users',
    },
    {
      name: 'applies the protocol and port',
      parts: { host: ['localhost'], path: [], protocol: 'http', port: 8080 },
      href: 'http://localhost:8080/',
    },
    {
      name: 'encodes a path segment, keeping the characters one may hold',
      parts: {
        host: ['com', 'example'],
        path: ['models', "x:gen@v1;a=b,c+d!$&'()*", '%2e%2e', 'a b?#'],
      },
      href: "https://example.com/models/x:gen@v1;a=b,c+d!$&'()*/%252e%252e/a%20b%3F%23",
    },
    {
      name: 'encodes the query',
      parts: {
        host: ['com', 'example'],
        path: ['q'],
        query: [
          ['a', '1 2'],
          ['a', '#'],
        ],
      },
      href: 'https://example.com/q?a=1+2&a=%23',
    },
  ] as const)('$name', ({ parts, href }) => {
    expect(
      toUrl(parts as unknown as Parameters<typeof toUrl>[0]).href,
    ).toStrictEqual(href);
  });

  it('rejects labels the parser rewrites into another host', () => {
    expect(() => toUrl({ host: ['1', '0x7f'], path: [] })).toThrow(
      'host 0x7f.1 parses as 127.0.0.1',
    );
  });

  it.each(['.', '..', 'a/../b', 'a\\b'])(
    'rejects the path segment %j',
    (segment) => {
      expect(() =>
        toUrl({ host: ['com', 'example'], path: ['v1', segment] }),
      ).toThrow('path contains an invalid segment');
    },
  );

  it.each([0, 65536, 1.5])('rejects the port %d', (port) => {
    expect(() => toUrl({ host: ['com', 'example'], path: [], port })).toThrow(
      'invalid port',
    );
  });
});

describe('fromUrl', () => {
  it.each([
    { host: ['com', 'example', 'api'], path: ['v1', 'users'] },
    {
      host: ['localhost'],
      path: [''],
      options: { protocol: 'http', port: 8080 },
    },
    {
      host: ['com', 'example'],
      path: ['models', 'x:gen@v1;a=b,c+d', 'a b?#'],
      options: { protocol: 'https', query: [['a', '1 2']] },
    },
  ] as const)('inverts toUrl for $host', ({ host, path, options }) => {
    const parts = {
      host: [...host],
      path: [...path],
      options: { protocol: 'https', ...options },
    };
    expect(
      fromUrl(
        toUrl({
          host: parts.host,
          path: parts.path,
          ...(parts.options as Parameters<typeof toUrl>[0]),
        }),
      ),
    ).toStrictEqual(parts);
  });

  it.each([
    ['ftp://example.com/', 'unsupported protocol ftp:'],
    ['http://[::1]/', 'IPv6 hosts are unsupported: [::1]'],
    ['https://u:p@example.com/', 'credentials in the URL are unsupported'],
    ['https://example.com/a%zz', 'malformed path segment a%zz'],
  ])('refuses %s', (href, message) => {
    expect(() => fromUrl(new URL(href))).toThrow(message);
  });
});

describe('makeRequest', () => {
  it('requests the built URL without following redirects', async () => {
    const baseFetch = makeBaseFetch();
    await makeRequest(baseFetch)(['com', 'example'], ['v1'], {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hi',
    });
    expect(baseFetch).toHaveBeenCalledWith('https://example.com/v1', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hi',
      redirect: 'manual',
    });
  });

  it('returns the response as a record', async () => {
    const response = new Response('hello', {
      status: 201,
      statusText: 'Created',
      headers: [
        ['x-a', '1'],
        ['x-a', '2'],
        ['__proto__', 'p'],
        // `Headers` yields each `set-cookie` apart rather than joined.
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
    });
    expect(
      await makeRequest(makeBaseFetch(response))(['com', 'example'], [], {}),
    ).toStrictEqual({
      status: 201,
      statusText: 'Created',
      headers: Object.fromEntries([
        ['__proto__', 'p'],
        ['content-type', 'text/plain;charset=UTF-8'],
        ['set-cookie', 'a=1, b=2'],
        ['x-a', '1, 2'],
      ]),
      body: 'hello',
    });
  });

  it('returns a redirect for the holder to follow', async () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: 'https://elsewhere.test/' },
    });
    expect(
      await makeRequest(makeBaseFetch(response))(['com', 'example'], [], {}),
    ).toMatchObject({
      status: 302,
      headers: { location: 'https://elsewhere.test/' },
    });
  });

  it('refuses a redirect the runtime hides', async () => {
    const response = Object.defineProperty(new Response(null), 'type', {
      value: 'opaqueredirect',
    });
    await expect(
      makeRequest(makeBaseFetch(response))(['com', 'example'], [], {}),
    ).rejects.toThrow('hides the target of a manual redirect');
  });

  it('refuses a response from a redirect followed below it', async () => {
    const response = Object.defineProperty(new Response('x'), 'redirected', {
      value: true,
    });
    await expect(
      makeRequest(makeBaseFetch(response))(['com', 'example'], [], {}),
    ).rejects.toThrow('followed a redirect below the capability');
  });

  it.each(['host', 'Host'])(
    'refuses a %s header before requesting',
    async (name) => {
      const baseFetch = makeBaseFetch();
      await expect(
        makeRequest(baseFetch)(['com', 'example'], [], {
          headers: { [name]: 'evil.test' },
        }),
      ).rejects.toThrow('http.request: the host header cannot be set');
      expect(baseFetch).not.toHaveBeenCalled();
    },
  );

  it('refuses a dot inside a label that a prefix pattern admits', async () => {
    const baseFetch = makeBaseFetch();
    await expect(
      makeRequest(baseFetch)(['com', 'example', 'evil.test'], [], {}),
    ).rejects.toThrow('http.request: host contains an invalid label');
    expect(baseFetch).not.toHaveBeenCalled();
  });
});

describe('toHostLabels', () => {
  it('reverses a hostname into lowercase labels', () => {
    expect(toHostLabels('API.Example.com')).toStrictEqual([
      'com',
      'example',
      'api',
    ]);
  });

  it.each([
    ['example..com', 'hosts entry contains an invalid label: ""'],
    ['example.com.', 'hosts entry contains an invalid label: ""'],
    ['ex ample.com', 'hosts entry contains an invalid label: "ex ample"'],
    ['example.com:8080', 'hosts entry example.com:8080 names a port'],
  ])('rejects %j', (hostname, message) => {
    expect(() => toHostLabels(hostname)).toThrow(message);
  });
});

describe('compileHttpDelta', () => {
  it('scopes request to the one host', () => {
    expect(compileHttpDelta({ hosts: ['example.com'] })).toStrictEqual({
      request: [pathUnder(['com', 'example'])],
    });
  });

  it('admits any of several hosts', () => {
    expect(
      compileHttpDelta({
        hosts: ['example.com', 'localhost'],
      }),
    ).toStrictEqual({
      request: [M.or(pathUnder(['com', 'example']), pathUnder(['localhost']))],
    });
  });
});

describe('makeHttpBase', () => {
  it('guards host, path and options, all required', () => {
    const base = makeHttpBase(makeBaseFetch());
    const { methodGuards } = getInterfaceGuardPayload(
      base[GET_INTERFACE_GUARD](),
    ) as unknown as { methodGuards: Record<string, MethodGuard> };

    expect(Object.keys(methodGuards)).toStrictEqual(['request']);
    expect(methodGuards.request).toStrictEqual(
      M.callWhen(
        M.arrayOf(M.string()),
        M.arrayOf(M.string()),
        M.splitRecord(
          {},
          {
            protocol: M.or('http', 'https'),
            port: M.number(),
            query: M.arrayOf([M.string(), M.string()]),
            method: M.string(),
            headers: M.recordOf(M.string(), M.string()),
            body: M.string(),
          },
        ),
      ).returns(
        M.splitRecord({
          status: M.number(),
          statusText: M.string(),
          headers: M.recordOf(M.string(), M.string()),
          body: M.string(),
        }),
      ),
    );
  });

  it('forwards a request to the platform fetch', async () => {
    const baseFetch = makeBaseFetch();
    const base = makeHttpBase(baseFetch);

    expect(
      await (base as Required<HttpCapability>).request(
        ['com', 'example'],
        [],
        {},
      ),
    ).toMatchObject({ status: 200, body: 'ok' });
  });
});

describe('makeHttpSpecification', () => {
  const specification = makeHttpSpecification({
    makeBaseFetch: () => makeBaseFetch(),
  });

  it.each([
    { name: "the platform's fetch by default", supplied: false },
    { name: 'a fetch the options supply', supplied: true },
  ])('requests through $name', async ({ supplied }) => {
    const platformFetch = makeBaseFetch();
    const suppliedFetch = makeBaseFetch();
    const capability = (await makeHttpSpecification({
      makeBaseFetch: () => platformFetch,
    }).capabilityFactory(
      { hosts: ['example.com'] },
      supplied ? { fetch: suppliedFetch } : undefined,
    )) as Required<HttpCapability>;
    await capability.request(['com', 'example'], [], {});
    expect({
      platform: platformFetch.mock.calls.length,
      supplied: suppliedFetch.mock.calls.length,
    }).toStrictEqual(
      supplied ? { platform: 0, supplied: 1 } : { platform: 1, supplied: 0 },
    );
  });

  it.each([
    { name: 'an empty label', hosts: ['localhost', 'example..com'] },
    { name: 'a port', hosts: ['example.com:8080'] },
  ])('rejects a hosts entry containing $name', async ({ hosts }) => {
    await expect(specification.capabilityFactory({ hosts })).rejects.toThrow(
      /hosts entry/u,
    );
  });
});
