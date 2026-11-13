import { GET_INTERFACE_GUARD } from '@endo/exo';
import { M, getInterfaceGuardPayload } from '@endo/patterns';
import { GET_DESCRIPTION } from '@metamask/kernel-utils';
import type { MethodSchema } from '@metamask/kernel-utils';
import { describe, it, expect } from 'vitest';

import { collectSheafGuard } from './guard.ts';
import { constant } from './metadata.ts';
import { makeSection } from './section.ts';
import { sheafify } from './sheafify.ts';
import type {
  Candidate,
  Policy,
  PolicyContext,
  Provider,
  Section,
} from './types.ts';

// Thin cast for calling exo methods directly in tests without going through
// HandledPromise (which is not available in the test environment).
// oxlint-disable-next-line id-length
const E = (obj: unknown) =>
  obj as Record<
    'f' | 'getBalance' | 'transfer' | typeof GET_DESCRIPTION,
    (...args: unknown[]) => Promise<unknown>
  >;

// Sheafify and build a section over the union guard of all providers. Used by
// tests that exercise dispatch behavior without caring which guard variant is
// presented at the call site.
const buildUnionSection = <MetaData extends Record<string, unknown>>(
  name: string,
  providers: Provider<MetaData>[],
  policy: Policy<MetaData>,
  schema?: Record<string, MethodSchema>,
): object => {
  const sheaf = sheafify({ name, providers });
  const guard = collectSheafGuard(
    name,
    providers.map(({ exo }) => exo),
  );
  return schema === undefined
    ? sheaf.getSection({ guard, policy })
    : sheaf.getDiscoverableSection({ guard, policy, schema });
};

// ---------------------------------------------------------------------------
// Unit: sheafify
// ---------------------------------------------------------------------------

