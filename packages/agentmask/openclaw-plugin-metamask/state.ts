/**
 * Plugin state management for the MetaMask capability vendor plugin.
 *
 * Tracks the vendor kref (obtained by redeeming the OCAP URL) and
 * a map of named capabilities obtained from the vendor.
 */
import type { DaemonCaller } from './daemon.ts';

/**
 * Schema describing a single method on a capability.
 * Mirrors `MethodSchema` from `@metamask/kernel-utils`.
 */
export type MethodSchema = {
  description: string;
  args: Record<string, { type: string; description?: string }>;
  returns?: { type: string; description?: string };
};

export type CapEntry = {
  kref: string;
  name: string;
  description: string;
  methods: Record<string, MethodSchema> | undefined;
};

export type PluginState = {
  ocapUrl: string;
  vendorKref: string | undefined;
  capabilities: Map<string, CapEntry>;
};

/**
 * Create a fresh plugin state.
 *
 * @param ocapUrl - Initial OCAP URL from config/env (may be empty).
 * @returns A new plugin state.
 */
export function createState(ocapUrl = ''): PluginState {
  return {
    ocapUrl,
    vendorKref: undefined,
    capabilities: new Map(),
  };
}

/**
 * Pattern to extract a kref from a prettified slot reference.
 * E.g., "<ko5> (Alleged: PersonalMessageSigner)" -> "ko5"
 */
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
 * Extract a kref and name from raw CapData returned by requestCapability.
 *
 * Expected shape: { body: "#\"$0.Alleged: PersonalMessageSigner\"", slots: ["ko5"] }
 *
 * @param capData - The raw CapData object.
 * @returns The extracted kref and capability name.
 */
export function parseCapabilityResponse(capData: unknown): {
  kref: string;
  name: string;
} {
  if (!capData || typeof capData !== 'object') {
    throw new Error('Expected CapData object from requestCapability');
  }

  const { body, slots } = capData as { body?: unknown; slots?: unknown };

  if (typeof body !== 'string' || !Array.isArray(slots) || slots.length === 0) {
    throw new Error(
      `Unexpected CapData shape: ${JSON.stringify(capData).slice(0, 200)}`,
    );
  }

  const kref = slots[0];
  if (typeof kref !== 'string') {
    throw new Error(`Expected string kref in slots[0], got: ${typeof kref}`);
  }

  // Parse the name from the body. The body format is:
  //   #"$0.Alleged: PersonalMessageSigner"
  // We extract the part after "Alleged: "
  const nameMatch = /Alleged:\s*([^"]+)/u.exec(body);
  const name = nameMatch?.[1]?.trim() ?? kref;

  return { kref, name };
}

/**
 * Ensure the vendor kref is available, redeeming the OCAP URL if needed.
 *
 * @param options - Options.
 * @param options.state - The plugin state.
 * @param options.daemon - The daemon caller.
 * @returns The vendor kref.
 */
export async function ensureVendor(options: {
  state: PluginState;
  daemon: DaemonCaller;
}): Promise<string> {
  const { state, daemon } = options;

  if (state.vendorKref) {
    return state.vendorKref;
  }

  if (!state.ocapUrl) {
    throw new Error(
      'Not connected to a MetaMask wallet. Ask the user for their OCAP URL ' +
        'from their ocap kernel-enabled MetaMask extension and pass it to ' +
        'metamask_obtain_vendor.',
    );
  }

  const kref = await daemon.redeemUrl(state.ocapUrl);
  state.vendorKref = kref;
  return kref;
}

/**
 * Resolve a capability reference to a kref.
 * Accepts either a capability name (looked up in state) or a direct kref.
 *
 * @param ref - Capability name or kref string.
 * @param state - The plugin state.
 * @returns The resolved kref.
 */
export function resolveCapability(ref: string, state: PluginState): string {
  if (isKref(ref)) {
    return ref;
  }

  const entry = state.capabilities.get(ref);
  if (!entry) {
    const available = [...state.capabilities.keys()];
    const hint =
      available.length > 0
        ? ` Available: ${available.join(', ')}`
        : ' No capabilities obtained yet. Use metamask_request_capability first.';
    throw new Error(`Unknown capability "${ref}".${hint}`);
  }
  return entry.kref;
}
