import type { Guarded } from '@endo/exo';
import { array, nonempty, object, string } from '@metamask/superstruct';
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

// Hostnames, as in `['example.com']`; each admits its subdomains too.
export const httpConfigStruct = object({
  hosts: nonempty(array(nonempty(string()))),
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
