import type {
  ContactPoint,
  ServiceDescription,
} from '@metamask/service-discovery-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildRootObject } from './index.ts';

// The matcher vat's logic uses `E()` internally; under unit test we don't
// need CapTP routing, just identity-like resolution so the mock services
// get called directly.
vi.mock('@endo/eventual-send', () => ({
  E: vi.fn((obj: unknown) => obj),
}));

type IOService = {
  read: () => Promise<string | null>;
  write: (data: string) => Promise<void>;
};

type Services = {
  ocapURLIssuerService: { issue: (obj: unknown) => Promise<string> };
  ocapURLRedemptionService: { redeem: (url: string) => Promise<unknown> };
  llm: IOService;
};

const sampleDescription = (
  name = 'Signer',
  contactUrl = 'ocap:abc@peer',
  providerTag = name.toLowerCase(),
): ServiceDescription => ({
  apiSpec: { properties: {} },
  description: `A service called ${name}`,
  contact: [{ contactType: 'public', contactUrl }],
  providerTag,
});

/**
 * Build a mocked ContactPoint whose `confirmServiceRegistration` verifies
 * the presented token against `expectedToken`.
 *
 * @param options - Options for the mock contact point.
 * @param options.description - The ServiceDescription to return.
 * @param options.expectedToken - The token the matcher must present.
 * @returns A mock contact point plus access to the mock fns.
 */
function makeMockContact(options: {
  description: ServiceDescription;
  expectedToken: string;
}) {
  const { description, expectedToken } = options;
  const getServiceDescription = vi.fn(async () => description);
  const confirmServiceRegistration = vi.fn(async (token: string) => {
    if (token !== expectedToken) {
      throw new Error(
        `token mismatch: expected ${expectedToken}, got ${token}`,
      );
    }
  });
  const initiateContact = vi.fn<ContactPoint['initiateContact']>();
  const contact: ContactPoint = {
    getServiceDescription,
    confirmServiceRegistration,
    initiateContact,
  };
  return { contact, getServiceDescription, confirmServiceRegistration };
}

/**
 * Build a fake `llm` IOService. Every `write()` call enqueues the
 * incoming line and synthesizes a reply via the supplied `replyFor`
 * callback; subsequent `read()` calls drain the queued replies in
 * order, matching the kernel-side IOChannel's "one line at a time"
 * semantics. Defaults to acknowledging every ingest with `{ kind:
 * "ingested" }` and answering every query with an empty match list,
 * which the per-test setup can override.
 *
 * @param options - Mock options.
 * @param options.replyFor - Custom reply function. Receives the parsed
 * request and returns the reply object the bridge would send back.
 * @returns The IOService plus inspection helpers.
 */
function makeMockLlm(
  options: {
    replyFor?: (request: unknown) => unknown;
  } = {},
) {
  const writes: unknown[] = [];
  const replyQueue: string[] = [];
  const replyFor =
    options.replyFor ??
    ((request: unknown) => {
      const { kind } = request as { kind?: string };
      if (kind === 'ingest') {
        return { kind: 'ingested' };
      }
      if (kind === 'query') {
        return { kind: 'matches', matches: [] };
      }
      return { kind: 'error', message: `unknown request kind: ${kind ?? '?'}` };
    });

  const write = vi.fn(async (data: string) => {
    const parsed: unknown = JSON.parse(data);
    writes.push(parsed);
    replyQueue.push(JSON.stringify(replyFor(parsed)));
  });
  const read = vi.fn(async () => {
    const next = replyQueue.shift();
    return next ?? null;
  });

  const llm: IOService = { read, write };
  return {
    llm,
    writes,
    write,
    read,
    /**
     * Inspect the most recently sent request.
     *
     * @returns The last parsed request the matcher wrote, or `undefined`.
     */
    lastRequest: (): unknown => writes[writes.length - 1],
  };
}

