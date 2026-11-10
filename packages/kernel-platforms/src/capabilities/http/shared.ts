import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import type { MethodGuard, Pattern } from '@endo/patterns';
import { join, narrow, pathUnder } from '@metamask/kernel-utils';
import type { NarrowingDelta } from '@metamask/kernel-utils';

import type {
  HttpCapability,
  HttpConfig,
  HttpMethodName,
  HttpMethods,
  HttpOptions,
  HttpResponse,
  HttpRule,
  HostSegments,
  PathSegments,
} from './types.ts';
import { httpConfigStruct } from './types.ts';
import { makeCapabilitySpecification } from '../../specification.ts';
import type { CapabilitySpecification } from '../../specification.ts';

// The guard can only require strings, so `['com', 'example.evil']` satisfies
// `pathUnder(['com', 'example'])`. One lowercase label per segment is what
// makes a prefix check sufficient. Lowercase because host names compare
// case-insensitively and patterns do not.
const plainLabel = /^[a-z0-9_-]+$/u;

/**
 * Asserts that every segment is exactly one lowercase host label.
 *
 * @param host - The labels to check, most significant first
 * @param label - What is being checked, for the error message
 */
export const assertPlainLabels = (host: HostSegments, label: string): void => {
  if (host.length === 0) {
    throw new Error(`${label} names no host`);
  }
  const bad = host.find((segment) => !plainLabel.test(segment));
  if (bad !== undefined) {
    throw new Error(
      `${label} contains an invalid label: ${JSON.stringify(bad)}`,
    );
  }
};

/**
 * Percent-encode a path segment, leaving the characters RFC 3986 allows in
 * one as they are, so that a URL a caller signed is sent as signed.
 *
 * @param segment - The segment, unencoded
 * @returns The encoded segment
 */
const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(
    /%(?:21|24|26|27|28|29|2A|2B|2C|3A|3B|3D|40)/gu,
    (encoded) => decodeURIComponent(encoded),
  );

/**
 * Turn a configured hostname into the labels a request names it by.
 *
 * @param hostname - The hostname, as in `api.example.com`
 * @returns Its labels, most significant first
 */
export const toHostLabels = (hostname: string): HostSegments => {
  if (hostname.includes(':')) {
    throw new Error(
      `allowed host ${hostname} names a port; name the host alone`,
    );
  }
  const labels = hostname.toLowerCase().split('.').reverse();
  assertPlainLabels(labels, 'allowed host');
  return labels;
};

/**
 * Build the URL a request addresses, refusing any that does not round-trip.
 *
 * Plain labels can still spell a host the URL parser rewrites: `['1', '0x7f']`
 * parses as `127.0.0.1`. Requiring the parsed host to equal the joined labels
 * means the host a pattern approved is the host requested.
 *
 * @param options - The URL's parts
 * @param options.host - The host's labels, most significant first
 * @param options.path - The path's segments, unencoded
 * @param options.protocol - The scheme
 * @param options.port - The port, if not the scheme's default
 * @param options.query - The query's name-value pairs
 * @returns The URL to request
 */
export const toUrl = ({
  host,
  path,
  protocol = 'https',
  port,
  query,
}: { host: HostSegments; path: PathSegments } & HttpOptions): URL => {
  assertPlainLabels(host, 'host');
  const hostname = [...host].reverse().join('.');
  const url = new URL(`${protocol}://${hostname}`);
  if (url.hostname !== hostname) {
    throw new Error(`host ${hostname} parses as ${url.hostname}`);
  }
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid port: ${port}`);
    }
    url.port = String(port);
  }
  // `.` and `..` survive encoding and the parser would resolve them away. A
  // separator would survive as `%2F`, which a server that decodes it before
  // routing reads as a split, so a path prefix would bound nothing.
  const badSegment = path.find(
    (segment) =>
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\'),
  );
  if (badSegment !== undefined) {
    throw new Error(
      `path contains an invalid segment: ${JSON.stringify(badSegment)}`,
    );
  }
  url.pathname = `/${path.map(encodeSegment).join('/')}`;
  if (query !== undefined) {
    url.search = new URLSearchParams(query).toString();
  }
  return url;
};

/**
 * Decode a path segment, as a `TypeError` if it is malformed.
 *
 * @param segment - The segment, percent-encoded
 * @returns The segment, decoded
 */
const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new TypeError(`malformed path segment ${segment}`);
  }
};

/**
 * Split a URL into the parts a request names it by; the inverse of
 * {@link toUrl}.
 *
 * @param url - The URL
 * @returns The host's labels, the path's segments, and the options that
 * locate it
 */
export const fromUrl = (
  url: URL,
): {
  host: HostSegments;
  path: PathSegments;
  options: Pick<HttpOptions, 'protocol' | 'port' | 'query'>;
} => {
  const protocol = url.protocol.slice(0, -1);
  if (protocol !== 'http' && protocol !== 'https') {
    throw new TypeError(`unsupported protocol ${url.protocol}`);
  }
  // Labels cannot spell an IPv6 literal.
  if (url.hostname.startsWith('[')) {
    throw new TypeError(`IPv6 hosts are unsupported: ${url.hostname}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('credentials in the URL are unsupported');
  }
  const query = [...url.searchParams.entries()];
  return {
    host: url.hostname.split('.').reverse(),
    // The root is no segments, as a rule's path compiles it; a trailing slash
    // elsewhere is a final empty segment.
    path:
      url.pathname === '/'
        ? []
        : url.pathname.slice(1).split('/').map(decodeSegment),
    options: {
      protocol,
      ...(url.port !== '' && { port: Number(url.port) }),
      ...(query.length > 0 && { query }),
    },
  };
};

