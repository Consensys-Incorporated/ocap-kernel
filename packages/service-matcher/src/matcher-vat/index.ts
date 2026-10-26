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
 * detection, and reconciling persisted entries with the bridge's LLM
 * context) that need to be designed before that change lands.
 *
 * Ranking is delegated to an LLM-backed bridge process via an
 * `IOService` endowment named `llm`. On every successful registration
 * the matcher feeds the LLM a digest of the service (description +
 * method names); on every `findServices` call it asks the LLM to pick
 * matches against the user's natural-language query and replies
 * accordingly. There is no fallback ranker — bridge errors propagate
 * to the caller so problems are visible during development.
 */

import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type {
  Baggage,
  OcapURLIssuerService,
  OcapURLRedemptionService,
} from '@metamask/ocap-kernel';
import type {
  ContactPoint,
  ObjectSpec,
  RegistrationToken,
  ServiceDescription,
  ServiceMatch,
  ServiceMatcher,
  ServiceQuery,
} from '@metamask/service-discovery-types';

type RegisteredService = {
  id: string;
  description: ServiceDescription;
  contact: ContactPoint;
};

/**
 * The vat-facing shape of an `IOService`. The kernel-side
 * implementation lives in `packages/ocap-kernel/src/io/io-service.ts`
 * and is wired up via the cluster config's `io` block.
 */
type IOService = {
  read: () => Promise<string | null>;
  write: (data: string) => Promise<void>;
};

type Services = {
  ocapURLIssuerService: OcapURLIssuerService;
  ocapURLRedemptionService: OcapURLRedemptionService;
  llm: IOService;
};

/** Wire-protocol shapes — must agree with `@ocap/llm-bridge`'s `protocol.ts`. */
type IngestRequest = {
  kind: 'ingest';
  service: {
    id: string;
    description: string;
    methods: { name: string; description?: string }[];
  };
};

type QueryRequest = {
  kind: 'query';
  query: string;
};

