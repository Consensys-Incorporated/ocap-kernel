/**
 * Matcher vat: implements the `ServiceMatcher` interface from
 * `@metamask/service-discovery-types`.
 *
 * The matcher's public facet is a **durable** singleton: its kref is
 * stored in baggage via `defineDurableKind` so that on vat
 * re-incarnation (e.g., daemon restart with `--keep-state`) the same
 * kref is restored. Because the kernel's peer ID and OCAP-URL
 * encryption key also persist, the matcher's OCAP URL is stable
 * across daemon restarts.
 *
 * The registry of registered services is **in-memory**. After a
 * matcher restart, providers must re-register. Making the registry
 * durable is a planned follow-up; doing so brings its own obligations
 * (eviction of stale registrations when providers disappear, liveness
 * detection) that need to be designed before that change lands.
 *
 * Ranking is delegated to the `languageModelService` kernel service
 * (see `@metamask/kernel-language-model-service`), requested via the
 * cluster config's `services` list. Ranking is stateless: every
 * `findServices` call sends the full current registry plus the query
 * in a single chat-completion request, so registrations never involve
 * the LLM and there is no model-side context to drift out of sync with
 * the registry. There is no fallback ranker — LLM errors propagate to
 * the caller so problems are visible during development.
 */

import { E } from '@endo/eventual-send';
import type {
  ChatParams,
  ChatResult,
} from '@metamask/kernel-language-model-service';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type {
  Baggage,
  OcapURLIssuerService,
  OcapURLRedemptionService,
} from '@metamask/ocap-kernel';
import { ServiceDescriptionStruct } from '@metamask/service-discovery-types';
import type {
  ContactPoint,
  ObjectSpec,
  RegistrationToken,
  ServiceDescription,
  ServiceMatch,
  ServiceMatcher,
  ServiceQuery,
} from '@metamask/service-discovery-types';
import { validate } from '@metamask/superstruct';

import type { MatchEntry, ServiceDigest } from './ranker.ts';
import {
  MATCHER_SYSTEM_PROMPT,
  formatRankingPrompt,
  parseMatches,
} from './ranker.ts';

type RegisteredService = {
  id: string;
  description: ServiceDescription;
  contact: ContactPoint;
};

/**
 * The vat-facing shape of the `languageModelService` kernel service.
 * Kernel services exclude the streaming `chat` overload because an
 * `AsyncIterable` cannot cross the kernel marshal boundary.
 */
type LanguageModelService = {
  chat: (params: ChatParams & { stream?: false }) => Promise<ChatResult>;
};

type Services = {
  ocapURLIssuerService: OcapURLIssuerService;
  ocapURLRedemptionService: OcapURLRedemptionService;
  languageModelService: LanguageModelService;
};

/**
 * Vat-data primitives we need from the `vatPowers` argument. Provided
 * by swingset-liveslots; see liveslots.js → vatGlobals.VatData.
 */
type VatData = {
  makeKindHandle: (tag: string) => unknown;
  defineDurableKind: <Init extends (...args: never[]) => unknown, Behavior>(
    kindHandle: unknown,
    init: Init,
    behavior: Behavior,
  ) => (...args: Parameters<Init>) => unknown;
};

type VatPowers = {
  VatData: VatData;
};