describe('sheafify', () => {
  it('single-section bypass: policy not invoked', async () => {
    let policyCalled = false;
    // oxlint-disable-next-line require-yield
    const policy: Policy<{ cost: number }> = async function* (_candidates) {
      policyCalled = true;
      // unreachable — fast path bypasses policy for single section
    };

    const providers: Provider<{ cost: number }>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
        metadata: constant({ cost: 1 }),
      },
    ];

    const wallet = buildUnionSection('Wallet', providers, policy);
    expect(await E(wallet).getBalance('alice')).toBe(42);
    expect(policyCalled).toBe(false);
  });

  it('zero-coverage throws', async () => {
    const providers: Provider<{ cost: number }>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.eq('alice')).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
        metadata: constant({ cost: 1 }),
      },
    ];

    const wallet = buildUnionSection<{ cost: number }>(
      'Wallet',
      providers,

      async function* (_candidates) {
        // unreachable — zero-coverage path throws before reaching policy
      },
    );
    await expect(E(wallet).getBalance('bob')).rejects.toThrow(
      'No section covers',
    );
  });

  it('policy receives metadata and picks winner', async () => {
    const argmin: Policy<{ cost: number }> = async function* (candidates) {
      yield* [...candidates].sort(
        (a, b) =>
          (a.metadata?.cost ?? Infinity) - (b.metadata?.cost ?? Infinity),
      );
    };

    const providers: Provider<{ cost: number }>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ cost: 100 }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
        metadata: constant({ cost: 1 }),
      },
    ];

    const wallet = buildUnionSection('Wallet', providers, argmin);
    // argmin picks cost=1 section which returns 42
    expect(await E(wallet).getBalance('alice')).toBe(42);
  });

  // oxlint-disable-next-line vitest/prefer-lowercase-title
  it('GET_INTERFACE_GUARD returns collected guard', () => {
    const providers: Provider<{ cost: number }>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.eq('alice')).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ cost: 100 }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.eq('bob')).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 50 },
        ),
        metadata: constant({ cost: 1 }),
      },
    ];

    const wallet = buildUnionSection<{ cost: number }>(
      'Wallet',
      providers,
      async function* (candidates) {
        yield candidates[0]!;
      },
    );
    const guard = (wallet as Section)[GET_INTERFACE_GUARD]?.();
    expect(guard).toBeDefined();

    const { methodGuards } = getInterfaceGuardPayload(guard!);
    expect(methodGuards).toHaveProperty('getBalance');
  });

  it('re-sheafification picks up new providers and methods', async () => {
    const argmin: Policy<{ cost: number }> = async function* (candidates) {
      yield* [...candidates].sort(
        (a, b) =>
          (a.metadata?.cost ?? Infinity) - (b.metadata?.cost ?? Infinity),
      );
    };

    const providers: Provider<{ cost: number }>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ cost: 100 }),
      },
    ];

    let wallet = buildUnionSection('Wallet', providers, argmin);
    expect(await E(wallet).getBalance('alice')).toBe(100);

    // Add a cheaper provider with a new method to the providers array, re-sheafify.
    providers.push({
      exo: makeSection(
        'Wallet:1',
        M.interface('Wallet:1', {
          getBalance: M.call(M.string()).returns(M.number()),
          transfer: M.call(M.string(), M.string(), M.number()).returns(
            M.boolean(),
          ),
        }),
        {
          getBalance: (_acct: string) => 42,
          transfer: (_from: string, _to: string, _amt: number) => true,
        },
      ),
      metadata: constant({ cost: 1 }),
    });
    wallet = buildUnionSection('Wallet', providers, argmin);

    // argmin picks the cheaper section
    expect(await E(wallet).getBalance('alice')).toBe(42);
    // New method is available on the re-sheafified facade
    const facade = wallet as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    expect(await E(facade).transfer('alice', 'bob', 10)).toBe(true);
  });

  it('pre-built exo dispatches correctly', async () => {
    const exo = makeSection(
      'bal',
      M.interface('bal', {
        getBalance: M.call(M.string()).returns(M.number()),
      }),
      { getBalance: (_acct: string) => 42 },
    );
    const providers: Provider<{ cost: number }>[] = [
      { exo, metadata: constant({ cost: 1 }) },
    ];

    const wallet = buildUnionSection<{ cost: number }>(
      'Wallet',
      providers,
      async function* (candidates) {
        yield candidates[0]!;
      },
    );
    expect(await E(wallet).getBalance('alice')).toBe(42);
  });

  it('re-sheafification with pre-built exo picks up new methods', async () => {
    const argmin: Policy<{ cost: number }> = async function* (candidates) {
      yield* [...candidates].sort(
        (a, b) =>
          (a.metadata?.cost ?? Infinity) - (b.metadata?.cost ?? Infinity),
      );
    };

    const providers: Provider<{ cost: number }>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ cost: 100 }),
      },
    ];

    let wallet = buildUnionSection('Wallet', providers, argmin);
    expect(await E(wallet).getBalance('alice')).toBe(100);

    // Add a pre-built exo with a cheaper getBalance + new transfer method
    const exo = makeSection(
      'cheap',
      M.interface('cheap', {
        getBalance: M.call(M.string()).returns(M.number()),
        transfer: M.call(M.string(), M.string(), M.number()).returns(
          M.boolean(),
        ),
      }),
      {
        getBalance: (_acct: string) => 42,
        transfer: (_from: string, _to: string, _amt: number) => true,
      },
    );
    providers.push({
      exo,
      metadata: constant({ cost: 1 }),
    });
    wallet = buildUnionSection('Wallet', providers, argmin);

    // argmin picks the cheaper section
    expect(await E(wallet).getBalance('alice')).toBe(42);
    // New method is available on the re-sheafified facade
    const facade = wallet as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    expect(await E(facade).transfer('alice', 'bob', 10)).toBe(true);
  });

  it('guard reflected in GET_INTERFACE_GUARD for pre-built exo', () => {
    const exo = makeSection(
      'bal',
      M.interface('bal', {
        getBalance: M.call(M.string()).returns(M.number()),
      }),
      { getBalance: (_acct: string) => 42 },
    );
    const providers: Provider<{ cost: number }>[] = [
      { exo, metadata: constant({ cost: 1 }) },
    ];

    const wallet = buildUnionSection<{ cost: number }>(
      'Wallet',
      providers,
      async function* (candidates) {
        yield candidates[0]!;
      },
    );
    const guard = (wallet as Section)[GET_INTERFACE_GUARD]?.();
    expect(guard).toBeDefined();

    const { methodGuards } = getInterfaceGuardPayload(guard!);
    expect(methodGuards).toHaveProperty('getBalance');
  });

  it('policy receives constraints in context and only distinguishing metadata', async () => {
    type Meta = { region: string; cost: number };
    let capturedCandidates: Candidate<Partial<Meta>>[] = [];
    let capturedContext: PolicyContext<Meta> | undefined;

    const spy: Policy<Meta> = async function* (candidates, context) {
      capturedCandidates = candidates;
      capturedContext = context;
      yield candidates[0]!;
    };

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ region: 'us', cost: 100 }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
        metadata: constant({ region: 'us', cost: 1 }),
      },
    ];

    const wallet = buildUnionSection('Wallet', providers, spy);
    await E(wallet).getBalance('alice');

    expect(capturedContext).toStrictEqual({
      method: 'getBalance',
      args: ['alice'],
      constraints: { region: 'us' },
    });
    expect(
      capturedCandidates.map((candidate) => candidate.metadata),
    ).toStrictEqual([{ cost: 100 }, { cost: 1 }]);
  });

  it('all-shared metadata yields empty distinguishing metadata', async () => {
    type Meta = { region: string };
    let capturedCandidates: Candidate<Partial<Meta>>[] = [];
    let capturedContext: PolicyContext<Meta> | undefined;

    const spy: Policy<Meta> = async function* (candidates, context) {
      capturedCandidates = candidates;
      capturedContext = context;
      yield candidates[0]!;
    };

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ region: 'us' }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
        metadata: constant({ region: 'us' }),
      },
    ];

    const wallet = buildUnionSection('Wallet', providers, spy);
    await E(wallet).getBalance('alice');

    // Both providers collapsed to one candidate → policy not invoked
    expect(capturedContext).toBeUndefined();
    expect(capturedCandidates).toHaveLength(0);
  });

  it('collapses equivalent providers by metadata', async () => {
    type Meta = { cost: number };
    let policyCalled = false;

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ cost: 1 }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
        metadata: constant({ cost: 1 }),
      },
    ];

    const wallet = buildUnionSection<Meta>(
      'Wallet',
      providers,
      // oxlint-disable-next-line require-yield
      async function* (_candidates) {
        policyCalled = true;
      },
    );
    await E(wallet).getBalance('alice');

    // Both providers have identical metadata → collapsed to one candidate → policy bypassed
    expect(policyCalled).toBe(false);
  });

  it('extracts shared NaN metadata values into constraints', async () => {
    type Meta = { cost: number; priority: number };
    let capturedCandidates: Candidate<Partial<Meta>>[] = [];
    let capturedContext: PolicyContext<Meta> | undefined;

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 0 },
        ),
        metadata: constant({ cost: NaN, priority: 0 }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 0 },
        ),
        metadata: constant({ cost: NaN, priority: 1 }),
      },
    ];

    const wallet = buildUnionSection<Meta>(
      'Wallet',
      providers,
      async function* (candidates, context) {
        capturedCandidates = candidates;
        capturedContext = context;
        yield candidates[0]!;
      },
    );

    await E(wallet).getBalance('alice');

    // NaN is shared across all candidates, so it should be extracted as a constraint
    // — not left as distinguishing metadata in each candidate's options.
    expect(Number.isNaN(capturedContext?.constraints.cost)).toBe(true);
    expect(
      capturedCandidates.map((candidate) => candidate.metadata),
    ).toStrictEqual([{ priority: 0 }, { priority: 1 }]);
  });

  it('does not collapse +0 and -0 metadata as equivalent', async () => {
    type Meta = { cost: number };
    let candidateCount = 0;

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 0 },
        ),
        metadata: constant({ cost: +0 }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 0 },
        ),
        metadata: constant({ cost: -0 }),
      },
    ];

    const wallet = buildUnionSection<Meta>(
      'Wallet',
      providers,
      async function* (candidates) {
        candidateCount = candidates.length;
        yield candidates[0]!;
      },
    );

    await E(wallet).getBalance('alice');
    expect(candidateCount).toBe(2);
  });

  it('does not collapse Infinity and null metadata as equivalent', async () => {
    type Meta = { cost: number | null };
    let candidateCount = 0;

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 0 },
        ),
        metadata: constant({ cost: Infinity }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 0 },
        ),
        metadata: constant({ cost: null }),
      },
    ];

    const wallet = buildUnionSection<Meta>(
      'Wallet',
      providers,
      async function* (candidates) {
        candidateCount = candidates.length;
        yield candidates[0]!;
      },
    );

    await E(wallet).getBalance('alice');
    expect(candidateCount).toBe(2);
  });

  it('collapses no-metadata and empty-object metadata as equivalent', async () => {
    type Meta = Record<string, never>;
    let policyCalled = false;

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
        metadata: constant({}),
      },
    ];

    const wallet = buildUnionSection<Meta>(
      'Wallet',
      providers,
      // oxlint-disable-next-line require-yield
      async function* (_candidates) {
        policyCalled = true;
      },
    );
    await E(wallet).getBalance('alice');

    expect(policyCalled).toBe(false);
  });

  it('mixed providers participate in policy', async () => {
    const argmin: Policy<{ cost: number }> = async function* (candidates) {
      yield* [...candidates].sort(
        (a, b) =>
          (a.metadata?.cost ?? Infinity) - (b.metadata?.cost ?? Infinity),
      );
    };

    const exo = makeSection(
      'cheap',
      M.interface('cheap', {
        getBalance: M.call(M.string()).returns(M.number()),
      }),
      { getBalance: (_acct: string) => 42 },
    );
    const providers: Provider<{ cost: number }>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ cost: 100 }),
      },
      { exo, metadata: constant({ cost: 1 }) },
    ];

    const wallet = buildUnionSection('Wallet', providers, argmin);
    // argmin picks the exo section (cost=1)
    expect(await E(wallet).getBalance('alice')).toBe(42);
  });

  it('getDiscoverableSection exposes __getDescription__ over union guard', async () => {
    const schema = {
      getBalance: {
        description: 'Get account balance.',
        args: { acct: { type: 'string' as const, description: 'Account id.' } },
        returns: { type: 'number' as const, description: 'Balance.' },
      },
    };
    const providers: Provider<Record<string, never>>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
      },
    ];

    const section = buildUnionSection<Record<string, never>>(
      'Wallet',
      providers,
      async function* (candidates) {
        yield candidates[0]!;
      },
      schema,
    );

    expect(E(section)[GET_DESCRIPTION]()).toStrictEqual(schema);
  });

  it('getSection does not expose __getDescription__', () => {
    const providers: Provider<Record<string, never>>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
      },
    ];

    const section = buildUnionSection<Record<string, never>>(
      'Wallet',
      providers,
      async function* (candidates) {
        yield candidates[0]!;
      },
    );

    expect(
      (section as Record<string, unknown>)[GET_DESCRIPTION],
    ).toBeUndefined();
  });

  it('does not drop prototype-named distinguishing metadata keys from stripped candidates', async () => {
    // 'constructor' matches Object.prototype.constructor. Naive `key in constraints`
    // returns true on an empty {} because of the prototype chain, causing the key to be
    // silently dropped from every stripped candidate even though it was never a constraint.
    type Meta = Record<string, unknown>;
    let capturedCandidates: Candidate<Partial<Meta>>[] = [];
    let capturedContext: PolicyContext<Meta> | undefined;

    const spy: Policy<Meta> = async function* (candidates, context) {
      capturedCandidates = candidates;
      capturedContext = context;
      yield candidates[0]!;
    };

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ constructor: 'typeA', cost: 100 }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
        metadata: constant({ constructor: 'typeB', cost: 1 }),
      },
    ];

    const wallet = buildUnionSection('Wallet', providers, spy);
    await E(wallet).getBalance('alice');

    expect(capturedContext).toStrictEqual({
      method: 'getBalance',
      args: ['alice'],
      constraints: {},
    });
    expect(
      capturedCandidates.map((candidate) => candidate.metadata),
    ).toStrictEqual([
      { constructor: 'typeA', cost: 100 },
      { constructor: 'typeB', cost: 1 },
    ]);
  });

  it('does not treat prototype-inherited value as shared when key is absent from some candidates', async () => {
    // Provider A has { constructor: Object, cost: 100 }. Provider B has { cost: 1 }.
    // Naive `key in meta` finds 'constructor' in B via Object.prototype, and
    // Object.is(meta_B['constructor'], Object) is true ({}.constructor === Object),
    // so the key is wrongly counted as shared and moved into constraints.
    type Meta = Record<string, unknown>;
    let capturedContext: PolicyContext<Meta> | undefined;

    const spy: Policy<Meta> = async function* (candidates, context) {
      capturedContext = context;
      yield candidates[0]!;
    };

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 100 },
        ),
        metadata: constant({ constructor: Object, cost: 100 }),
      },
      {
        exo: makeSection(
          'Wallet:1',
          M.interface('Wallet:1', {
            getBalance: M.call(M.string()).returns(M.number()),
          }),
          { getBalance: (_acct: string) => 42 },
        ),
        metadata: constant({ cost: 1 }),
      },
    ];

    const wallet = buildUnionSection('Wallet', providers, spy);
    await E(wallet).getBalance('alice');

    // 'constructor' is only owned by provider A — must not appear in constraints
    expect(capturedContext?.constraints).not.toHaveProperty('constructor');
  });
});

