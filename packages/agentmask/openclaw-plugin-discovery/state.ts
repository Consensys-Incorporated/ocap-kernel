/**
 * Plugin state for the discovery plugin.
 *
 * Tracks three kinds of things the LLM agent accumulates over a session:
 *
 *   - the matcher's ocap URL + kref (once redeemed),
 *   - a map of contact endpoints the agent has redeemed (by URL → kref),
 *   - a map of service points the agent has obtained via `initiateContact`.
 *
 * The plugin also supports a "nickname" for contact endpoints and services
 * — typically derived from the service's alleged type tag — so the LLM
 * can refer to them by name rather than by kref.
 */

import type { DaemonCaller } from './daemon.ts';

export type MatcherEntry = {
  url: string;
  kref: string;
};

export type ContactEntry = {
  /**
   * The contact URL, if known. `undefined` for a contact passed via
   * another path (not used in Phase 3 but reserved).
   */
  url?: string;
  /** Kernel reference for the redeemed contact endpoint. */
  kref: string;
  /** Human-readable nickname the agent can use in place of the kref. */
  nickname: string;
};

export type ServiceEntry = {
  /** Kernel reference for the service endpoint. */
  kref: string;
  /** Nickname — typically the alleged type tag. */
  nickname: string;
  /** Nickname or URL of the contact endpoint this service was obtained from. */
  fromContact: string;
};

/**
 * 3-state representation of the matcher connection. Modeled as a
 * discriminated union so the type system rules out the contradictory
 * state where both a resolved entry and a still-pending pre-redemption
 * are observable at once. The `e359bf49b` fix ("await pre-redemption
 * before reporting no matcher") was exactly about racing on those two
 * fields, so the discriminator is load-bearing.
 */
export type MatcherSlot =
  | { status: 'absent' }
  | { status: 'pending'; promise: Promise<MatcherEntry> }
  | { status: 'resolved'; entry: MatcherEntry };

export type PluginState = {
  matcher: MatcherSlot;
  contacts: Map<string, ContactEntry>;
  services: Map<string, ServiceEntry>;
};

/**
 * Create a fresh plugin state.
 *
 * @returns A new plugin state.
 */
export function createState(): PluginState {
  return {
    matcher: { status: 'absent' },
    contacts: new Map(),
    services: new Map(),
  };
}

const KREF_PATTERN = /^ko\d+$/u;

/**
 * Check if a string looks like a kref (e.g. "ko5").
 *
 * @param value - The string to check.
 * @returns True if it matches the kref pattern.
 */
export function isKref(value: string): boolean {
  return KREF_PATTERN.test(value);
}

/**
 * Extract a kref and alleged name from a prettified slot reference
 * returned by `queueMessage`.
 *
 * Expected shapes:
 *
 * - string like `"<ko5> (Alleged: Foo)"`
 * - CapData-ish object with `body` + `slots`
 *
 * @param value - The value to inspect.
 * @returns The extracted kref and alleged name, or `undefined` if nothing
 * matched.
 */
export function extractKref(value: unknown):
  | {
      kref: string;
      alleged?: string | undefined;
    }
  | undefined {
  if (typeof value === 'string') {
    const match = /<(ko\d+)>(?:\s*\(Alleged:\s*([^)]+)\))?/u.exec(value);
    if (match?.[1]) {
      return { kref: match[1], alleged: match[2]?.trim() };
    }
    if (isKref(value)) {
      return { kref: value };
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as { body?: unknown; slots?: unknown };
    if (typeof obj.body === 'string' && Array.isArray(obj.slots)) {
      const [kref] = obj.slots as unknown[];
      if (typeof kref === 'string' && isKref(kref)) {
        const nameMatch = /Alleged:\s*([^"]+)/u.exec(obj.body);
        return { kref, alleged: nameMatch?.[1]?.trim() };
      }
    }
  }
  return undefined;
}

/**
 * Unique-ify a nickname by suffixing `-2`, `-3`, etc. if the base name is
 * already in use.
 *
 * @param base - The preferred nickname.
 * @param inUse - Set of nicknames already allocated.
 * @returns A nickname that is not in `inUse`.
 */
export function uniqueNickname(base: string, inUse: Set<string>): string {
  if (!inUse.has(base)) {
    return base;
  }
  let i = 2;
  while (inUse.has(`${base}-${i}`)) {
    i += 1;
  }
  return `${base}-${i}`;
}

/**
 * Ensure a matcher has been redeemed; otherwise throw with instructions
 * for the agent. If a pre-configured matcher URL is mid-redemption, wait
 * for it to settle before deciding.
 *
 * @param state - The plugin state.
 * @returns The matcher kref.
 */
export async function requireMatcher(state: PluginState): Promise<string> {
  switch (state.matcher.status) {
    case 'resolved':
      return state.matcher.entry.kref;
    case 'pending':
      try {
        const entry = await state.matcher.promise;
        return entry.kref;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Pre-configured matcher URL failed to redeem: ${detail}. ` +
            'Ask the user for a valid matcher OCAP URL and call ' +
            '`discovery_redeem_matcher`.',
        );
      }
    case 'absent':
      throw new Error(
        'No matcher connection. Ask the user for the matcher OCAP URL and ' +
          'call `discovery_redeem_matcher` first.',
      );
    default: {
      const exhaustiveCheck: never = state.matcher;
      throw new Error(`unreachable: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Resolve a contact reference (URL, kref, or nickname) to a contact entry,
 * redeeming the URL via the daemon if necessary.
 *
 * @param options - Resolution options.
 * @param options.ref - The reference to resolve.
 * @param options.state - The plugin state.
 * @param options.daemon - The daemon caller.
 * @returns The resolved ContactEntry.
 */
export async function resolveContact(options: {
  ref: string;
  state: PluginState;
  daemon: DaemonCaller;
}): Promise<ContactEntry> {
  const { ref, state, daemon } = options;
  // If ref is a known nickname or URL, use the cached entry.
  const existing =
    state.contacts.get(ref) ??
    [...state.contacts.values()].find((entry) => entry.url === ref);
  if (existing) {
    return existing;
  }
  // If it's already a kref, wrap it so subsequent calls work.
  if (isKref(ref)) {
    const nickname = uniqueNickname(ref, new Set(state.contacts.keys()));
    const entry: ContactEntry = { kref: ref, nickname };
    state.contacts.set(nickname, entry);
    return entry;
  }
  // Otherwise treat ref as an OCAP URL to redeem.
  const kref = await daemon.redeemUrl(ref);
  const nickname = uniqueNickname(
    `contact:${kref}`,
    new Set(state.contacts.keys()),
  );
  const entry: ContactEntry = { url: ref, kref, nickname };
  state.contacts.set(nickname, entry);
  return entry;
}

/**
 * Resolve a service reference (nickname or kref) to a service entry.
 *
 * @param ref - Nickname or kref.
 * @param state - The plugin state.
 * @returns The ServiceEntry.
 */
export function resolveService(ref: string, state: PluginState): ServiceEntry {
  const byNickname = state.services.get(ref);
  if (byNickname) {
    return byNickname;
  }
  if (isKref(ref)) {
    const byKref = [...state.services.values()].find(
      (entry) => entry.kref === ref,
    );
    if (byKref) {
      return byKref;
    }
  }
  const available = [...state.services.keys()];
  const hint =
    available.length > 0
      ? ` Available: ${available.join(', ')}.`
      : ' No services obtained yet. Use `service_initiate_contact` first.';
  throw new Error(`Unknown service "${ref}".${hint}`);
}