/**
 * Collect headers into a record, joining repeated names the way `Headers.get`
 * does.
 *
 * @param headers - The headers
 * @returns The headers by lowercase name
 */
export const toHeaderRecord = (headers: Headers): Record<string, string> => {
  // A `Map` rather than assignment, which a header named `__proto__` would
  // turn into a prototype change.
  const joined = new Map<string, string>();
  headers.forEach((value, name) => {
    const previous = joined.get(name);
    joined.set(name, previous === undefined ? value : `${previous}, ${value}`);
  });
  return Object.fromEntries(joined);
};

/**
 * Wraps a `fetch` as the base's `request` operation.
 *
 * Redirects are returned rather than followed: a narrowing is visible only at
 * the call, so a hop the base followed would be checked against no holder's
 * bound. A holder re-requests the `location` through its own capability.
 *
 * @param baseFetch - The `fetch` to make requests with
 * @returns The request operation
 */
export const makeRequest = (baseFetch: typeof fetch): HttpMethods['request'] =>
  harden(
    async (
      host: HostSegments,
      path: PathSegments,
      options: HttpOptions,
    ): Promise<HttpResponse> => {
      const { method, headers, body } = options;
      let url: URL;
      try {
        url = toUrl({ host, path, ...options });
        // On a shared address, `host` picks which site answers.
        if (
          headers &&
          Object.keys(headers).some((name) => name.toLowerCase() === 'host')
        ) {
          throw new Error('the host header cannot be set');
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`http.request: ${message}`, { cause });
      }
      const response = await baseFetch(url.href, {
        ...(method !== undefined && { method }),
        ...(headers !== undefined && { headers }),
        ...(body !== undefined && { body }),
        redirect: 'manual',
      });
      // A browser answers a manual redirect with an opaque response that hides
      // the `location` a holder would need to re-request.
      if (response.type === 'opaqueredirect') {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `http.request: ${url.href} was redirected, but this runtime hides the target of a manual redirect`,
        );
      }
      // Every request asks for `manual`, so this chain was walked below the
      // capability, which never saw where it went.
      if (response.redirected) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `http.request: ${url.href} followed a redirect below the capability`,
        );
      }
      return harden({
        status: response.status,
        statusText: response.statusText,
        headers: toHeaderRecord(response.headers),
        body: await response.text(),
      });
    },
  );

/**
 * Turn a configured path into the segments a request names it by.
 *
 * @param path - The path, as in `v1/users`; a leading slash is ignored
 * @returns Its segments, a trailing slash as a final empty one
 */
export const toPathSegments = (path: string): PathSegments => {
  const trimmed = path.replace(/^\/+/u, '');
  if (trimmed === '') {
    return [];
  }
  const segments = trimmed.split('/');
  const bad = segments.find(
    (segment, index) =>
      (segment === '' && index < segments.length - 1) ||
      segment === '.' ||
      segment === '..',
  );
  if (bad !== undefined) {
    throw new Error(
      `path ${path} contains an invalid segment: ${JSON.stringify(bad)}`,
    );
  }
  return segments;
};

/**
 * Compile a rule's protocol, ports and methods into a pattern on a request's
 * options, or `undefined` if it constrains none of them.
 *
 * A request that leaves one out gets its default (`https`, the scheme's port,
 * `GET`), so leaving one out is admitted exactly when the default is.
 *
 * @param rule - The rule
 * @param rule.protocol - The protocol it requires, if any
 * @param rule.ports - The ports a request may name, if constrained
 * @param rule.methods - The methods a request may use, if constrained
 * @returns The pattern, if any
 */