type IngestedReply = { kind: 'ingested' };
type MatchesReply = {
  kind: 'matches';
  matches: { id: string; rationale: string }[];
};
type ErrorReply = { kind: 'error'; message: string };
type Reply = IngestedReply | MatchesReply | ErrorReply;

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
 * @param _parameters - Parameters passed to the vat (unused).
 * @param baggage - Vat baggage. The matcher uses it to make the
 * publicFacet's kref durable, and to remember (across restarts) the
 * services bag and the issued matcher URL.
 * @returns The vat root exo, exposing `bootstrap`, `getPublicFacet`,
 * `getMatcherUrl`, `listAll`, and `unregister`.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: VatPowers,
  _parameters: Record<string, unknown>,
  baggage: Baggage,
) {
  const { VatData } = vatPowers;
  if (!VatData?.defineDurableKind || !VatData.makeKindHandle) {
    throw new Error(
      'matcher vat: vatPowers.VatData.{defineDurableKind,makeKindHandle} required',
    );
  }

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

  // -------------------------------------------------------------------
  // Bridge mutex.
  //
  // The vat may have many register* / findServices calls in flight
  // concurrently. The bridge channel is a single line-stream and the
  // protocol is strictly request-then-reply, so we serialize round-trips
  // through a chained promise to keep replies matched to their requests.
  // -------------------------------------------------------------------

  let bridgeChain: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` only after the previous bridge round-trip has settled.
   * Errors from the previous holder are swallowed so they don't poison
   * subsequent calls.
   *
   * @param fn - The bridge round-trip to serialize.
   * @returns Whatever `fn` returns.
   */
  async function withBridgeLock<Result>(
    fn: () => Promise<Result>,
  ): Promise<Result> {
    const previous = bridgeChain;
    let release: () => void = () => undefined;
    bridgeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // Wait for the previous holder to finish; ignore its outcome —
      // an error there shouldn't poison subsequent calls.
      await previous.catch(() => undefined);
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Send a single request to the bridge over the `llm` IOService and
   * await its single-line reply.
   *
   * @param request - The request object to send (will be JSON-encoded).
   * @returns The parsed reply.
   * @throws If the channel has closed, or the reply isn't valid JSON.
   */
  async function bridgeRoundTrip(
    request: IngestRequest | QueryRequest,
  ): Promise<Reply> {
    return withBridgeLock(async () => {
      const { llm } = getServices();
      // The kernel-side IOChannel appends '\n' itself, so we just send
      // the JSON-encoded request body.
      await E(llm).write(JSON.stringify(request));
      const line = await E(llm).read();
      if (line === null) {
        throw new Error('matcher vat: llm bridge channel closed');
      }
      try {
        return JSON.parse(line) as Reply;
      } catch {
        throw new Error(
          `matcher vat: llm bridge sent unparseable line: ${line}`,
        );
      }
    });
  }

  /**
   * Tell the bridge to ingest a new service registration into its
   * conversation context.
   *
   * @param id - The matcher's local registry id for the service.
   * @param description - The full service description.
   * @throws If the bridge replies with `error` or any non-`ingested` kind.
   */
  async function ingestService(
    id: string,
    description: ServiceDescription,
  ): Promise<void> {
    const request: IngestRequest = {
      kind: 'ingest',
      service: {
        id,
        description: description.description,
        methods: extractMethodDigests(description.apiSpec),
      },
    };
    const reply = await bridgeRoundTrip(request);
    if (reply.kind === 'error') {
      throw new Error(`matcher vat: bridge ingest error: ${reply.message}`);
    }
    if (reply.kind !== 'ingested') {
      throw new Error(
        `matcher vat: unexpected bridge reply kind for ingest: ${reply.kind}`,
      );
    }
  }

  /**
   * Ask the bridge to rank registered services against a query.
   *
   * @param query - The free-text query from the consumer.
   * @returns The ranked matches the bridge returned.
   * @throws If the bridge replies with `error` or any non-`matches` kind.
   */
  async function queryServicesViaBridge(
    query: string,
  ): Promise<{ id: string; rationale: string }[]> {
    const reply = await bridgeRoundTrip({ kind: 'query', query });
    if (reply.kind === 'error') {
      throw new Error(`matcher vat: bridge query error: ${reply.message}`);
    }
    if (reply.kind !== 'matches') {
      throw new Error(
        `matcher vat: unexpected bridge reply kind for query: ${reply.kind}`,
      );
    }
    return reply.matches;
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
   * registrations, store the new entry locally, and tell the bridge. If
   * the bridge call fails, undo the local store so the registry never
   * contains entries the LLM doesn't know about.
   *
   * Eviction key is (peerId, providerTag) — see ServiceDescription's
   * `providerTag` for the contract. The dead `svc:N` entries that get
   * evicted here may still be cited by the LLM bridge's stale
   * conversation context; `findServices` filters those out via the
   * existing "bridge cited unknown id" guard.
   *
   * @param description - The validated service description.
   * @param contact - The validated contact endpoint.
   */
  async function commitRegistration(
    description: ServiceDescription,
    contact: ContactPoint,
  ): Promise<void> {
    // Stash superseded entries so we can restore them if the bridge
    // ingest fails — otherwise a transient bridge failure would
    // silently destroy whatever previous registration shared this
    // providerTag, defeating the atomicity property the dedup commit
    // was supposed to provide.
    const evicted: [string, RegisteredService][] = [];
    for (const supersededId of findSamePeerSameTagEntries(description)) {
      const prior = registry.get(supersededId);
      if (prior) {
        evicted.push([supersededId, prior]);
      }
      registry.delete(supersededId);
      log(
        `evicted superseded registration ${supersededId} (providerTag=${description.providerTag})`,
      );
    }
    const id = store(description, contact);
    try {
      await ingestService(id, description);
    } catch (cause) {
      registry.delete(id);
      for (const [oldId, oldEntry] of evicted) {
        registry.set(oldId, oldEntry);
      }
      log(
        `bridge ingest failed for ${id}; rolled back new entry and restored ${evicted.length} evicted entries:`,
        cause,
      );
      throw cause;
    }
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
      await commitRegistration(description, contact);
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
      await commitRegistration(description, contact);
    },

    async registerServiceByRef(
      _context: unknown,
      contact: ContactPoint,
      registrationToken: RegistrationToken,
    ): Promise<void> {
      // Confirm FIRST — see comment above in registerServiceByUrl.
      await confirmRegistration(contact, registrationToken);
      const description = await E(contact).getServiceDescription();
      await commitRegistration(description, contact);
    },

    async findServices(
      _context: unknown,
      query: ServiceQuery,
    ): Promise<ServiceMatch[]> {
      const ranked = await queryServicesViaBridge(query.description);
      const matches: ServiceMatch[] = [];
      let dropped = 0;
      for (const entry of ranked) {
        const registered = registry.get(entry.id);
        if (!registered) {
          // The bridge cited an id we no longer have — could happen if
          // the LLM hallucinates one, or if a service was unregistered
          // between ingest and query. Skip and log; don't bubble up.
          dropped += 1;
          log(`bridge cited unknown id ${entry.id}; skipping`);
          continue;
        }
        matches.push(
          harden({
            description: registered.description,
            rationale: entry.rationale,
          }),
        );
      }
      // If the bridge offered candidates and *all* of them were
      // unknown, the registry is either out of sync with the bridge or
      // the ranker is hallucinating ids wholesale. Loud failure is
      // better than silently returning [], which would be
      // indistinguishable from a legitimate zero-match query.
      if (ranked.length > 0 && matches.length === 0) {
        throw new Error(
          `matcher: LLM bridge cited only unknown ids (${dropped}/${ranked.length}); ` +
            'registry may be out of sync or ranker is hallucinating.',
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
      if (!incoming.llm) {
        throw new Error(
          'llm IOService is required (configure it in the cluster config under `io.llm`)',
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
