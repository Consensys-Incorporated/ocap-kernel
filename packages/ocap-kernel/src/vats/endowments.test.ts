import { Logger } from '@metamask/logger';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { createDefaultEndowments } from './endowments.ts';

type CommonEndowments =
  typeof import('@metamask/snaps-execution-environments/endowments');

const state: {
  override: ReturnType<CommonEndowments['buildCommonEndowments']> | null;
} = {
  override: null,
};

vi.mock('@metamask/snaps-execution-environments/endowments', async () => {
  const actual = await vi.importActual<CommonEndowments>(
    '@metamask/snaps-execution-environments/endowments',
  );
  return {
    ...actual,
    buildCommonEndowments: () =>
      state.override ?? actual.buildCommonEndowments(),
  };
});

const makeLogger = (): Logger => new Logger('test');

describe('createDefaultEndowments', () => {
  // Ordering constraint: tests that pass a `vi.fn()` callback to the real
  // `setTimeout` endowment must run LAST. Snaps' timeout factory calls
  // `harden(handler)` on the callback, which freezes the mock's internals;
  // vitest's between-test mock reset then fails to write `.calls` on the
  // frozen mock, and the resulting error surfaces on the NEXT test.
  afterEach(() => {
    state.override = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('produces the expected global names', () => {
    const { globals } = createDefaultEndowments({ logger: makeLogger() });
    expect(Object.keys(globals).sort()).toStrictEqual([
      'AbortController',
      'AbortSignal',
      'Date',
      'Headers',
      'Math',
      'Request',
      'Response',
      'SubtleCrypto',
      'URL',
      'URLSearchParams',
      'atob',
      'btoa',
      'clearInterval',
      'clearTimeout',
      'crypto',
      'fetch',
      'setInterval',
      'setTimeout',
    ]);
  });

  it('does not leak teardownFunction into globals', () => {
    const { globals } = createDefaultEndowments({ logger: makeLogger() });
    expect(Object.keys(globals)).not.toContain('teardownFunction');
  });

  it('freezes both the result and the globals record', () => {
    const result = createDefaultEndowments({ logger: makeLogger() });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.globals)).toBe(true);
  });

  it('returns isolated instances per call', () => {
    const first = createDefaultEndowments({ logger: makeLogger() });
    const second = createDefaultEndowments({ logger: makeLogger() });
    expect(first).not.toBe(second);
    expect(first.globals.setTimeout).not.toBe(second.globals.setTimeout);
  });

  it('teardown resolves without error when no resources are held', async () => {
    const { teardown } = createDefaultEndowments({ logger: makeLogger() });
    expect(await teardown()).toBeUndefined();
  });

  it('teardown aggregates multiple factory failures into an AggregateError', async () => {
    const errorA = new Error('factory A teardown failed');
    const errorB = new Error('factory B teardown failed');
    state.override = [
      {
        names: ['setTimeout'],
        factory: () => ({
          setTimeout: () => undefined,
          teardownFunction: () => {
            throw errorA;
          },
        }),
      },
      {
        names: ['setInterval'],
        factory: () => ({
          setInterval: () => undefined,
          teardownFunction: () => {
            throw errorB;
          },
        }),
      },
    ] as unknown as typeof state.override;

    const { teardown } = createDefaultEndowments({ logger: makeLogger() });

    let caught: unknown;
    try {
      await teardown();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toStrictEqual([errorA, errorB]);
    expect((caught as AggregateError).message).toMatch(/\(2\/2\)/u);
  });

  it('rethrows factory construction errors with the factory names in context', () => {
    state.override = [
      {
        names: ['setTimeout', 'clearTimeout'],
        factory: () => {
          throw new Error('sourceLabel is required');
        },
      },
    ] as unknown as typeof state.override;

    expect(() => createDefaultEndowments({ logger: makeLogger() })).toThrow(
      /Failed to construct endowment factory for \[setTimeout, clearTimeout\]/u,
    );
  });

  it('passes a working notify callback to the network factory', () => {
    const notifyCalls: unknown[] = [];
    state.override = [
      {
        names: ['fetch'],
        factory: (options?: {
          notify?: (notification: unknown) => unknown;
        }) => {
          notifyCalls.push(options?.notify);
          return { fetch: () => undefined };
        },
      },
    ] as unknown as typeof state.override;

    createDefaultEndowments({ logger: makeLogger() });
    expect(typeof notifyCalls[0]).toBe('function');
  });

  it('routes notify calls through the logger at debug level', async () => {
    const logger = makeLogger();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {
      // silence test output
    });
    let capturedNotify:
      | ((n: { method: string; params: unknown }) => Promise<void>)
      | undefined;

    state.override = [
      {
        names: ['fetch'],
        factory: (options?: {
          notify?: (n: { method: string; params: unknown }) => Promise<void>;
        }) => {
          capturedNotify = options?.notify;
          return { fetch: () => undefined };
        },
      },
    ] as unknown as typeof state.override;

    createDefaultEndowments({ logger });
    await capturedNotify?.({
      method: 'OutboundRequest',
      params: { source: 'fetch' },
    });

    expect(debugSpy).toHaveBeenCalledWith('network:OutboundRequest', {
      source: 'fetch',
    });
  });

  it('swallows logger errors inside notify and surfaces them via console.error', async () => {
    const logger = makeLogger();
    const transportError = new Error('transport broke');
    vi.spyOn(logger, 'debug').mockImplementation(() => {
      throw transportError;
    });
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    let capturedNotify:
      | ((n: { method: string; params: unknown }) => Promise<void>)
      | undefined;

    state.override = [
      {
        names: ['fetch'],
        factory: (options?: {
          notify?: (n: { method: string; params: unknown }) => Promise<void>;
        }) => {
          capturedNotify = options?.notify;
          return { fetch: () => undefined };
        },
      },
    ] as unknown as typeof state.override;

    createDefaultEndowments({ logger });
    expect(
      await capturedNotify?.({
        method: 'OutboundRequest',
        params: { source: 'fetch' },
      }),
    ).toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[ocap-kernel] network endowment logger transport failed',
      transportError,
    );
  });

  it('teardown aborts in-flight fetches started by the network factory', async () => {
    // Stub globalThis.fetch with a never-resolving promise that respects
    // AbortSignal. The Snaps factory's `withTeardown` helper drops — rather
    // than rejects — the vat-visible fetch promise once teardown runs, so
    // the meaningful assertions are (1) the abort signal propagated into
    // the base fetch and (2) teardown returns cleanly without hanging on
    // the open connection. `vi.stubGlobal` + `unstubAllGlobals` in afterEach
    // keeps the global mutation scoped to this test.
    let abortReceived = false;
    vi.stubGlobal(
      'fetch',
      (async (_input: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortReceived = true;
            reject(new Error('aborted'));
          });
        })) as typeof fetch,
    );

    const { globals, teardown } = createDefaultEndowments({
      logger: makeLogger(),
    });
    const fetchFn = globals.fetch as typeof fetch;

    const inFlight = fetchFn('https://example.test/slow');
    // Suppress unhandled-rejection noise — the Snaps factory drops this
    // promise on teardown (neither resolves nor rejects it).
    inFlight.catch(() => undefined);

    // Give the factory a microtask to register the open connection.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await teardown();

    expect(abortReceived).toBe(true);
  });

  it('teardown cancels pending timers', async () => {
    // SES lockdown freezes Date, preventing vi.useFakeTimers(); use a real
    // delay that exceeds the factory's 10ms MINIMUM_TIMEOUT.
    const { globals, teardown } = createDefaultEndowments({
      logger: makeLogger(),
    });
    const setTimeoutFn = globals.setTimeout as typeof globalThis.setTimeout;
    const callback = vi.fn();
    setTimeoutFn(callback, 10);
    await teardown();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callback).not.toHaveBeenCalled();
  });
});
