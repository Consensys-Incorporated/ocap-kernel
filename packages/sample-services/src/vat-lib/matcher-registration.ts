import { E } from '@endo/eventual-send';
import type { OcapURLRedemptionService } from '@metamask/ocap-kernel';
import type {
  ContactPoint,
  ServiceMatcher,
} from '@metamask/service-discovery-types';

/**
 * A single service ready to register with a matcher.
 */
export type RegistrationEntry = {
  name: string;
  contact: ContactPoint;
  registrationToken: string;
};

/**
 * Summary of a `registerServicesWithMatcher` call: which entries
 * landed in the matcher's registry, and which did not.
 */
export type RegistrationSummary = {
  registered: { name: string }[];
  failed: { name: string; cause: unknown }[];
};

/**
 * Register a service (or group of services) with a matcher.
 *
 * If `matcherUrl` is empty/undefined, logs and returns an empty summary
 * without contacting any matcher — useful for development cycles where
 * the matcher isn't up yet. Otherwise redeems `matcherUrl` via the
 * kernel's redemption service and calls
 * `registerServiceByRef(contact, token)` for each entry sequentially.
 * Per-entry failures are logged but do not abort the remaining
 * registrations.
 *
 * Throws when the matcher URL itself cannot be redeemed (there's no
 * useful partial-success story past that point) and when every entry
 * fails (so bootstrap returning success while the matcher's registry
 * stays empty becomes a loud failure instead of a silent one).
 *
 * @param options - Registration options.
 * @param options.matcherUrl - Ocap URL of the matcher, or empty/undefined
 * to skip registration entirely.
 * @param options.ocapURLRedemptionService - Kernel service used to redeem
 * the matcher URL.
 * @param options.entries - Services to register.
 * @returns Summary of which entries succeeded vs failed.
 */
export async function registerServicesWithMatcher(options: {
  matcherUrl: string | undefined;
  ocapURLRedemptionService: OcapURLRedemptionService;
  entries: RegistrationEntry[];
}): Promise<RegistrationSummary> {
  const { matcherUrl, ocapURLRedemptionService, entries } = options;
  const summary: RegistrationSummary = { registered: [], failed: [] };

  if (!matcherUrl) {
    // oxlint-disable-next-line no-console
    console.log(
      '[vat] matcherUrl parameter not set; skipping matcher registration.',
    );
    return summary;
  }

  let matcher: ServiceMatcher;
  try {
    matcher = (await E(ocapURLRedemptionService).redeem(
      matcherUrl,
    )) as ServiceMatcher;
  } catch (cause) {
    throw new Error(`Failed to redeem matcher URL ${matcherUrl}`, { cause });
  }

  for (const entry of entries) {
    try {
      await E(matcher).registerServiceByRef(
        entry.contact,
        entry.registrationToken,
      );
      summary.registered.push({ name: entry.name });
      // oxlint-disable-next-line no-console
      console.log(`[vat] Registered service "${entry.name}" with matcher.`);
    } catch (cause) {
      summary.failed.push({ name: entry.name, cause });
      // oxlint-disable-next-line no-console
      console.error(`[vat] Failed to register "${entry.name}":`, cause);
    }
  }

  if (entries.length > 0 && summary.registered.length === 0) {
    throw new Error(
      `All ${entries.length} registration(s) failed for matcher ${matcherUrl}`,
    );
  }

  return summary;
}