// ---------------------------------------------------------------------------
// Unit: getSection with explicit guard
// ---------------------------------------------------------------------------

describe('getSection with explicit guard', () => {
  it('dispatches calls that fall within the explicit guard', async () => {
    const providers: Provider<Record<string, never>>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
            transfer: M.call(M.string(), M.number()).returns(M.boolean()),
          }),
          {
            getBalance: (_acct: string) => 42,
            transfer: (_to: string, _amt: number) => true,
          },
        ),
      },
    ];

    const readGuard = M.interface('ReadOnly', {
      getBalance: M.call(M.string()).returns(M.number()),
    });

    const section = sheafify({ name: 'Wallet', providers }).getSection({
      guard: readGuard,
      async *policy(candidates) {
        yield candidates[0]!;
      },
    });

    expect(await E(section).getBalance('alice')).toBe(42);
  });

  it('rejects method calls outside the explicit guard', async () => {
    const providers: Provider<Record<string, never>>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
            transfer: M.call(M.string(), M.number()).returns(M.boolean()),
          }),
          {
            getBalance: (_acct: string) => 42,
            transfer: (_to: string, _amt: number) => true,
          },
        ),
      },
    ];

    const readGuard = M.interface('ReadOnly', {
      getBalance: M.call(M.string()).returns(M.number()),
    });

    const section = sheafify({ name: 'Wallet', providers }).getSection({
      guard: readGuard,
      async *policy(candidates) {
        yield candidates[0]!;
      },
    });

    // makeExo only places methods from the guard on the object — transfer is absent
    expect((section as Record<string, unknown>).transfer).toBeUndefined();
  });

  it('getDiscoverableSection exposes __getDescription__ and obeys explicit guard', async () => {
    const providers: Provider<Record<string, never>>[] = [
      {
        exo: makeSection(
          'Wallet:0',
          M.interface('Wallet:0', {
            getBalance: M.call(M.string()).returns(M.number()),
            transfer: M.call(M.string(), M.number()).returns(M.boolean()),
          }),
          {
            getBalance: (_acct: string) => 42,
            transfer: (_to: string, _amt: number) => true,
          },
        ),
      },
    ];

    const readGuard = M.interface('ReadOnly', {
      getBalance: M.call(M.string()).returns(M.number()),
    });

    const schema = {
      getBalance: { description: 'Get account balance.', args: {} },
    };

    const section = sheafify({
      name: 'Wallet',
      providers,
    }).getDiscoverableSection({
      guard: readGuard,
      async *policy(candidates) {
        yield candidates[0]!;
      },
      schema,
    });

    expect(E(section)[GET_DESCRIPTION]()).toStrictEqual(schema);
    expect(await E(section).getBalance('alice')).toBe(42);
  });

  it('does not collapse -Infinity and Infinity metadata as equivalent', async () => {
    type Meta = { cost: number };
    let candidateCount = 0;

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'W:0',
          M.interface('W:0', {
            f: M.call(M.string()).returns(M.number()),
          }),
          { f: (_acct: string) => 0 },
        ),
        metadata: constant({ cost: -Infinity }),
      },
      {
        exo: makeSection(
          'W:1',
          M.interface('W:1', {
            f: M.call(M.string()).returns(M.number()),
          }),
          { f: (_acct: string) => 0 },
        ),
        metadata: constant({ cost: Infinity }),
      },
    ];

    const wallet = buildUnionSection<Meta>(
      'W',
      providers,
      async function* (candidates) {
        candidateCount = candidates.length;
        yield candidates[0]!;
      },
    );

    await E(wallet).f('alice');
    expect(candidateCount).toBe(2);
  });

  it('does not collapse undefined and null metadata values as equivalent', async () => {
    type Meta = { tag: string | null | undefined };
    let candidateCount = 0;

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'W:0',
          M.interface('W:0', {
            f: M.call(M.string()).returns(M.number()),
          }),
          { f: (_acct: string) => 0 },
        ),
        metadata: constant({ tag: undefined }),
      },
      {
        exo: makeSection(
          'W:1',
          M.interface('W:1', {
            f: M.call(M.string()).returns(M.number()),
          }),
          { f: (_acct: string) => 0 },
        ),
        metadata: constant({ tag: null }),
      },
    ];

    const wallet = buildUnionSection<Meta>(
      'W',
      providers,
      async function* (candidates) {
        candidateCount = candidates.length;
        yield candidates[0]!;
      },
    );

    await E(wallet).f('alice');
    expect(candidateCount).toBe(2);
  });

  it('does not collapse bigint and equal-magnitude number metadata as equivalent', async () => {
    type Meta = { weight: bigint | number };
    let candidateCount = 0;

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'W:0',
          M.interface('W:0', {
            f: M.call(M.string()).returns(M.number()),
          }),
          { f: (_acct: string) => 0 },
        ),
        metadata: constant({ weight: 1n }),
      },
      {
        exo: makeSection(
          'W:1',
          M.interface('W:1', {
            f: M.call(M.string()).returns(M.number()),
          }),
          { f: (_acct: string) => 0 },
        ),
        metadata: constant({ weight: 1 }),
      },
    ];

    const wallet = buildUnionSection<Meta>(
      'W',
      providers,
      async function* (candidates) {
        candidateCount = candidates.length;
        yield candidates[0]!;
      },
    );

    await E(wallet).f('alice');
    expect(candidateCount).toBe(2);
  });

  it('throws when a section advertises a method via guard but has no handler', async () => {
    const fakeGuard = M.interface('Faux', {
      f: M.call(M.string()).returns(M.string()),
    });
    const handlerlessSection: Section = {
      [GET_INTERFACE_GUARD]: () => fakeGuard,
    };
    const providers: Provider<Record<string, never>>[] = [
      { exo: handlerlessSection },
    ];

    const wallet = buildUnionSection<Record<string, never>>(
      'Faux',
      providers,
      async function* (candidates) {
        yield candidates[0]!;
      },
    );

    await expect(E(wallet).f('x')).rejects.toThrow(
      "Section has guard for 'f' but no handler",
    );
  });

  it('throws "No section covers" when explicit guard admits args no provider matches', async () => {
    const providers: Provider<Record<string, never>>[] = [
      {
        exo: makeSection(
          'W:0',
          M.interface('W:0', {
            f: M.call(M.eq('alice')).returns(M.number()),
          }),
          { f: (_acct: string) => 42 },
        ),
      },
    ];

    const wideGuard = M.interface('Wide', {
      f: M.call(M.string()).returns(M.number()),
    });

    const section = sheafify({ name: 'W', providers }).getSection({
      guard: wideGuard,
      async *policy(candidates) {
        yield candidates[0]!;
      },
    });

    await expect(E(section).f('bob')).rejects.toThrow('No section covers');
  });

  it('throws when policy yields a candidate object not from the candidates array', async () => {
    type Meta = { tier: string };

    const providers: Provider<Meta>[] = [
      {
        exo: makeSection(
          'W:0',
          M.interface('W:0', {
            f: M.call(M.string()).returns(M.number()),
          }),
          { f: (_acct: string) => 1 },
        ),
        metadata: constant({ tier: 'a' }),
      },
      {
        exo: makeSection(
          'W:1',
          M.interface('W:1', {
            f: M.call(M.string()).returns(M.number()),
          }),
          { f: (_acct: string) => 2 },
        ),
        metadata: constant({ tier: 'b' }),
      },
    ];

    const wallet = buildUnionSection<Meta>(
      'W',
      providers,

      async function* (candidates) {
        // structurally equivalent but not the same object reference
        yield { ...candidates[0]! };
      },
    );

    await expect(E(wallet).f('alice')).rejects.toThrow(
      'unrecognized candidate',
    );
  });
});