/**
 * Build the matcher vat's root object.
 *
 * @param vatPowers - Vat powers; `VatData` is required for the durable
 * publicFacet.
 * @param parameters - Parameters passed to the vat. `model` (required)
 * is the model name sent with every ranking request — for an openclaw
 * gateway this is an agent target like `openclaw` or
 * `openclaw/<agentId>`.
 * @param baggage - Vat baggage. The matcher uses it to make the
 * publicFacet's kref durable, and to remember (across restarts) the
 * services bag and the issued matcher URL.
 * @returns The vat root exo, exposing `bootstrap`, `getPublicFacet`,
 * `getMatcherUrl`, `listAll`, and `unregister`.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: VatPowers,
  parameters: Record<string, unknown>,
  baggage: Baggage,
) {
  const { VatData } = vatPowers;
  if (!VatData?.defineDurableKind || !VatData.makeKindHandle) {
    throw new Error(
      'matcher vat: vatPowers.VatData.{defineDurableKind,makeKindHandle} required',
    );
  }

  const { model: modelParameter } = parameters;
  if (typeof modelParameter !== 'string' || modelParameter.length === 0) {
    throw new Error(
      'matcher vat: a non-empty "model" vat parameter is required',
    );
  }
  const model: string = modelParameter;

  // Registry is in-memory. On matcher restart it starts empty;
  // providers must re-register. Making this durable is a planned
  // follow-up; see the file header for the obligations it carries.
  const registry = new Map<string, RegisteredService>();

  const log = (...args: unknown[]): void => {
    // Forwarded to the daemon's log file via the kernel's console
    // plumbing. Prefix tags the source so it's easy to grep.
    // oxlint-disable-next-line no-console
    console.log('[matcher]', ...args);
  };

  /**
   * Provide-or-create a baggage entry: read it if it exists, otherwise
   * compute it via `make`, store it, and return.
   *
   * @param key - Baggage key.
   * @param make - Creator invoked only on first call.
   * @returns The stored value.
   */
  function provide<Type>(key: string, make: () => Type): Type {
    if (baggage.has(key)) {
      return baggage.get(key) as Type;
    }
    const value = make();
    baggage.init(key, value);
    return value;
  }

  // ---------------------------------------------------------------------
  // Durable publicFacet kind
  //
  // The kind handle and the singleton instance both live in baggage, so
  // re-incarnation restores the same kref. Behavior methods reference
  // closure-captured `registry` (in-memory) and `getServices()` (durable
  // via baggage); on re-incarnation, this `buildRootObject` runs again,
  // re-defines the kind with a fresh closure, and the singleton's
  // methods are rebound by liveslots to that fresh behavior.
  // ---------------------------------------------------------------------

  const matcherKindHandle = provide('matcherKindHandle', () =>
    VatData.makeKindHandle('ServiceMatcher'),
  );

  /**
   * Look up the services bag in baggage. Bootstrap stores it on first
   * launch; subsequent calls (including after re-incarnation) read
   * from baggage. Throws if bootstrap has not yet run.
   *
   * @returns The kernel-services bag.
   */
  function getServices(): Services {
    if (!baggage.has('services')) {
      throw new Error(
        'matcher vat: services not yet recorded; bootstrap must run first',
      );
    }
    return baggage.get('services') as Services;
  }

  /**
   * Allocate the next registry id, persisting the counter to baggage so
   * ids don't collide across re-incarnations even though the registry
   * map itself is reset.
   *
   * @returns The new id string.
   */
  function nextId(): string {
    const value = baggage.has('nextId') ? (baggage.get('nextId') as number) : 0;
    if (baggage.has('nextId')) {
      baggage.set('nextId', value + 1);
    } else {
      baggage.init('nextId', value + 1);
    }
    return `svc:${value}`;
  }

  /**
   * Validate the registration token with the provider's contact endpoint.
   *
   * @param contact - The provider's contact endpoint.
   * @param token - The token presented by the registrant.
   */
  async function confirmRegistration(
    contact: ContactPoint,
    token: RegistrationToken,
  ): Promise<void> {
    try {
      await E(contact).confirmServiceRegistration(token);
    } catch (cause) {
      log('registration rejected by contact:', cause);
      throw cause;
    }
  }

  /**
   * Walk a `ServiceDescription`'s top-level apiSpec, collecting names
   * and (optional) descriptions for any methods exposed by remotables
   * directly in the apiSpec. We don't recurse into nested objects or
   * remotables-of-remotables — keeps the LLM prompt tight.
   *
   * @param apiSpec - The service's API spec object.
   * @returns A list of method digests for the LLM prompt.
   */
  function extractMethodDigests(
    apiSpec: ObjectSpec,
  ): { name: string; description?: string }[] {
    const out: { name: string; description?: string }[] = [];
    for (const value of Object.values(apiSpec.properties)) {
      if (value.type.kind !== 'remotable') {
        continue;
      }
      for (const [name, method] of Object.entries(value.type.spec.methods)) {
        out.push(
          method.description
            ? { name, description: method.description }
            : { name },
        );
      }
    }
    return out;
  }

  /**
   * Project a registry entry into the compact digest the ranking
   * prompt presents to the model.
   *
   * @param entry - The registry entry.
   * @returns The service digest.
   */
  function entryDigest(entry: RegisteredService): ServiceDigest {
    return {
      id: entry.id,
      description: entry.description.description,
      methods: extractMethodDigests(entry.description.apiSpec),
    };
  }

  /**
   * Rank the registered services against a query via the
   * `languageModelService`. Stateless: the full current registry rides
   * along in the prompt, so concurrent calls are independent and need
   * no serialization.
   *
   * @param query - The free-text query from the consumer.
   * @returns The ranked matches the model returned, and the entries the
   * prompt described, by id. A registration made or evicted while the model
   * answers doesn't change what its ids refer to.
   * @throws If the LLM call fails or its reply isn't a valid match list.
   */
  async function rankServices(query: string): Promise<{
    ranked: MatchEntry[];
    prompted: Map<string, RegisteredService>;
  }> {
    const prompted = new Map(registry);
    if (prompted.size === 0) {
      // Nothing registered — no point burning a model call to learn
      // that nothing matches.
      return { ranked: [], prompted };
    }
    const { languageModelService } = getServices();
    const params: ChatParams & { stream?: false } = {
      model,
      messages: [
        { role: 'system', content: MATCHER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: formatRankingPrompt(
            [...prompted.values()].map(entryDigest),
            query,
          ),
        },
      ],
    };
    const result = await E(languageModelService).chat(harden(params));
    const content = result.choices[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('matcher vat: LLM reply contained no message content');
    }
    return { ranked: parseMatches(content), prompted };
  }

  /**
   * Extract the peer ID portion of an OCAP URL.
   *
   * The URL grammar is `ocap:<oid>@<peerId>[,<relayHint>]*`. Returns
   * the empty string if the URL doesn't match — callers treat that as
   * "no peer info, can't dedup".
   *
   * @param contactUrl - The OCAP URL to parse.
   * @returns The peer ID, or '' if it can't be extracted.
   */
  function peerIdFromContactUrl(contactUrl: string): string {
    const at = contactUrl.indexOf('@');
    if (at < 0) {
      return '';
    }
    const rest = contactUrl.slice(at + 1);
    const comma = rest.indexOf(',');
    return comma < 0 ? rest : rest.slice(0, comma);
  }

  /**
   * Find every existing registry entry that shares (peerId, providerTag)
   * with the given description. Used to evict superseded entries when a
   * provider re-registers after a restart.
   *
   * @param description - The incoming registration's description.
   * @returns Array of registry ids of matching entries.
   */
  function findSamePeerSameTagEntries(
    description: ServiceDescription,
  ): string[] {
    const newPeerId = peerIdFromContactUrl(
      description.contact[0]?.contactUrl ?? '',
    );
    if (newPeerId === '') {
      return [];
    }
    const newTag = description.providerTag;
    const matches: string[] = [];
    for (const entry of registry.values()) {
      if (entry.description.providerTag !== newTag) {
        continue;
      }
      const existingPeerId = peerIdFromContactUrl(
        entry.description.contact[0]?.contactUrl ?? '',
      );
      if (existingPeerId === newPeerId) {
        matches.push(entry.id);
      }
    }
    return matches;
  }

  /**
   * Store a service in the (in-memory) registry.
   *
   * @param description - The service description.
   * @param contact - The contact endpoint.
   * @returns The assigned registry id.
   */
  function store(
    description: ServiceDescription,
    contact: ContactPoint,
  ): string {
    const id = nextId();
    registry.set(id, { id, description, contact });
    log(`registered ${id}: ${description.description.slice(0, 80)}`);
    return id;
  }

  /**
   * Final step shared by all `register*` paths: evict any superseded
   * registrations and store the new entry locally. Purely local — the
   * LLM only ever sees the registry at query time, so there is no
   * model-side state to update (or roll back) here.
   *
   * Eviction key is (peerId, providerTag) — see ServiceDescription's
   * `providerTag` for the contract.
   *
   * @param description - The validated service description.
   * @param contact - The validated contact endpoint.
   */
  function commitRegistration(
    description: ServiceDescription,
    contact: ContactPoint,
  ): void {
    // A stored description is read by every later ranking prompt, so one that
    // doesn't validate would break `findServices` for every consumer.
    const [error] = validate(description, ServiceDescriptionStruct);
    if (error) {
      throw new Error(`invalid service description: ${error.message}`);
    }
    for (const supersededId of findSamePeerSameTagEntries(description)) {
      registry.delete(supersededId);
      log(
        `evicted superseded registration ${supersededId} (providerTag=${description.providerTag})`,
      );
    }
    store(description, contact);
  }

  // Behavior methods for `defineDurableKind` receive a `context` arg
  // (the per-instance `{ state, self }` bag) before the caller-supplied
  // arguments. We don't use it here — per-instance state is empty and
  // the registry plus services live in closure — but the parameter
  // must be present or the real args end up shifted one slot right.
  const matcherBehavior = {
    async registerService(
      _context: unknown,
      description: ServiceDescription,
      registrationToken: RegistrationToken,
    ): Promise<void> {
      const firstContact = description.contact[0];
      if (!firstContact) {
        throw new Error(
          'registerService: ServiceDescription has no contact info',
        );
      }
      const { contactUrl } = firstContact;
      const contact = (await E(getServices().ocapURLRedemptionService).redeem(
        contactUrl,
      )) as ContactPoint;
      await confirmRegistration(contact, registrationToken);
      commitRegistration(description, contact);
    },

    async registerServiceByUrl(
      _context: unknown,
      contactUrl: string,
      registrationToken: RegistrationToken,
    ): Promise<void> {
      const contact = (await E(getServices().ocapURLRedemptionService).redeem(
        contactUrl,
      )) as ContactPoint;
      // Confirm FIRST: an attacker could flood us with registration
      // requests that point at legitimate URLs; doing anything else
      // with the contact before verifying the token would amplify that
      // into work the matcher performs on the victim's behalf.
      await confirmRegistration(contact, registrationToken);
      const description = await E(contact).getServiceDescription();
      commitRegistration(description, contact);
    },

    async registerServiceByRef(
      _context: unknown,
      contact: ContactPoint,
      registrationToken: RegistrationToken,
    ): Promise<void> {
      // Confirm FIRST — see comment above in registerServiceByUrl.
      await confirmRegistration(contact, registrationToken);
      const description = await E(contact).getServiceDescription();
      commitRegistration(description, contact);
    },

    async findServices(
      _context: unknown,
      query: ServiceQuery,
    ): Promise<ServiceMatch[]> {
      const { ranked, prompted } = await rankServices(query.description);
      const matches: ServiceMatch[] = [];
      let dropped = 0;
      for (const entry of ranked) {
        const registered = prompted.get(entry.id);
        if (!registered) {
          // The model cited an id the prompt didn't carry — it can only be
          // a hallucination. Skip and log; don't bubble up.
          dropped += 1;
          log(`model cited unknown id ${entry.id}; skipping`);
          continue;
        }
        matches.push(
          harden({
            description: registered.description,
            rationale: entry.rationale,
          }),
        );
      }
      // If the model offered candidates and *all* of them were
      // unknown, the ranker is hallucinating ids wholesale. Loud
      // failure is better than silently returning [], which would be
      // indistinguishable from a legitimate zero-match query.
      if (ranked.length > 0 && matches.length === 0) {
        throw new Error(
          `matcher: LLM cited only unknown ids (${dropped}/${ranked.length}); ` +
            'the ranker is hallucinating.',
        );
      }
      log(
        `findServices("${query.description.slice(0, 80)}") → ${matches.length} match(es)`,
      );
      return matches;
    },
  };

  // Re-define the durable kind on every incarnation so liveslots can
  // rebind its behavior. The init function is empty: the singleton's
  // per-instance state lives in closure-captured baggage helpers above.
  const makeMatcherFacet = VatData.defineDurableKind(
    matcherKindHandle,
    () => harden({}),
    matcherBehavior,
  );

  // Provide-or-create the singleton publicFacet. On first incarnation
  // this allocates a fresh kref and stores it in baggage. On
  // re-incarnation, the stored ref is rehydrated to the same kref.
  const publicFacet = provide('publicFacet', () =>
    makeMatcherFacet(),
  ) as ServiceMatcher;

  return makeDefaultExo('matcherVatRoot', {
    async bootstrap(_vats: Record<string, unknown>, incoming: Services) {
      if (!incoming?.ocapURLIssuerService) {
        throw new Error('ocapURLIssuerService is required');
      }
      if (!incoming.ocapURLRedemptionService) {
        throw new Error('ocapURLRedemptionService is required');
      }
      if (!incoming.languageModelService) {
        throw new Error(
          'languageModelService is required (list it in the cluster config ' +
            "`services` and configure the daemon's llm.json)",
        );
      }
      // Persist services so the durable matcher facet's behavior can
      // reach them after re-incarnation (when bootstrap is not re-run).
      if (baggage.has('services')) {
        baggage.set('services', incoming);
      } else {
        baggage.init('services', incoming);
      }
      const matcherUrl = await E(incoming.ocapURLIssuerService).issue(
        publicFacet,
      );
      // Stash the issued URL too. Useful for the "list-subclusters"
      // / "current-matcher-URL" workflow without having to re-issue.
      if (baggage.has('matcherUrl')) {
        baggage.set('matcherUrl', matcherUrl);
      } else {
        baggage.init('matcherUrl', matcherUrl);
      }
      log(`bootstrap complete; matcherUrl=${matcherUrl}`);
      return harden({ matcherUrl });
    },

    getPublicFacet() {
      return publicFacet;
    },

    /**
     * Return the matcher's OCAP URL as previously issued by the
     * `ocapURLIssuerService` during bootstrap. Stable across vat
     * re-incarnations (the URL itself is deterministic given the durable
     * kref + persisted kernel identity, and we cache the issued value
     * in baggage).
     *
     * @returns The matcher OCAP URL, or `undefined` if bootstrap has
     * not yet run.
     */
    getMatcherUrl(): string | undefined {
      return baggage.has('matcherUrl')
        ? (baggage.get('matcherUrl') as string)
        : undefined;
    },

    /**
     * Admin-side query: list every registered service's registry id and
     * description. Useful for debugging.
     *
     * @returns The registry contents.
     */
    listAll(): { id: string; description: ServiceDescription }[] {
      return [...registry.values()].map((entry) => ({
        id: entry.id,
        description: entry.description,
      }));
    },

    /**
     * Admin-side: remove a service from the registry by id.
     *
     * @param id - The registry id to remove.
     * @returns True if an entry was removed, false if no such id existed.
     */
    unregister(id: string): boolean {
      const removed = registry.delete(id);
      if (removed) {
        log(`unregistered ${id}`);
      }
      return removed;
    },
  });
}