/**
 * Build a default services bag whose `issue` returns a deterministic
 * URL, whose `redeem` resolves a preconfigured contact, and whose
 * `llm` IOService can be swapped per-test.
 *
 * @param options - Mock options.
 * @param options.llm - Override for the llm IOService and inspection
 * helpers (default: an LLM that acks ingests and returns empty matches).
 * @returns The services bag plus helpers to inspect calls.
 */
function makeMockServices(
  options: { llm?: ReturnType<typeof makeMockLlm> } = {},
) {
  const issue = vi.fn(async (_obj: unknown) => 'ocap:matcher-url@peer');
  let redeemResult: unknown = null;
  const redeem = vi.fn(async (_url: string) => redeemResult);
  const llmMock = options.llm ?? makeMockLlm();
  const services: Services = {
    ocapURLIssuerService: { issue },
    ocapURLRedemptionService: { redeem },
    llm: llmMock.llm,
  };
  return {
    services,
    issue,
    redeem,
    llm: llmMock,
    setRedeem: (value: unknown) => {
      redeemResult = value;
    },
  };
}

/**
 * Build a fake `Baggage` (swingset-liveslots map store), backed by a plain
 * Map. Faithful enough for unit tests of code that just calls
 * `init/has/get/set`.
 *
 * @returns The fake baggage.
 */
function makeFakeBaggage() {
  const store = new Map<string, unknown>();
  return {
    has: (key: string) => store.has(key),
    get: (key: string) => {
      if (!store.has(key)) {
        throw new Error(`baggage: missing key "${key}"`);
      }
      return store.get(key);
    },
    init: (key: string, value: unknown) => {
      if (store.has(key)) {
        throw new Error(`baggage: key "${key}" already initialized`);
      }
      store.set(key, value);
    },
    set: (key: string, value: unknown) => {
      if (!store.has(key)) {
        throw new Error(`baggage: cannot set uninitialized key "${key}"`);
      }
      store.set(key, value);
    },
  };
}

/**
 * Build a fake `vatPowers` with a `VatData` shim. The matcher vat only
 * uses `makeKindHandle` (returns an opaque token) and `defineDurableKind`.
 *
 * The fake honors liveslots' real calling convention for behavior
 * methods: each method is invoked with `(context, ...args)` where
 * `context = { state, self }`. This keeps unit tests honest about the
 * shape the production runtime will hand to behavior methods.
 *
 * @returns The fake vatPowers.
 */
function makeFakeVatPowers(): Parameters<typeof buildRootObject>[0] {
  return {
    VatData: {
      makeKindHandle: (tag: string) => ({ kind: tag }),
      defineDurableKind: (_kindHandle, init, behavior) => {
        return (...args) => {
          const state = init(...args);
          const facet: Record<string, unknown> = {};
          const context = harden({ state, self: facet });
          for (const [name, fn] of Object.entries(
            behavior as Record<string, (...args: unknown[]) => unknown>,
          )) {
            facet[name] = (...callArgs: unknown[]) => fn(context, ...callArgs);
          }
          return facet;
        };
      },
    },
  };
}

