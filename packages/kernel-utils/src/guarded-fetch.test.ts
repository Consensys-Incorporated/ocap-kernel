import { fetchMock } from '@ocap/repo-tools/test-utils/fetch-mock';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { makeGuardedFetch } from './guarded-fetch.ts';
import type { FetchGuard } from './guarded-fetch.ts';

type ReceivedRequest = {
  method: string;
  path: string;
  body: string;
  headers: http.IncomingHttpHeaders;
};

type Responder = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => void;

type TestServer = {
  port: number;
  received: ReceivedRequest[];
  respondWith: (responder: Responder) => void;
};

const running: http.Server[] = [];

/**
 * Start a loopback HTTP server that records what it receives. Bound on every
 * interface rather than one address, so that `localhost` and `127.0.0.1` both
 * reach it and can stand in for an allowed and a forbidden host.
 *
 * @returns A handle on the running server.
 */
const startServer = async (): Promise<TestServer> => {
  const received: ReceivedRequest[] = [];
  let responder: Responder = (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('landed');
  };
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({
        method: request.method as string,
        path: request.url as string,
        body,
        headers: request.headers,
      });
      responder(request, response);
    });
  });
  running.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    received,
    respondWith: (next: Responder) => {
      responder = next;
    },
  };
};

const redirectTo =
  (status: number, location: string): Responder =>
  (_request, response) => {
    response.writeHead(status, { location });
    response.end('redirecting');
  };

// Digests of `landed`, the body a chain here ends on, and of `redirecting`, the
// body of the hops on the way — a digest of the resource is what a caller
// writes, and a digest of a hop is what checking the wrong body would want.
const LANDED_SHA256 = 'sha256-eO4Sxl1Ae6BpTfkQxrgVk4v2EZ9yiL1yCkjJjhGvV7w=';
const LANDED_SHA512 =
  'sha512-/WP9o53KurTHJ4rql4UaN6JkP9KbZN0hjdcXgkhQUJRrZZJ3YGPrVXQZItUilpNBzTYdAX1qONrclS0/J0JW2A==';
const REDIRECTING_SHA256 =
  'sha256-etTf+nmjsDY8FN+ggw4Pdq7I90HT0Yr84x9CY6XgiLY=';

// Allows `localhost` only, so `127.0.0.1` is a forbidden host on the same
// loopback interface.
const allowLocalhost: FetchGuard = async (url: URL) => {
  if (url.hostname !== 'localhost') {
    throw new Error(`Invalid host: ${url.hostname}`);
  }
};

// For tests about what a hop carries rather than where it goes.
const allowAnyHost: FetchGuard = async () => undefined;

const guardedLoopback = (guard: FetchGuard = allowLocalhost): typeof fetch =>
  makeGuardedFetch({ baseFetch: fetch, guard });

// A server that redirects to a second one. `host` picks the name the second is
// reached by, so the hop can be made to leave the allowlist or stay inside it.
const startRedirect = async ({
  status = 302,
  host = 'localhost',
  path = '/landed',
}: { status?: number; host?: string; path?: string } = {}): Promise<{
  start: TestServer;
  destination: TestServer;
}> => {
  const destination = await startServer();
  const start = await startServer();
  start.respondWith(
    redirectTo(status, `http://${host}:${destination.port}${path}`),
  );
  return { start, destination };
};

// Redirect each path in `routes` to the location it maps to, answering anything
// else with `body`.
const redirectRoutes =
  (
    routes: Record<string, string>,
    { status = 302, body = 'landed' }: { status?: number; body?: string } = {},
  ): Responder =>
  (request, response) => {
    const location = routes[request.url as string];
    if (location) {
      response.writeHead(status, { location });
      response.end();
      return;
    }
    response.writeHead(200);
    response.end(body);
  };

/**
 * A request body that cannot be sent twice.
 *
 * @param text - What the stream yields.
 * @returns The body, and the `duplex` that sending a stream requires.
 */
const streamBody = (text: string): RequestInit => ({
  // ReadableStream is flagged experimental for Node 22, but this case works.
  body: new ReadableStream({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }),
  duplex: 'half',
});

