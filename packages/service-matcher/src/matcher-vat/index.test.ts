import type {
  ChatParams,
  ChatResult,
} from '@metamask/kernel-language-model-service';
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

type Services = {
  ocapURLIssuerService: { issue: (obj: unknown) => Promise<string> };
  ocapURLRedemptionService: { redeem: (url: string) => Promise<unknown> };
  languageModelService: {
    chat: (params: ChatParams) => Promise<ChatResult>;
  };
};

const TEST_MODEL = 'test-model';

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
 * Build a fake `languageModelService`. Each `chat()` call records its
 * params and replies with assistant content synthesized by the supplied
 * `replyContent` callback (default: an empty match list, `[]`).
 *
 * @param options - Mock options.
 * @param options.replyContent - Custom reply function. Receives the
 * chat params and returns the assistant message content (or throws to
 * simulate a gateway failure).
 * @returns The mock service plus inspection helpers.
 */
function makeMockLms(
  options: {
    replyContent?: (params: ChatParams) => string | Promise<string>;
  } = {},
) {
  const calls: ChatParams[] = [];
  const replyContent = options.replyContent ?? (() => '[]');

  const chat = vi.fn(async (params: ChatParams): Promise<ChatResult> => {
    calls.push(params);
    const content = await replyContent(params);
    return {
      id: `chat-${calls.length}`,
      model: params.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  });

  return {
    service: { chat },
    chat,
    calls,
    /**
     * Inspect the most recent chat request.
     *
     * @returns The last chat params the matcher sent, or `undefined`.
     */
    lastParams: (): ChatParams | undefined => calls[calls.length - 1],
  };
}

/**
 * Build a default services bag whose `issue` returns a deterministic
 * URL, whose `redeem` resolves a preconfigured contact, and whose
 * `languageModelService` can be swapped per-test.
 *
 * @param options - Mock options.
 * @param options.lms - Override for the language model service mock
 * (default: a model that answers every ranking request with `[]`).
 * @returns The services bag plus helpers to inspect calls.
 */
function makeMockServices(
  options: { lms?: ReturnType<typeof makeMockLms> } = {},
) {
  const issue = vi.fn(async (_obj: unknown) => 'ocap:matcher-url@peer');
  let redeemResult: unknown = null;
  const redeem = vi.fn(async (_url: string) => redeemResult);
  const lmsMock = options.lms ?? makeMockLms();
  const services: Services = {
    ocapURLIssuerService: { issue },
    ocapURLRedemptionService: { redeem },
    languageModelService: lmsMock.service,
  };
  return {
    services,
    issue,
    redeem,
    lms: lmsMock,
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
    root = buildRootObject(
      makeFakeVatPowers(),
      { model: TEST_MODEL },
      makeFakeBaggage() as never,
    );
    mocks = makeMockServices();
  });

  describe('parameters', () => {
    it.each([
      ['missing', {}],
      ['empty', { model: '' }],
      ['non-string', { model: 42 }],
    ])('throws when the model parameter is %s', (_case, parameters) => {
      expect(() =>
        buildRootObject(
          makeFakeVatPowers(),
          parameters,
          makeFakeBaggage() as never,
        ),
      ).toThrow(/"model" vat parameter is required/u);
    });
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
          languageModelService: mocks.services.languageModelService,
        } as Services),
      ).rejects.toThrow('ocapURLIssuerService is required');
    });

    it('throws if ocapURLRedemptionService is missing', async () => {
      await expect(
        root.bootstrap({}, {
          ocapURLIssuerService: mocks.services.ocapURLIssuerService,
          languageModelService: mocks.services.languageModelService,
        } as Services),
      ).rejects.toThrow('ocapURLRedemptionService is required');
    });

    it('throws if the languageModelService is missing', async () => {
      await expect(
        root.bootstrap({}, {
          ocapURLIssuerService: mocks.services.ocapURLIssuerService,
          ocapURLRedemptionService: mocks.services.ocapURLRedemptionService,
        } as Services),
      ).rejects.toThrow(/languageModelService is required/u);
    });
  });

  describe('registerServiceByRef', () => {
    it('confirms the token and stores the service without calling the LLM', async () => {
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

      // Registration is purely local; the LLM only sees the registry
      // at query time.
      expect(mocks.lms.chat).not.toHaveBeenCalled();
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

    it('registers successfully even when the LLM is failing', async () => {
      const lms = makeMockLms({
        replyContent: () => {
          throw new Error('gateway down');
        },
      });
      mocks = makeMockServices({ lms });
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const { contact } = makeMockContact({
        description: sampleDescription(),
        expectedToken: 'tok',
      });

      // Registration never touches the LLM, so a broken gateway can't
      // block providers from registering.
      await publicFacet.registerServiceByRef(contact, 'tok');
      expect(root.listAll()).toHaveLength(1);
    });
  });

  describe('description validation', () => {
    it('refuses a description whose apiSpec is malformed, and keeps answering queries', async () => {
      const lms = makeMockLms({
        replyContent: () => '[{"id":"svc:0","rationale":"fits"}]',
      });
      mocks = makeMockServices({ lms });
      await root.bootstrap({}, mocks.services);
      const publicFacet = root.getPublicFacet();
      const bad = makeMockContact({
        description: {
          ...sampleDescription('Bad'),
          apiSpec: {},
        } as unknown as ServiceDescription,
        expectedToken: 'tok-bad',
      });
      const good = makeMockContact({
        description: sampleDescription('Good'),
        expectedToken: 'tok-good',
      });

      await expect(
        publicFacet.registerServiceByRef(bad.contact, 'tok-bad'),
      ).rejects.toThrow(/invalid service description/u);
      await publicFacet.registerServiceByRef(good.contact, 'tok-good');

      expect(
        await publicFacet.findServices({ description: 'anything' }),
      ).toStrictEqual([
        {
          description: sampleDescription('Good'),
          rationale: 'fits',
        },
      ]);
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
    /**
     * Register one sample service so ranking has something to cite.
     *
     * @param description - The service description to register.
     * @returns The registered description.
     */
    async function registerOne(
      description = sampleDescription('Foo'),
    ): Promise<ServiceDescription> {
      const publicFacet = root.getPublicFacet();
      const { contact } = makeMockContact({
        description,
        expectedToken: 't',
      });
      await publicFacet.registerServiceByRef(contact, 't');
      return description;
    }

    it('asks the model and returns whatever services it cites', async () => {
      const lms = makeMockLms({
        // Cite svc:0 (the only one we'll register) on every query.
        replyContent: () => '[{"id":"svc:0","rationale":"because"}]',
      });
      mocks = makeMockServices({ lms });
      await root.bootstrap({}, mocks.services);
      const description = await registerOne();

      const matches = await root.getPublicFacet().findServices({
        description: 'whatever',
      });

      expect(matches).toHaveLength(1);
      expect(matches[0]?.description).toStrictEqual(description);
      expect(matches[0]?.rationale).toBe('because');
    });

    it('answers with the service the prompt described when it is replaced mid-call', async () => {
      const original = sampleDescription('Foo', 'ocap:key1@peerA', 'foo');
      const replacement = sampleDescription('Foo', 'ocap:key2@peerA', 'foo');
      const lms = makeMockLms({
        // While the model is thinking, the same provider re-registers,
        // evicting the svc:0 the prompt carried.
        replyContent: async () => {
          const { contact } = makeMockContact({
            description: replacement,
            expectedToken: 't2',
          });
          await root.getPublicFacet().registerServiceByRef(contact, 't2');
          return '[{"id":"svc:0","rationale":"because"}]';
        },
      });
      mocks = makeMockServices({ lms });
      await root.bootstrap({}, mocks.services);
      await registerOne(original);

      const matches = await root.getPublicFacet().findServices({
        description: 'whatever',
      });

      expect(matches).toStrictEqual([
        { description: original, rationale: 'because' },
      ]);
    });

    it('sends the configured model, the registry digest, and the query', async () => {
      const lms = makeMockLms({
        replyContent: () => '[]',
      });
      mocks = makeMockServices({ lms });
      await root.bootstrap({}, mocks.services);
      const description = await registerOne();

      await root.getPublicFacet().findServices({ description: 'find me foo' });

      const params = lms.lastParams();
      expect(params?.model).toBe(TEST_MODEL);
      expect(params?.messages).toHaveLength(2);
      expect(params?.messages[0]?.role).toBe('system');
      const userContent = params?.messages[1]?.content;
      expect(userContent).toContain('svc:0');
      expect(userContent).toContain(description.description);
      expect(userContent).toContain('find me foo');
    });

    it('returns an empty list without calling the model when nothing is registered', async () => {
      await root.bootstrap({}, mocks.services);
      const matches = await root
        .getPublicFacet()
        .findServices({ description: 'q' });
      expect(matches).toStrictEqual([]);
      expect(mocks.lms.chat).not.toHaveBeenCalled();
    });

    it('returns an empty list when the model cites no services', async () => {
      await root.bootstrap({}, mocks.services);
      await registerOne();
      const matches = await root
        .getPublicFacet()
        .findServices({ description: 'q' });
      expect(matches).toStrictEqual([]);
      expect(mocks.lms.chat).toHaveBeenCalledTimes(1);
    });

    it('skips ids the model cites that do not exist in the registry', async () => {
      const lms = makeMockLms({
        replyContent: () =>
          '[{"id":"svc:0","rationale":"real one"},' +
          '{"id":"svc:nonexistent","rationale":"hallucinated"}]',
      });
      mocks = makeMockServices({ lms });
      await root.bootstrap({}, mocks.services);
      await registerOne();

      const matches = await root
        .getPublicFacet()
        .findServices({ description: 'q' });

      expect(matches).toHaveLength(1);
      expect(matches[0]?.rationale).toBe('real one');
    });

    it('throws when the model cites only unknown ids', async () => {
      const lms = makeMockLms({
        replyContent: () => '[{"id":"svc:999","rationale":"hallucinated"}]',
      });
      mocks = makeMockServices({ lms });
      await root.bootstrap({}, mocks.services);
      await registerOne();

      await expect(
        root.getPublicFacet().findServices({ description: 'q' }),
      ).rejects.toThrow(/cited only unknown ids/u);
    });

    it('propagates LLM errors instead of falling back', async () => {
      const lms = makeMockLms({
        replyContent: () => {
          throw new Error('gateway sad');
        },
      });
      mocks = makeMockServices({ lms });
      await root.bootstrap({}, mocks.services);
      await registerOne();

      await expect(
        root.getPublicFacet().findServices({ description: 'q' }),
      ).rejects.toThrow(/gateway sad/u);
      expect(lms.chat).toHaveBeenCalledTimes(1);
    });

    it('throws when the model reply is not valid match JSON', async () => {
      const lms = makeMockLms({
        replyContent: () => 'Sure! Here are your matches: none.',
      });
      mocks = makeMockServices({ lms });
      await root.bootstrap({}, mocks.services);
      await registerOne();

      await expect(
        root.getPublicFacet().findServices({ description: 'q' }),
      ).rejects.toThrow(/not parseable JSON/u);
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
