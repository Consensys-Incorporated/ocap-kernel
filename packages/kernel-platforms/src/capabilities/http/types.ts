import type { Guarded } from '@endo/exo';
import {
  array,
  boolean,
  enums,
  exactOptional,
  integer,
  nonempty,
  object,
  pattern,
  size,
  string,
} from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';

// A host name's labels, most significant first, as in `['com', 'example',
// 'api']` for `api.example.com`. Reversed so that a domain is a prefix of its
// subdomains, which is what lets `pathUnder` scope a capability to one.
export type HostSegments = string[];

// Unencoded; each segment is percent-encoded on its own.
export type PathSegments = string[];

export type HttpProtocol = 'http' | 'https';

export type HttpOptions = {
  protocol?: HttpProtocol;
  port?: number;
  query?: [string, string][];
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HttpResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

export const httpMethodNames = ['request'] as const;

export type HttpMethodName = (typeof httpMethodNames)[number];

// A rule's constraints all hold at once; a config admits a request any one of
// its rules admits.
export const httpRuleStruct = object({
  // As in `example.com`. Admits its subdomains too unless `exactHost`.
  host: nonempty(string()),
  exactHost: exactOptional(boolean()),
  // As in `v1/users`. Admits the paths below it too unless `exactPath`, which
  // also tells `v1/` from `v1`. Any path when absent.
  path: exactOptional(string()),
  exactPath: exactOptional(boolean()),
  // Either when absent. A request that names none is sent over `https`.
  protocol: exactOptional(enums(['http', 'https'])),
  // The ports a request may name. A request that names none uses its scheme's
  // default, which every rule admits, so `[]` admits default ports only. Any
  // port when absent.
  ports: exactOptional(array(size(integer(), 1, 65535))),
  // Uppercase, as in `GET`. A request that names none is a `GET`. Any method
  // when absent.
  methods: exactOptional(nonempty(array(pattern(string(), /^[A-Z]+$/u)))),
});

export type HttpRule = Infer<typeof httpRuleStruct>;

export const httpConfigStruct = object({
  allow: nonempty(array(httpRuleStruct)),
});

// Aliased so that declaration emit has a name for it; the structural type
// resolves into a hoisted `@metamask/superstruct` and is not portable.
export type HttpConfigStruct = typeof httpConfigStruct;

export type HttpConfig = Infer<typeof httpConfigStruct>;

export type HttpMethods = {
  request: (
    host: HostSegments,
    path: PathSegments,
    options: HttpOptions,
  ) => Promise<HttpResponse>;
};

export type HttpCapability = Guarded<Partial<HttpMethods>>;
