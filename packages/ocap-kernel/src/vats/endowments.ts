import type { Logger } from '@metamask/logger';
import { buildCommonEndowments } from '@metamask/snaps-execution-environments/endowments';
import type { NotifyFunction } from '@metamask/snaps-execution-environments/endowments';
import {
  enums,
  func,
  object,
  record,
  string,
  unknown,
} from '@metamask/superstruct';

/**
 * The names of host/Web API globals that vats may request as endowments.
 * These are NOT ECMAScript intrinsics and are therefore absent from SES
 * Compartments unless explicitly provided.
 *
 * JS intrinsics (e.g. `ArrayBuffer`, `BigInt`, `Intl`, integer typed arrays)
 * are already available in every Compartment and do not need to be endowed,
 * as are `TextEncoder` and `TextDecoder`, which SES permits universally.
 * Listing any of them here would make it look withholdable, which it is not.
 * `Date` and `Math` are intrinsics too, but lockdown tames them — calling
 * `Date.now()` or `Math.random()` throws in secure mode unless a working
 * replacement is endowed.
 *
 * The `Float16Array`, `Float32Array`, and `Float64Array` constructors are the
 * exception: as of SES 2, they stay on the start compartment but are no longer
 * universal globals, because a shared `ArrayBuffer` view lets code read the bit
 * pattern of a `NaN` and use it as a side channel. Endowing one here would hand
 * that channel back to vats, so they are deliberately absent.
 *
 * NOTE: adding `console` here will pull in a Snaps factory that requires
 * a `sourceLabel` option and will throw when called without it. Integrating
 * that requires adjusting {@link createDefaultEndowments} to pass the
 * option through.
 */
const ALLOWED_GLOBAL_NAMES = [
  // Attenuated timer factories — isolated per vat, with teardown for
  // cancelling pending callbacks on termination.
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',

  // Attenuated `Date` — each read adds up to 1 ms of random jitter and
  // the result is clamped to be monotonic non-decreasing, so precise
  // sub-millisecond timing cannot leak through `Date.now()`.
  'Date',

  // Attenuated `Math` — only `Math.random` differs from the tamed
  // intrinsic: it is replaced with a `crypto.getRandomValues`-sourced
  // implementation. This is NOT a cryptographically secure RNG per the
  // upstream NOTE in `snaps-execution-environments/math.ts` — it exists
  // to avoid timing side channels in the stock RNG, nothing more.
  'Math',

  // Attenuated Web Crypto.
  'crypto',
  'SubtleCrypto',

  // Attenuated network. The Snaps factory wraps `fetch` so teardown can
  // abort in-flight requests and cancel open body streams; `Request`,
  // `Headers`, and `Response` are hardened constructors surfaced alongside
  // it so vat code can build requests/headers before calling `fetch`.
  // Host restriction is applied by `VatSupervisor` per-vat using
  // `makeHostCaveat` — the factory itself accepts no allowlist.
  'fetch',
  'Request',
  'Headers',
  'Response',

  // Plain hardened Web APIs (no attenuation).
  'URL',
  'URLSearchParams',
  'atob',
  'btoa',
  'AbortController',
  'AbortSignal',
] as const;

/**
 * A global name that vats may request as an endowment. Callers that accept
 * this type get typo-checking at compile time, and the {@link AllowedGlobalNameStruct}
 * enforces the same invariant at RPC boundaries.
 */
export type AllowedGlobalName = (typeof ALLOWED_GLOBAL_NAMES)[number];

export const AllowedGlobalNameStruct = enums(ALLOWED_GLOBAL_NAMES);

const ALLOWED_GLOBAL_NAMES_SET: ReadonlySet<string> = new Set(
  ALLOWED_GLOBAL_NAMES,
);

/**
 * The endowments produced for a single vat.
 *
 * - `globals`: a hardened record of endowments keyed by global name. Safe to
 *   spread into a Compartment's initial bindings.
 * - `teardown`: releases resources held by stateful factories (e.g. pending
 *   timers, open network connections). Callable multiple times — the factory
 *   contract (per `EndowmentFactoryResult` in `snaps-execution-environments`)
 *   requires teardown to leave endowments reusable rather than broken, so
 *   repeated invocations are safe even though individual factories may
 *   perform no-op work after the first call.
 */
export type VatEndowments = {
  globals: Record<string, unknown>;
  teardown: () => Promise<void>;
};