const compileOptionsPattern = ({
  protocol,
  ports,
  methods,
}: HttpRule): Pattern | undefined => {
  const required: Record<string, Pattern> = {};
  const optional: Record<string, Pattern> = {};
  if (protocol === 'https') {
    optional.protocol = 'https';
  } else if (protocol === 'http') {
    required.protocol = 'http';
  }
  if (ports !== undefined) {
    optional.port = ports.length > 0 ? M.or(...ports) : M.not(M.any());
  }
  if (methods !== undefined) {
    (methods.includes('GET') ? optional : required).method = M.or(...methods);
  }
  if (Object.keys(required).length + Object.keys(optional).length === 0) {
    return undefined;
  }
  return M.splitRecord(required, optional, M.any());
};

/**
 * Compile http config into one narrowing delta per rule. The capability admits
 * a request that any of them admits.
 *
 * @param config - The capability's configuration
 * @param config.allow - The rules a request may satisfy
 * @returns The deltas to narrow the full http exo by, one per rule
 */
export const compileHttpDeltas = ({ allow }: HttpConfig): NarrowingDelta[] =>
  allow.map((rule) => {
    const host = toHostLabels(rule.host);
    let pathPattern: Pattern | undefined;
    if (rule.path !== undefined) {
      const path = toPathSegments(rule.path);
      // A prefix's trailing slash would admit only paths with an empty segment
      // after it, so a prefix ignores it.
      pathPattern = rule.exactPath
        ? harden(path)
        : pathUnder(path.at(-1) === '' ? path.slice(0, -1) : path);
    }
    return {
      request: [
        rule.exactHost ? harden(host) : pathUnder(host),
        pathPattern,
        compileOptionsPattern(rule),
      ],
    };
  });

const httpOptionsShape = M.splitRecord(
  {},
  {
    protocol: M.or('http', 'https'),
    port: M.number(),
    query: M.arrayOf([M.string(), M.string()]),
    method: M.string(),
    headers: M.recordOf(M.string(), M.string()),
    body: M.string(),
  },
);

const httpResponseShape = M.splitRecord({
  status: M.number(),
  statusText: M.string(),
  headers: M.recordOf(M.string(), M.string()),
  body: M.string(),
});

// The options are required rather than optional so that a narrowing of them
// cannot be skipped by omitting them, which would request the defaults.
const httpMethodGuards: Record<HttpMethodName, MethodGuard> = harden({
  request: M.callWhen(
    M.arrayOf(M.string()),
    M.arrayOf(M.string()),
    httpOptionsShape,
  ).returns(httpResponseShape),
});

export type HttpPlatformOptions = {
  makeBaseFetch: () => typeof fetch;
};

export type HttpCapabilityOptions = {
  // A host supplies its own, e.g. one it can abort when a vat terminates.
  fetch?: typeof fetch;
};

/**
 * Build the unrestricted http exo that every configured capability narrows.
 *
 * Not exported from the package: a holder of this can reach any host.
 *
 * @param baseFetch - The `fetch` to make requests with
 * @returns The full http exo
 */
export const makeHttpBase = (baseFetch: typeof fetch): HttpCapability =>
  makeExo('HttpBase', M.interface('HttpBase', httpMethodGuards), {
    request: makeRequest(baseFetch),
  });

/**
 * Build the capability factory that narrows a fresh base by a config.
 *
 * @param platform - The platform's operations
 * @returns A factory taking config to the narrowed capability
 */
const makeNarrowingFactory =
  (platform: HttpPlatformOptions) =>
  async (
    config: HttpConfig,
    options?: HttpCapabilityOptions,
  ): Promise<HttpCapability> => {
    const deltas = compileHttpDeltas(config);
    const base = makeHttpBase(options?.fetch ?? platform.makeBaseFetch());
    // One narrowing per rule, joined, so each rule's host goes with its own
    // path rather than with every rule's.
    const narrowings = await Promise.all(
      deltas.map(async (delta) =>
        narrow<Partial<HttpMethods>>({ name: 'Http', base, delta }),
      ),
    );
    return narrowings.length === 1
      ? (narrowings[0] as HttpCapability)
      : join<Partial<HttpMethods>>({ name: 'Http', refs: narrowings });
  };

export type HttpSpecification = CapabilitySpecification<
  typeof httpConfigStruct,
  Promise<HttpCapability>,
  HttpCapabilityOptions
>;

/**
 * Cross-platform http capability specification factory
 *
 * @param options - The platform's operations
 * @returns The capability specification
 */
export const makeHttpSpecification = (
  options: HttpPlatformOptions,
): HttpSpecification =>
  makeCapabilitySpecification(httpConfigStruct, makeNarrowingFactory(options));