describe('makeGuardedFetch', () => {
  beforeAll(() => {
    // Redirect handling is undici's behaviour as much as ours, so these tests
    // run against live servers; the repo-wide fetch mock would answer instead.
    fetchMock.disableMocks();
  });

  afterAll(() => {
    fetchMock.enableMocks();
  });

  afterEach(async () => {
    await Promise.all(
      running.splice(0).map(
        async (server) =>
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('passes a request the guard allows straight through', async () => {
    const server = await startServer();
    const guarded = guardedLoopback();

    const response = await guarded(`http://localhost:${server.port}/thing`);

    expect(await response.text()).toBe('landed');
    expect(response.redirected).toBe(false);
    expect(response.url).toBe(`http://localhost:${server.port}/thing`);
  });

  it('refuses a request the guard rejects', async () => {
    const server = await startServer();
    const guarded = guardedLoopback();

    await expect(guarded(`http://127.0.0.1:${server.port}/`)).rejects.toThrow(
      'Invalid host: 127.0.0.1',
    );
    expect(server.received).toStrictEqual([]);
  });

  describe('redirects', () => {
    it('refuses a redirect to a host the guard rejects, and never contacts it', async () => {
      const { start: allowed, destination: forbidden } = await startRedirect({
        host: '127.0.0.1',
        path: '/secrets',
      });
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${allowed.port}/start`),
      ).rejects.toThrow('Invalid host: 127.0.0.1');

      expect(allowed.received).toHaveLength(1);
      expect(forbidden.received).toStrictEqual([]);
    });

    it('follows a redirect the guard allows and returns the final response', async () => {
      const { start: first, destination: second } = await startRedirect();
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${first.port}/start`);

      expect(await response.text()).toBe('landed');
      expect(response.url).toBe(`http://localhost:${second.port}/landed`);
      expect(response.redirected).toBe(true);
      expect(second.received[0]?.path).toBe('/landed');
    });

    it('follows a chain of allowed hops and re-runs the guard on each', async () => {
      const server = await startServer();
      const origin = `http://localhost:${server.port}`;
      server.respondWith(
        redirectRoutes(
          { '/one': `${origin}/two`, '/two': `${origin}/three` },
          { body: 'arrived' },
        ),
      );
      const guard = vi.fn(allowLocalhost);
      const guarded = makeGuardedFetch({ baseFetch: fetch, guard });

      const response = await guarded(`${origin}/one`);

      expect(await response.text()).toBe('arrived');
      expect(response.url).toBe(`${origin}/three`);
      expect(response.redirected).toBe(true);
      expect(guard.mock.calls.map(([url]) => url.pathname)).toStrictEqual([
        '/one',
        '/two',
        '/three',
      ]);
    });

    it('refuses a hop out of the allowlist part-way through a chain', async () => {
      const forbidden = await startServer();
      const allowed = await startServer();
      allowed.respondWith((request, response) => {
        response.writeHead(302, {
          location:
            request.url === '/one'
              ? `http://localhost:${allowed.port}/two`
              : `http://127.0.0.1:${forbidden.port}/secrets`,
        });
        response.end();
      });
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${allowed.port}/one`),
      ).rejects.toThrow('Invalid host: 127.0.0.1');
      expect(forbidden.received).toStrictEqual([]);
    });

    it('follows a redirect back to an allowed host', async () => {
      const other = await startServer();
      const home = await startServer();
      home.respondWith(
        redirectRoutes(
          { '/out': `http://127.0.0.1:${other.port}/via` },
          { body: 'home again' },
        ),
      );
      other.respondWith(redirectTo(302, `http://localhost:${home.port}/back`));
      // Both loopback names allowed, so the excursion is legitimate.
      const guarded = makeGuardedFetch({
        baseFetch: fetch,
        guard: async ({ hostname }) => {
          if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
            throw new Error(`Invalid host: ${hostname}`);
          }
        },
      });

      const response = await guarded(`http://localhost:${home.port}/out`);

      expect(await response.text()).toBe('home again');
      expect(response.url).toBe(`http://localhost:${home.port}/back`);
      expect(response.redirected).toBe(true);
    });

    it('gives up on a redirect loop after 20 hops', async () => {
      const server = await startServer();
      const origin = `http://localhost:${server.port}`;
      server.respondWith(redirectTo(302, `${origin}/loop`));
      const guarded = guardedLoopback();

      await expect(guarded(`${origin}/loop`)).rejects.toThrow(
        'exceeded 20 redirects',
      );
      // The initial request plus the 20 hops it was allowed.
      expect(server.received).toHaveLength(21);
    });

    it('returns a redirect status that carries no Location as a response', async () => {
      const server = await startServer();
      server.respondWith((_request, response) => {
        response.writeHead(302);
        response.end('nowhere');
      });
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${server.port}/`);

      expect(response.status).toBe(302);
      expect(response.redirected).toBe(false);
      expect(await response.text()).toBe('nowhere');
    });

    it('resolves a relative Location against the hop that sent it', async () => {
      const second = await startServer();
      const first = await startServer();
      // The relative hop is the second one, so a `Location` resolved against
      // the URL the caller asked for lands on the wrong server entirely.
      first.respondWith(
        redirectTo(302, `http://localhost:${second.port}/deep/start`),
      );
      second.respondWith(
        redirectRoutes(
          { '/deep/start': '../landed' },
          { status: 301, body: 'relative' },
        ),
      );
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${first.port}/one`);

      expect(await response.text()).toBe('relative');
      expect(response.url).toBe(`http://localhost:${second.port}/landed`);
      expect(first.received.map(({ path }) => path)).toStrictEqual(['/one']);
    });
  });

  describe('the redirect mode the caller asks for', () => {
    /**
     * A server that redirects out of the allowlist, and the forbidden server
     * it points at.
     *
     * @returns Both servers.
     */

    it('checks the hop when init asks fetch to follow', async () => {
      const { start: allowed, destination: forbidden } = await startRedirect({
        host: '127.0.0.1',
        path: '/secrets',
      });
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${allowed.port}/start`, {
          redirect: 'follow',
        }),
      ).rejects.toThrow('Invalid host: 127.0.0.1');
      expect(forbidden.received).toStrictEqual([]);
    });

    it('checks the hop when a Request asks fetch to follow', async () => {
      const { start: allowed, destination: forbidden } = await startRedirect({
        host: '127.0.0.1',
        path: '/secrets',
      });
      const guarded = guardedLoopback();

      await expect(
        guarded(
          new Request(`http://localhost:${allowed.port}/start`, {
            redirect: 'follow',
          }),
        ),
      ).rejects.toThrow('Invalid host: 127.0.0.1');
      expect(forbidden.received).toStrictEqual([]);
    });

    it('hands back the redirect unfollowed when the caller asks for manual', async () => {
      const { start: allowed, destination: forbidden } = await startRedirect({
        host: '127.0.0.1',
        path: '/secrets',
      });
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${allowed.port}/start`, {
        redirect: 'manual',
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        `http://127.0.0.1:${forbidden.port}/secrets`,
      );
      expect(response.redirected).toBe(false);
      expect(forbidden.received).toStrictEqual([]);
    });

    it('fails the fetch when the caller asks for error', async () => {
      const { start: allowed, destination: forbidden } = await startRedirect({
        host: '127.0.0.1',
        path: '/secrets',
      });
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${allowed.port}/start`, {
          redirect: 'error',
        }),
      ).rejects.toThrow(/was redirected, and redirect: 'error' was requested/u);
      expect(forbidden.received).toStrictEqual([]);
    });

    it('fails the fetch when the caller asks for error and the hop names nowhere', async () => {
      const server = await startServer();
      server.respondWith((_request, response) => {
        response.writeHead(302);
        response.end('redirecting');
      });
      const guarded = guardedLoopback();

      // Why the mode is answered before the `Location` is read: see `guardedFetch`.
      await expect(
        guarded(`http://localhost:${server.port}/start`, {
          redirect: 'error',
        }),
      ).rejects.toThrow(/was redirected, and redirect: 'error' was requested/u);
    });

    it('follows a hop for a caller that asked for manual but was not redirected', async () => {
      const server = await startServer();
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${server.port}/thing`, {
        redirect: 'manual',
      });

      expect(await response.text()).toBe('landed');
    });
  });

  describe('a caller-supplied dispatcher', () => {
    it('is refused rather than dropped, since dropping it would egress anyway', async () => {
      const server = await startServer();
      const dispatch = vi.fn();
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${server.port}/`, {
          dispatcher: { dispatch, close: async () => undefined },
        } as unknown as RequestInit),
      ).rejects.toThrow(/cannot accept a `dispatcher`/u);
      expect(dispatch).not.toHaveBeenCalled();
      expect(server.received).toStrictEqual([]);
    });

    it('is shed from a Request rather than refused, being unreadable there', async () => {
      const server = await startServer();
      const dispatch = vi.fn();
      const guarded = guardedLoopback();

      // A `Request` exposes no dispatcher to check for — undici keeps it out
      // of reach on some runtimes — so `resolveFetchInput`'s rebuild dropping
      // it is the whole defence.
      const response = await guarded(
        new Request(`http://localhost:${server.port}/`, {
          dispatcher: { dispatch, close: async () => undefined },
        } as unknown as RequestInit),
      );

      expect(await response.text()).toBe('landed');
      expect(dispatch).not.toHaveBeenCalled();
      expect(server.received).toHaveLength(1);
    });

    it('is shed from a Request that carries it as an own property', async () => {
      const server = await startServer();
      const dispatch = vi.fn();
      const guarded = guardedLoopback();
      // Planted where the rebuild reads its argument as a `RequestInit`, by
      // string name. Without the copy that precedes the rebuild this would be
      // read back off the caller's own object and honoured — the copy is the
      // only thing between this and a transport of the caller's choosing.
      const planted = new Request(`http://localhost:${server.port}/`);
      Object.defineProperty(planted, 'dispatcher', {
        configurable: true,
        get: () => ({ dispatch, close: async () => undefined }),
      });

      const response = await guarded(planted);

      expect(await response.text()).toBe('landed');
      expect(dispatch).not.toHaveBeenCalled();
      expect(server.received).toHaveLength(1);
    });

    it('is not honoured when an accessor hides it from the check', async () => {
      const server = await startServer();
      const dispatch = vi.fn();
      const guarded = guardedLoopback();
      // The CWE-367 shape aimed at the check rather than the URL. One read
      // serves both the check and the request, so the dispatcher is either
      // refused or absent — never refused and then sent.
      let reads = 0;
      const init = {
        get dispatcher() {
          reads += 1;
          return reads === 1
            ? undefined
            : { dispatch, close: async () => undefined };
        },
      };

      const response = await guarded(
        `http://localhost:${server.port}/`,
        init as unknown as RequestInit,
      );

      expect(await response.text()).toBe('landed');
      expect(dispatch).not.toHaveBeenCalled();
      expect(server.received).toHaveLength(1);
    });

    it('is not confused by an absent one', async () => {
      const server = await startServer();
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${server.port}/`, {
        dispatcher: undefined,
      } as unknown as RequestInit);

      expect(await response.text()).toBe('landed');
    });
  });

  describe('method and body across a redirect', () => {
    it('leaves a HEAD alone on a 303, which rewrites everything else', async () => {
      const { start, destination } = await startRedirect({ status: 303 });
      const guarded = guardedLoopback();

      await guarded(`http://localhost:${start.port}/start`, { method: 'HEAD' });

      expect(destination.received[0]?.method).toBe('HEAD');
    });

    it.each([
      { status: 307, method: 'POST' },
      { status: 308, method: 'POST' },
      { status: 302, method: 'PUT' },
    ])(
      'keeps the method and body across a $status from a $method',
      async ({ status, method }) => {
        const destination = await startServer();
        const start = await startServer();
        start.respondWith(
          redirectTo(status, `http://localhost:${destination.port}/landed`),
        );
        const guarded = guardedLoopback();

        const response = await guarded(`http://localhost:${start.port}/start`, {
          method,
          body: 'payload',
          headers: { 'content-type': 'text/plain' },
        });

        expect(await response.text()).toBe('landed');
        expect(destination.received[0]).toMatchObject({
          method,
          body: 'payload',
        });
        expect(destination.received[0]?.headers['content-type']).toBe(
          'text/plain',
        );
      },
    );

    it.each([
      { status: 301, method: 'POST' },
      { status: 302, method: 'POST' },
      { status: 303, method: 'POST' },
      { status: 303, method: 'PUT' },
      // `fetch` upper-cases the methods it knows, so the rewrite has to too.
      { status: 302, method: 'post' },
    ])(
      'turns a $method into a bodyless GET on a $status',
      async ({ status, method }) => {
        const destination = await startServer();
        const start = await startServer();
        start.respondWith(
          redirectTo(status, `http://localhost:${destination.port}/landed`),
        );
        const guarded = guardedLoopback();

        await guarded(`http://localhost:${start.port}/start`, {
          method,
          body: 'payload',
          headers: {
            'content-type': 'text/plain',
            'content-language': 'en',
            'content-location': '/here',
          },
        });

        expect(destination.received[0]).toMatchObject({
          method: 'GET',
          body: '',
        });
        expect(
          destination.received[0]?.headers['content-type'],
        ).toBeUndefined();
        expect(
          destination.received[0]?.headers['content-length'],
        ).toBeUndefined();
        expect(
          destination.received[0]?.headers['content-language'],
        ).toBeUndefined();
        expect(
          destination.received[0]?.headers['content-location'],
        ).toBeUndefined();
      },
    );

    it('refuses to replay a stream body rather than truncating the request', async () => {
      const { start, destination } = await startRedirect({ status: 307 });
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${start.port}/start`, {
          method: 'POST',
          ...streamBody('streamed'),
        }),
      ).rejects.toThrow(
        /Cannot follow the 307 redirect .* cannot be sent a second time/u,
      );
      expect(destination.received).toStrictEqual([]);
    });

    it('drops a stream body on a 303 instead of failing, since the hop does not keep it', async () => {
      const { start, destination } = await startRedirect({ status: 303 });
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${start.port}/start`, {
        method: 'POST',
        ...streamBody('streamed'),
      });

      expect(await response.text()).toBe('landed');
      expect(destination.received[0]).toMatchObject({
        method: 'GET',
        body: '',
      });
    });
  });

  describe('credentials across a redirect', () => {
    it('drops them when the hop leaves the origin', async () => {
      const { start, destination } = await startRedirect({
        status: 307,
        host: '127.0.0.1',
      });
      const guarded = guardedLoopback(allowAnyHost);

      await guarded(`http://localhost:${start.port}/start`, {
        headers: { authorization: 'Bearer secret', cookie: 'session=secret' },
      });

      expect(start.received[0]?.headers.authorization).toBe('Bearer secret');
      expect(destination.received[0]?.headers.authorization).toBeUndefined();
      expect(destination.received[0]?.headers.cookie).toBeUndefined();
    });

    it('keeps them when the hop stays on the origin', async () => {
      const server = await startServer();
      const origin = `http://localhost:${server.port}`;
      server.respondWith(
        redirectRoutes({ '/start': `${origin}/landed` }, { status: 307 }),
      );
      const guarded = guardedLoopback();

      await guarded(`${origin}/start`, {
        headers: { authorization: 'Bearer secret' },
      });

      expect(server.received[1]?.headers.authorization).toBe('Bearer secret');
    });
  });

  describe('abort', () => {
    it('propagates through a redirect hop', async () => {
      const hang = await startServer();
      hang.respondWith(() => {
        // Never answers, so the abort has something to interrupt.
      });
      const start = await startServer();
      start.respondWith(
        redirectTo(302, `http://localhost:${hang.port}/forever`),
      );
      const controller = new AbortController();
      const guarded = makeGuardedFetch({
        baseFetch: fetch,
        guard: async (url) => {
          if (url.pathname === '/forever') {
            controller.abort();
          }
        },
      });

      await expect(
        guarded(`http://localhost:${start.port}/start`, {
          signal: controller.signal,
        }),
      ).rejects.toThrow(/abort/iu);
    });

    it('propagates from a Request through a redirect hop', async () => {
      const hang = await startServer();
      hang.respondWith(() => {
        // Never answers.
      });
      const start = await startServer();
      start.respondWith(
        redirectTo(302, `http://localhost:${hang.port}/forever`),
      );
      const controller = new AbortController();
      const guarded = makeGuardedFetch({
        baseFetch: fetch,
        guard: async (url) => {
          if (url.pathname === '/forever') {
            controller.abort();
          }
        },
      });

      await expect(
        guarded(
          new Request(`http://localhost:${start.port}/start`, {
            signal: controller.signal,
          }),
        ),
      ).rejects.toThrow(/abort/iu);
    });
  });

  describe('a Request input', () => {
    it('keeps its method, headers and body', async () => {
      const server = await startServer();
      const guarded = guardedLoopback();

      await guarded(
        new Request(`http://localhost:${server.port}/thing`, {
          method: 'POST',
          body: 'from a request',
          headers: { 'x-marker': 'kept' },
        }),
      );

      expect(server.received[0]).toMatchObject({
        method: 'POST',
        body: 'from a request',
      });
      expect(server.received[0]?.headers['x-marker']).toBe('kept');
    });

    it('is overridden by an init that names the same thing', async () => {
      const server = await startServer();
      const guarded = guardedLoopback();

      await guarded(
        new Request(`http://localhost:${server.port}/thing`, {
          method: 'POST',
          body: 'from a request',
        }),
        { method: 'PUT', body: 'from an init' },
      );

      expect(server.received[0]).toMatchObject({
        method: 'PUT',
        body: 'from an init',
      });
    });

    it('carries its body to a hop that keeps it only if it can be replayed', async () => {
      const { start, destination } = await startRedirect({ status: 307 });
      const guarded = guardedLoopback();

      // Why a string body still fails here: see `isReplayableBody`.
      await expect(
        guarded(
          new Request(`http://localhost:${start.port}/start`, {
            method: 'POST',
            body: 'from a request',
          }),
        ),
      ).rejects.toThrow(/cannot be sent a second time/u);
      expect(destination.received).toStrictEqual([]);
    });
  });

  describe('with a scripted fetch', () => {
    // Replies with each response in turn, so a hop's exact arguments can be
    // inspected without a server in the way. Returned as the mock rather than as
    // `typeof fetch`, so a test can read what each hop was actually sent —
    // `baseFetch` is where a hop's init is complete, the guard being handed the
    // URL alone.
    const scriptFetch = (...responses: Response[]) => {
      const remaining = [...responses];
      return vi.fn(
        async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
          remaining.shift() as Response,
      );
    };

    it('discards the body of a redirect it does not return', async () => {
      let cancelled = false;
      const redirectBody = new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      });
      const guarded = makeGuardedFetch({
        baseFetch: scriptFetch(
          new Response(redirectBody, {
            status: 302,
            headers: { location: 'http://localhost/landed' },
          }),
          new Response('landed'),
        ),
        guard: allowLocalhost,
      });

      const response = await guarded('http://localhost/start');

      expect(await response.text()).toBe('landed');
      expect(cancelled).toBe(true);
    });

    it('sends each hop the request the rewrite left it with', async () => {
      const baseFetch = scriptFetch(
        new Response('', {
          status: 303,
          headers: { location: 'http://localhost/landed' },
        }),
        new Response('landed'),
      );
      const guarded = makeGuardedFetch({ baseFetch, guard: allowLocalhost });

      await guarded('http://localhost/start', { method: 'POST', body: 'sent' });

      expect(baseFetch.mock.calls[0]?.[1]).toMatchObject({
        method: 'POST',
        body: 'sent',
        redirect: 'manual',
      });
      // The 303 rewrote the request, and the hop is sent the rewrite.
      expect(baseFetch.mock.calls[1]?.[0]).toBe('http://localhost/landed');
      expect(baseFetch.mock.calls[1]?.[1]).toMatchObject({
        method: 'GET',
        body: null,
        redirect: 'manual',
      });
    });

    it('hands the guard the URL of each hop and nothing else', async () => {
      const guard = vi.fn(allowLocalhost);
      const guarded = makeGuardedFetch({
        baseFetch: scriptFetch(
          new Response('', {
            status: 303,
            headers: { location: 'http://localhost/landed' },
          }),
          new Response('landed'),
        ),
        guard,
      });

      await guarded('http://localhost/start', { method: 'POST', body: 'sent' });

      // A guard shown the request too would be shown a first hop assembled
      // differently from every later one — `method` and `body` reach the first
      // request from the caller's own init, and later ones from the rewrite.
      expect(guard.mock.calls).toStrictEqual([
        [new URL('http://localhost/start')],
        [new URL('http://localhost/landed')],
      ]);
    });

    it('refuses a response that followed a redirect below the guard', async () => {
      // Every request here asks for `manual`, so a base fetch reporting that it
      // was redirected walked a chain the guard never saw. Returning it would be
      // the pre-flight-only checking this wrapper replaces.
      const followed = {
        type: 'basic',
        status: 200,
        redirected: true,
        headers: new Headers(),
        body: null,
      } as unknown as Response;
      const baseFetch = scriptFetch(followed);
      const guarded = makeGuardedFetch({ baseFetch, guard: allowLocalhost });

      await expect(guarded('http://localhost/start')).rejects.toThrow(
        /followed a redirect below the guard/u,
      );
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('refuses an opaque redirect, which hides the hop instead of exposing it', async () => {
      // A browser's opaque-redirect response: no status, no headers.
      const opaque = {
        type: 'opaqueredirect',
        status: 0,
        headers: new Headers(),
        body: null,
      } as unknown as Response;
      const baseFetch = scriptFetch(opaque, new Response('landed'));
      const guarded = makeGuardedFetch({ baseFetch, guard: allowLocalhost });

      await expect(guarded('http://localhost/start')).rejects.toThrow(
        /hides the target of a manual redirect/u,
      );
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('follows the hop even when discarding the redirect body fails', async () => {
      const guarded = makeGuardedFetch({
        baseFetch: scriptFetch(
          new Response('redirecting', {
            status: 302,
            headers: { location: 'http://localhost/landed' },
          }),
          new Response('landed'),
        ),
        guard: allowLocalhost,
      });
      vi.spyOn(ReadableStream.prototype, 'cancel').mockRejectedValue(
        new Error('already gone'),
      );

      expect(await (await guarded('http://localhost/start')).text()).toBe(
        'landed',
      );
    });

    it('strips credentials on a hop that only changes scheme', async () => {
      const baseFetch = scriptFetch(
        new Response('', {
          status: 307,
          headers: { location: 'http://example.test/landed' },
        }),
        new Response('landed'),
      );
      const guarded = makeGuardedFetch({
        baseFetch,
        guard: allowAnyHost,
      });

      await guarded('https://example.test/start', {
        headers: { authorization: 'Bearer secret' },
      });

      const hopInit = baseFetch.mock.calls[1]?.[1] as RequestInit;
      expect((hopInit.headers as Headers).get('authorization')).toBeNull();
    });

    it('withholds a Request’s integrity from every request it sends', async () => {
      const baseFetch = scriptFetch(
        new Response('redirecting', {
          status: 307,
          headers: { location: 'http://localhost/landed' },
        }),
        new Response('landed'),
      );
      const guarded = makeGuardedFetch({ baseFetch, guard: allowLocalhost });

      // A digest of the resource, which `fetch` would check against each hop.
      await guarded(
        new Request('http://localhost/start', { integrity: LANDED_SHA256 }),
      );

      // An empty string, not an absent member: a `Request`'s own integrity
      // stands behind an init that does not name one.
      expect(
        baseFetch.mock.calls.map(([, init]) => init?.integrity),
      ).toStrictEqual(['', '']);
    });

    it('shows the guard the headers it will send, not ones changed since', async () => {
      const headers = new Headers({ 'x-marker': 'before' });
      const baseFetch = scriptFetch(new Response('landed'));
      const guarded = makeGuardedFetch({
        baseFetch,
        guard: async () => {
          // The caller still holds its own header object, and the guard is
          // async, so it has a turn in which to change it.
          headers.set('x-marker', 'after');
        },
      });

      await guarded('http://localhost/start', { headers });

      const [, sentInit] = (baseFetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [unknown, RequestInit];
      expect((sentInit.headers as Headers).get('x-marker')).toBe('before');
    });

    it('never lets the caller’s own input reach a hop', async () => {
      const baseFetch = scriptFetch(
        new Response('', {
          status: 307,
          headers: { location: 'http://localhost/landed' },
        }),
        new Response('landed'),
      );
      const guarded = makeGuardedFetch({ baseFetch, guard: allowLocalhost });

      await guarded(new Request('http://localhost/start'));

      const [hopInput] = (baseFetch as ReturnType<typeof vi.fn>).mock
        .calls[1] as [unknown];
      expect(hopInput).toBe('http://localhost/landed');
    });
  });

  describe('a Location the guard must not be able to misread', () => {
    it.each([
      { label: 'protocol-relative', location: '//127.0.0.1:PORT/secrets' },
      {
        label: 'userinfo confusion',
        location: 'http://localhost@127.0.0.1:PORT/secrets',
      },
      {
        label: 'decimal IPv4 literal',
        location: 'http://2130706433:PORT/secrets',
      },
      {
        label: 'trailing-dot host',
        location: 'http://127.0.0.1.:PORT/secrets',
      },
    ])('refuses a $label hop', async ({ location }) => {
      const forbidden = await startServer();
      const allowed = await startServer();
      allowed.respondWith(
        redirectTo(302, location.replace('PORT', String(forbidden.port))),
      );
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${allowed.port}/start`),
      ).rejects.toThrow('Invalid host:');
      expect(forbidden.received).toStrictEqual([]);
    });

    it.each([
      'data:text/plain,x',
      'file:///etc/passwd',
      'blob:https://example.test/abc',
    ])('refuses a hop to %s by naming its scheme', async (location) => {
      const server = await startServer();
      server.respondWith(redirectTo(302, location));
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${server.port}/start`),
      ).rejects.toThrow(/which a guarded fetch will not follow/u);
      expect(server.received).toHaveLength(1);
    });

    it('hands back an empty Location rather than requesting the same URL again', async () => {
      const server = await startServer();
      server.respondWith(redirectTo(302, '   '));
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${server.port}/start`);

      expect(response.status).toBe(302);
      expect(server.received).toHaveLength(1);
    });

    it('refuses a Location that will not parse', async () => {
      const server = await startServer();
      server.respondWith(redirectTo(302, 'http://['));
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${server.port}/start`),
      ).rejects.toThrow(/redirected to an unusable location/u);
      expect(server.received).toHaveLength(1);
    });
  });

  describe('the origin comparison that decides credential stripping', () => {
    it('treats a different hostname on the same port as a different origin', async () => {
      const server = await startServer();
      // The same server under a name the allowlist also permits, so the
      // hostname is the only part of the origin that differs.
      server.respondWith(
        redirectRoutes(
          { '/start': `http://127.0.0.1:${server.port}/landed` },
          { status: 307 },
        ),
      );
      const guarded = guardedLoopback(allowAnyHost);

      await guarded(`http://localhost:${server.port}/start`, {
        headers: { authorization: 'Bearer secret' },
      });

      expect(server.received[1]?.headers.authorization).toBeUndefined();
    });

    it('treats a different port on the same hostname as a different origin', async () => {
      const { start, destination } = await startRedirect({ status: 307 });
      const guarded = guardedLoopback();

      await guarded(`http://localhost:${start.port}/start`, {
        headers: { authorization: 'Bearer secret' },
      });

      expect(destination.received[0]?.headers.authorization).toBeUndefined();
    });

    it.each(['proxy-authorization', 'cookie', 'authorization'])(
      'drops %s across origins',
      async (header) => {
        const { start, destination } = await startRedirect({
          status: 307,
          host: '127.0.0.1',
        });
        const guarded = guardedLoopback(allowAnyHost);

        await guarded(`http://localhost:${start.port}/start`, {
          headers: { [header]: 'secret' },
        });

        expect(destination.received[0]?.headers[header]).toBeUndefined();
      },
    );
  });

  describe('a Request input carried across a hop', () => {
    it('keeps its method and headers, less the credentials the hop leaves behind', async () => {
      const { start, destination } = await startRedirect({
        status: 307,
        host: '127.0.0.1',
      });
      const guarded = guardedLoopback(allowAnyHost);

      await guarded(
        new Request(`http://localhost:${start.port}/start`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer secret', 'x-marker': 'kept' },
        }),
      );

      expect(destination.received[0]?.method).toBe('DELETE');
      expect(destination.received[0]?.headers['x-marker']).toBe('kept');
      expect(destination.received[0]?.headers.authorization).toBeUndefined();
    });

    it('is not emptied by an init body of null, which means "not supplied"', async () => {
      const { start, destination } = await startRedirect({ status: 307 });
      const guarded = guardedLoopback();

      await expect(
        guarded(
          new Request(`http://localhost:${start.port}/start`, {
            method: 'POST',
            body: 'payload',
          }),
          { body: null },
        ),
      ).rejects.toThrow(/cannot be sent a second time/u);
      expect(destination.received).toStrictEqual([]);
    });
  });

  describe('bodies that survive a hop', () => {
    it.each([
      { label: 'a string', makeBody: () => 'payload' },
      {
        label: 'URLSearchParams',
        makeBody: () => new URLSearchParams({ a: 'b' }),
      },
      { label: 'a Blob', makeBody: () => new Blob(['payload']) },
      {
        label: 'an ArrayBuffer view',
        makeBody: () => new TextEncoder().encode('payload'),
      },
      {
        label: 'FormData',
        makeBody: () => {
          const form = new FormData();
          form.append('a', 'b');
          return form;
        },
      },
    ])('replays $label across a 307', async ({ makeBody }) => {
      const { start, destination } = await startRedirect({ status: 307 });
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${start.port}/start`, {
        method: 'POST',
        body: makeBody() as NonNullable<RequestInit['body']>,
      });

      expect(await response.text()).toBe('landed');
      expect(destination.received[0]?.method).toBe('POST');
      expect(destination.received[0]?.body).not.toBe('');
    });
  });

  describe('the response of a followed chain', () => {
    it('clones as a redirected response', async () => {
      const { start: first, destination: second } = await startRedirect();
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${first.port}/start`);
      const clone = response.clone();

      expect(clone.redirected).toBe(true);
      expect(clone.url).toBe(`http://localhost:${second.port}/landed`);
      expect(await clone.text()).toBe('landed');
      expect(await response.text()).toBe('landed');
    });

    it('is still a Response, headers and all', async () => {
      const second = await startServer();
      second.respondWith((_request, response) => {
        response.writeHead(201, { 'x-marker': 'final' });
        response.end('landed');
      });
      const first = await startServer();
      first.respondWith(
        redirectTo(302, `http://localhost:${second.port}/landed`),
      );
      const guarded = guardedLoopback();

      const response = await guarded(`http://localhost:${first.port}/start`);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(201);
      expect(response.ok).toBe(true);
      expect(response.headers.get('x-marker')).toBe('final');
      expect(response.bodyUsed).toBe(false);
      expect(await response.text()).toBe('landed');
      expect(response.bodyUsed).toBe(true);
    });

    it('reports redirected through a frozen response, which cannot be written to', async () => {
      const { start: first } = await startRedirect();
      const guarded = makeGuardedFetch({
        // Stands in for the vat `fetch` endowment, which hardens what it
        // returns before the caveat ever sees it.
        baseFetch: async (input, init) =>
          Object.freeze(await fetch(input, init)),
        guard: allowLocalhost,
      });

      const response = await guarded(`http://localhost:${first.port}/start`);

      expect(response.redirected).toBe(true);
      expect(await response.text()).toBe('landed');
    });

    it('stays readable when the response carries redirected as a frozen own value', async () => {
      const { start: first } = await startRedirect();
      const guarded = makeGuardedFetch({
        // A hardened object literal, so `redirected` is a non-configurable own
        // value — the case `asRedirected` must not override.
        baseFetch: async (input, init) => {
          const real = await fetch(input, init);
          return harden({
            status: real.status,
            headers: real.headers,
            redirected: false,
            text: async () => await real.text(),
          }) as unknown as Response;
        },
        guard: allowLocalhost,
      });

      const response = await guarded(`http://localhost:${first.port}/start`);

      // Reported as the target has it. The flag is wrong for the chain that was
      // travelled, which is the price of the response staying readable at all.
      expect(response.redirected).toBe(false);
      expect(await response.text()).toBe('landed');
    });
  });

  describe('an integrity the chain as a whole answers for', () => {
    it.each([
      ['sha256', LANDED_SHA256],
      ['sha512', LANDED_SHA512],
    ])(
      'accepts a %s digest of the resource it ends on',
      async (_algorithm, integrity) => {
        const { start: first, destination: second } = await startRedirect();
        const guarded = guardedLoopback();

        const response = await guarded(`http://localhost:${first.port}/start`, {
          integrity,
        });

        // `fetch` handed the same digest would have compared it to the 302's body
        // and failed. Checked here against the body the chain ended on, which is
        // still there to be read.
        expect(response.url).toBe(`http://localhost:${second.port}/landed`);
        expect(response.bodyUsed).toBe(false);
        expect(await response.text()).toBe('landed');
      },
    );

    it('accepts a digest carried on a Request', async () => {
      const { start: first } = await startRedirect();
      const guarded = guardedLoopback();

      const response = await guarded(
        new Request(`http://localhost:${first.port}/start`, {
          integrity: LANDED_SHA256,
        }),
      );

      expect(await response.text()).toBe('landed');
    });

    it('refuses a digest of a hop rather than of the resource', async () => {
      const { start: first, destination: second } = await startRedirect();
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${first.port}/start`, {
          integrity: REDIRECTING_SHA256,
        }),
      ).rejects.toThrow(
        `Fetch of http://localhost:${second.port}/landed does not match the requested integrity \`${REDIRECTING_SHA256}\`.`,
      );
    });

    it('checks a request that took no redirect at all', async () => {
      const server = await startServer();
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${server.port}/direct`, {
          integrity: REDIRECTING_SHA256,
        }),
      ).rejects.toThrow(/does not match the requested integrity/u);
    });

    it('holds a manual redirect to the digest, as fetch does', async () => {
      const { start: first } = await startRedirect();
      const guarded = guardedLoopback();

      // The caller asked for the 3xx, so the 3xx is the body the digest has to
      // answer for — and a digest of the resource cannot.
      await expect(
        guarded(`http://localhost:${first.port}/start`, {
          integrity: LANDED_SHA256,
          redirect: 'manual',
        }),
      ).rejects.toThrow(/does not match the requested integrity/u);

      const response = await guarded(`http://localhost:${first.port}/start`, {
        integrity: REDIRECTING_SHA256,
        redirect: 'manual',
      });

      expect(response.status).toBe(302);
    });

    it('refuses metadata naming no algorithm it can check, which fetch would ignore', async () => {
      const server = await startServer();
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${server.port}/direct`, {
          integrity: 'md5-1B2M2Y8AsgTpgAmY7PhCfg==',
        }),
      ).rejects.toThrow(/names no hash algorithm a guarded fetch can check/u);
    });

    it('refuses a response with no body to check the digest against', async () => {
      const server = await startServer();
      server.respondWith((_request, response) => {
        response.writeHead(204);
        response.end();
      });
      const guarded = guardedLoopback();

      await expect(
        guarded(`http://localhost:${server.port}/nothing`, {
          integrity: LANDED_SHA256,
        }),
      ).rejects.toThrow(/carries no body to check it against/u);
    });
  });
});