/**
 * Shape-only validator used to guard the `VatSupervisor` boundary against
 * custom `MakeAllowedGlobals` factories returning malformed values. It checks
 * that `globals` is a record and `teardown` is a function; it does not and
 * cannot verify that `teardown` returns a promise.
 *
 * The `globals` key is validated as `string` rather than {@link AllowedGlobalNameStruct}
 * so factories may surface extras from upstream sources (e.g., Snaps'
 * `buildCommonEndowments`) without tripping the assertion. Extras are dropped
 * when a vat's config is resolved — only names in {@link ALLOWED_GLOBAL_NAMES}
 * can actually be requested.
 */
export const VatEndowmentsStruct = object({
  globals: record(string(), unknown()),
  teardown: func(),
});

/**
 * Options consumed by {@link MakeAllowedGlobals} factories.
 */
export type MakeAllowedGlobalsOptions = {
  /**
   * Logger used by stateful endowments for observability — e.g. the network
   * factory emits `OutboundRequest`/`OutboundResponse` notifications through
   * it at debug level. Sub-scope with `subLogger` beforehand if caller wants
   * a dedicated tag.
   */
  logger: Logger;
};

/**
 * Factory that produces a fresh {@link VatEndowments} for a single vat.
 * Consumers supply this to a `VatSupervisor` to override the default
 * endowment set (see {@link createDefaultEndowments}).
 */
export type MakeAllowedGlobals = (
  options: MakeAllowedGlobalsOptions,
) => VatEndowments;

/**
 * Build a `notify` callback for the Snaps network factory that routes
 * outbound request/response lifecycle events to the vat logger at debug
 * level.
 *
 * The callback is awaited inside the factory's fetch implementation, so a
 * throw here would propagate into the vat's `fetch` call. The try/catch is
 * defensive: the logger's own methods don't throw today, but we don't want
 * an accidental transport failure to turn into a vat-visible fetch error.
 * When the logger does fail, surface it via `console.error` so the outage
 * is visible — silent swallow would hide a broken audit trail.
 *
 * @param logger - The logger to route notifications through.
 * @returns A notify callback suitable for the Snaps network factory.
 */
const makeLoggerNotify = (logger: Logger): NotifyFunction => {
  return async ({ method, params }) => {
    try {
      logger.debug(`network:${method}`, params);
    } catch (error) {
      try {
        // eslint-disable-next-line no-console
        console.error(
          '[ocap-kernel] network endowment logger transport failed',
          error,
        );
      } catch {
        // fetch must not break on a broken host console either
      }
    }
  };
};

/**
 * Build a fresh set of vat endowments from the Snaps attenuated factories,
 * filtered to the names in {@link ALLOWED_GLOBAL_NAMES}. Each call produces
 * an isolated instance — timers, network state, and other stateful
 * endowments are not shared across vats, so one vat cannot clear another
 * vat's timers or abort another vat's in-flight fetches.
 *
 * Snaps' `buildCommonEndowments()` also ships `console`, `WebAssembly`,
 * typed arrays, `Intl`, etc. Those are either SES intrinsics already present
 * in every Compartment (so endowing is redundant) or deliberately withheld
 * from vats.
 *
 * The `fetch` produced here is NOT host-restricted. `VatSupervisor` wraps
 * it with a `makeHostCaveat` before handing it to a Compartment, reading
 * the allowlist from the vat's own `VatConfig.network.allowedHosts`.
 *
 * The aggregate `teardown` uses `Promise.allSettled` so one failing factory
 * does not silently mask failures in others; all rejections are surfaced as
 * an {@link AggregateError}.
 *
 * @param options - Factory options; see {@link MakeAllowedGlobalsOptions}.
 * @param options.logger - The logger to route notifications through.
 * @returns The endowment globals and an aggregate teardown function.
 */
export function createDefaultEndowments({
  logger,
}: MakeAllowedGlobalsOptions): VatEndowments {
  const notify = makeLoggerNotify(logger);
  const globals: Record<string, unknown> = {};
  const teardowns: (() => Promise<void> | void)[] = [];

  for (const { names, factory } of buildCommonEndowments()) {
    if (!names.some((name) => ALLOWED_GLOBAL_NAMES_SET.has(name))) {
      continue;
    }
    let result;
    try {
      result = factory({ notify });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to construct endowment factory for [${names.join(', ')}]: ${cause}`,
        { cause: error },
      );
    }
    const { teardownFunction, ...values } = result;
    for (const [key, value] of Object.entries(values)) {
      if (ALLOWED_GLOBAL_NAMES_SET.has(key)) {
        globals[key] = value;
      }
    }
    if (teardownFunction) {
      teardowns.push(teardownFunction);
    }
  }

  return harden({
    globals,
    teardown: async () => {
      const results = await Promise.allSettled(
        teardowns.map(async (fn) => fn()),
      );
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        )
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `One or more endowment teardowns failed (${failures.length}/${teardowns.length})`,
        );
      }
    },
  });
}