describe('matcher vat', () => {
  let root: ReturnType<typeof buildRootObject>;
  let mocks: ReturnType<typeof makeMockServices>;

  beforeEach(async () => {
    root = buildRootObject(makeFakeVatPowers(), {}, makeFakeBaggage() as never);
    mocks = makeMockServices();
  });

  describe('bootstrap', () => {
    it('issues an ocap URL for the public facet and returns it', async () => {
      const result = await root.bootstrap({}, mocks.services);
      expect(result).toStrictEqual({ matcherUrl: 'ocap:matcher-url@peer' });
      expect(mocks.issue).toHaveBeenCalledTimes(1);
    });

    it('throws if ocapURLIssuerService is missing', async () => {
      await expect(
        root.bootstrap({}, {
          ocapURLRedemptionService: mocks.services.ocapURLRedemptionService,
          llm: mocks.services.llm,
        } as Services),
      ).rejects.toThrow('ocapURLIssuerService is required');
    });

    it('throws if ocapURLRedemptionService is missing', async () => {
      await expect(
        root.bootstrap({}, {
          ocapURLIssuerService: mocks.services.ocapURLIssuerService,
          llm: mocks.services.llm,
        } as Services),
      ).rejects.toThrow('ocapURLRedemptionService is required');
    });

    it('throws if the llm IOService is missing', async () => {
      await expect(
        root.bootstrap({}, {
          ocapURLIssuerService: mocks.services.ocapURLIssuerService,
          ocapURLRedemptionService: mocks.services.ocapURLRedemptionService,
        } as Services),
      ).rejects.toThrow(/llm IOService is required/u);
    });
  });

  describe('registerServiceByRef', () => {
    it('confirms the token, stores the service, and feeds it to the bridge', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const description = sampleDescription('Foo');
      const { contact, confirmServiceRegistration, getServiceDescription } =
        makeMockContact({ description, expectedToken: 'tok-1' });

      await publicFacet.registerServiceByRef(contact, 'tok-1');

      expect(getServiceDescription).toHaveBeenCalledTimes(1);
      expect(confirmServiceRegistration).toHaveBeenCalledWith('tok-1');

      const all = root.listAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.description).toStrictEqual(description);

      // Bridge round-trip should have happened: one ingest write,
      // one ingest read.
      expect(mocks.llm.write).toHaveBeenCalledTimes(1);
      expect(mocks.llm.read).toHaveBeenCalledTimes(1);
      expect(mocks.llm.lastRequest()).toMatchObject({
        kind: 'ingest',
        service: { id: 'svc:0', description: description.description },
      });
    });

    it('rejects when the provider reports a token mismatch', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const { contact } = makeMockContact({
        description: sampleDescription(),
        expectedToken: 'real-token',
      });

      await expect(
        publicFacet.registerServiceByRef(contact, 'wrong-token'),
      ).rejects.toThrow(/token mismatch/u);
      expect(root.listAll()).toHaveLength(0);
      expect(mocks.llm.write).not.toHaveBeenCalled();
    });

    it('calls confirmServiceRegistration before getServiceDescription', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const { contact, getServiceDescription, confirmServiceRegistration } =
        makeMockContact({
          description: sampleDescription(),
          expectedToken: 'tok',
        });

      await publicFacet.registerServiceByRef(contact, 'tok');

      const confirmOrder =
        confirmServiceRegistration.mock.invocationCallOrder[0];
      const getOrder = getServiceDescription.mock.invocationCallOrder[0];
      expect(confirmOrder).toBeDefined();
      expect(getOrder).toBeDefined();
      expect(confirmOrder).toBeLessThan(getOrder as number);
    });

    it('does not call getServiceDescription when confirm rejects', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const { contact, getServiceDescription } = makeMockContact({
        description: sampleDescription(),
        expectedToken: 'real-token',
      });

      await expect(
        publicFacet.registerServiceByRef(contact, 'wrong-token'),
      ).rejects.toThrow(/token mismatch/u);
      expect(getServiceDescription).not.toHaveBeenCalled();
    });

    it('rolls back the local registry when bridge ingest fails', async () => {
      const llm = makeMockLlm({
        replyFor: () => ({ kind: 'error', message: 'bridge bad' }),
      });
      mocks = makeMockServices({ llm });
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const { contact } = makeMockContact({
        description: sampleDescription(),
        expectedToken: 'tok',
      });

      await expect(
        publicFacet.registerServiceByRef(contact, 'tok'),
      ).rejects.toThrow(/bridge ingest error: bridge bad/u);
      expect(root.listAll()).toHaveLength(0);
    });
  });

  describe('registerServiceByUrl', () => {
    it('redeems the URL, confirms the token, and stores the service', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const description = sampleDescription('Bar', 'ocap:bar@peer');
      const { contact, confirmServiceRegistration } = makeMockContact({
        description,
        expectedToken: 'tok-2',
      });
      mocks.setRedeem(contact);

      await publicFacet.registerServiceByUrl('ocap:bar@peer', 'tok-2');

      expect(mocks.redeem).toHaveBeenCalledWith('ocap:bar@peer');
      expect(confirmServiceRegistration).toHaveBeenCalledWith('tok-2');
      expect(root.listAll()).toHaveLength(1);
    });

    it('does not call getServiceDescription when confirm rejects', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const { contact, getServiceDescription } = makeMockContact({
        description: sampleDescription('Bar', 'ocap:bar@peer'),
        expectedToken: 'right',
      });
      mocks.setRedeem(contact);

      await expect(
        publicFacet.registerServiceByUrl('ocap:bar@peer', 'wrong'),
      ).rejects.toThrow(/token mismatch/u);
      expect(getServiceDescription).not.toHaveBeenCalled();
      expect(root.listAll()).toHaveLength(0);
    });
  });

  describe('registerService', () => {
    it('redeems the first contact URL from the description and confirms the token', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const description = sampleDescription('Baz', 'ocap:baz@peer');
      const { contact, confirmServiceRegistration } = makeMockContact({
        description,
        expectedToken: 'tok-3',
      });
      mocks.setRedeem(contact);

      await publicFacet.registerService(description, 'tok-3');

      expect(mocks.redeem).toHaveBeenCalledWith('ocap:baz@peer');
      expect(confirmServiceRegistration).toHaveBeenCalledWith('tok-3');
      expect(root.listAll()).toHaveLength(1);
    });

    it('throws when the description has no contact info', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const description: ServiceDescription = {
        apiSpec: { properties: {} },
        description: 'no contact',
        contact: [],
        providerTag: 'lonely',
      };

      await expect(
        publicFacet.registerService(description, 'tok'),
      ).rejects.toThrow(/no contact info/u);
    });
  });

  describe('same-peer same-tag dedup', () => {
    it('evicts the previous registration when (peer, tag) matches', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();

      // First registration: peerA + tag=signer
      const description1 = sampleDescription(
        'Signer',
        'ocap:key1@peerA',
        'signer',
      );
      const contactA = makeMockContact({
        description: description1,
        expectedToken: 'tok-A',
      });
      mocks.redeem.mockResolvedValueOnce(contactA.contact);
      await publicFacet.registerService(description1, 'tok-A');
      expect(root.listAll()).toHaveLength(1);

      // Second registration: same peerA + same tag=signer (simulates the
      // same logical provider re-registering after a kernel restart with a
      // fresh contact endpoint).
      const description2 = sampleDescription(
        'Signer',
        'ocap:key2@peerA',
        'signer',
      );
      const contactB = makeMockContact({
        description: description2,
        expectedToken: 'tok-B',
      });
      mocks.redeem.mockResolvedValueOnce(contactB.contact);
      await publicFacet.registerService(description2, 'tok-B');

      // Only the most recent (peerA, signer) registration survives.
      const all = root.listAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.description.contact[0]?.contactUrl).toBe(
        'ocap:key2@peerA',
      );
    });

    it('keeps both when same peer registers different tags', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();

      const echo = sampleDescription('Echo', 'ocap:k1@peerA', 'echo');
      const echoContact = makeMockContact({
        description: echo,
        expectedToken: 'tok-A',
      });
      mocks.redeem.mockResolvedValueOnce(echoContact.contact);
      await publicFacet.registerService(echo, 'tok-A');

      const random = sampleDescription('Random', 'ocap:k2@peerA', 'random');
      const randomContact = makeMockContact({
        description: random,
        expectedToken: 'tok-B',
      });
      mocks.redeem.mockResolvedValueOnce(randomContact.contact);
      await publicFacet.registerService(random, 'tok-B');

      expect(root.listAll()).toHaveLength(2);
    });

    it('keeps both when different peers share a tag', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();

      const fromA = sampleDescription('Signer', 'ocap:k1@peerA', 'signer');
      const contactA = makeMockContact({
        description: fromA,
        expectedToken: 'tok-A',
      });
      mocks.redeem.mockResolvedValueOnce(contactA.contact);
      await publicFacet.registerService(fromA, 'tok-A');

      const fromB = sampleDescription('Signer', 'ocap:k2@peerB', 'signer');
      const contactB = makeMockContact({
        description: fromB,
        expectedToken: 'tok-B',
      });
      mocks.redeem.mockResolvedValueOnce(contactB.contact);
      await publicFacet.registerService(fromB, 'tok-B');

      expect(root.listAll()).toHaveLength(2);
    });
  });

  describe('findServices', () => {
    it('asks the bridge and returns whatever services it cites', async () => {
      const llm = makeMockLlm({
        replyFor: (request: unknown) => {
          const { kind } = request as { kind?: string };
          if (kind === 'ingest') {
            return { kind: 'ingested' };
          }
          // Cite svc:0 (the only one we'll register) on every query.
          return {
            kind: 'matches',
            matches: [{ id: 'svc:0', rationale: 'because' }],
          };
        },
      });
      mocks = makeMockServices({ llm });
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const description = sampleDescription('Foo');
      const { contact } = makeMockContact({
        description,
        expectedToken: 't',
      });
      await publicFacet.registerServiceByRef(contact, 't');

      const matches = await publicFacet.findServices({
        description: 'whatever',
      });

      expect(matches).toHaveLength(1);
      expect(matches[0]?.description).toStrictEqual(description);
      expect(matches[0]?.rationale).toBe('because');
      // Last bridge request was the query (with the user's text).
      expect(llm.lastRequest()).toMatchObject({
        kind: 'query',
        query: 'whatever',
      });
    });

    it('returns an empty list when the bridge cites no services', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const matches = await publicFacet.findServices({ description: 'q' });
      expect(matches).toStrictEqual([]);
    });

    it('skips ids the bridge cites that do not exist in the registry', async () => {
      const llm = makeMockLlm({
        replyFor: (request: unknown) => {
          const { kind } = request as { kind?: string };
          if (kind === 'ingest') {
            return { kind: 'ingested' };
          }
          return {
            kind: 'matches',
            matches: [
              { id: 'svc:0', rationale: 'real one' },
              { id: 'svc:nonexistent', rationale: 'hallucinated' },
            ],
          };
        },
      });
      mocks = makeMockServices({ llm });
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const { contact } = makeMockContact({
        description: sampleDescription(),
        expectedToken: 't',
      });
      await publicFacet.registerServiceByRef(contact, 't');

      const matches = await publicFacet.findServices({ description: 'q' });

      expect(matches).toHaveLength(1);
      expect(matches[0]?.rationale).toBe('real one');
    });

    it('propagates bridge errors instead of falling back', async () => {
      let queryCount = 0;
      const llm = makeMockLlm({
        replyFor: (request: unknown) => {
          const { kind } = request as { kind?: string };
          if (kind === 'ingest') {
            return { kind: 'ingested' };
          }
          queryCount += 1;
          return { kind: 'error', message: 'gateway sad' };
        },
      });
      mocks = makeMockServices({ llm });
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const { contact } = makeMockContact({
        description: sampleDescription(),
        expectedToken: 't',
      });
      await publicFacet.registerServiceByRef(contact, 't');

      await expect(
        publicFacet.findServices({ description: 'q' }),
      ).rejects.toThrow(/bridge query error: gateway sad/u);
      expect(queryCount).toBe(1);
    });
  });

  describe('unregister', () => {
    it('removes a registered service by id', async () => {
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const { contact } = makeMockContact({
        description: sampleDescription(),
        expectedToken: 't',
      });
      await publicFacet.registerServiceByRef(contact, 't');
      const [entry] = root.listAll();
      expect(entry).toBeDefined();

      const removed = root.unregister(entry?.id ?? '');
      expect(removed).toBe(true);
      expect(root.listAll()).toHaveLength(0);
    });

    it('returns false when the id is unknown', async () => {
      await root.bootstrap({}, mocks.services);
      expect(root.unregister('svc:999')).toBe(false);
    });
  });
});
