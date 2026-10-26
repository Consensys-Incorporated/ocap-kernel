import { M } from '@endo/patterns';
import type { MethodGuard } from '@endo/patterns';
import { describe, it, expect } from 'vitest';

import { getMatchingProviders } from './match.ts';
import { constant } from './metadata.ts';
import { makeSection } from './section.ts';
import type { Provider } from './types.ts';

const makeProvider = (
  tag: string,
  guards: Record<string, MethodGuard>,
  methods: Record<string, CallableFunction>,
  metadata: { cost: number },
): Provider<{ cost: number }> => ({
  exo: makeSection(tag, M.interface(tag, guards), methods),
  metadata: constant(metadata),
});

describe('getMatchingProviders', () => {
  it('returns matching providers for a method and args', () => {
    const providers = [
      makeProvider(
        'A',
        { add: M.call(M.number(), M.number()).returns(M.number()) },
        { add: (a: number, b: number) => a + b },
        { cost: 1 },
      ),
      makeProvider(
        'B',
        { add: M.call(M.number(), M.number()).returns(M.number()) },
        { add: (a: number, b: number) => a + b },
        { cost: 2 },
      ),
    ];

    const candidates = getMatchingProviders(providers, 'add', [1, 2]);
    expect(candidates).toHaveLength(2);
  });

  it('filters out providers without matching method', () => {
    const providers = [
      makeProvider(
        'A',
        { add: M.call(M.number()).returns(M.number()) },
        { add: (a: number) => a },
        { cost: 1 },
      ),
      makeProvider(
        'B',
        { sub: M.call(M.number()).returns(M.number()) },
        { sub: (a: number) => -a },
        { cost: 2 },
      ),
    ];

    const candidates = getMatchingProviders(providers, 'add', [1]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.metadata).toStrictEqual(constant({ cost: 1 }));
  });

  it('filters out providers with arg count mismatch', () => {
    const providers = [
      makeProvider(
        'A',
        { add: M.call(M.number(), M.number()).returns(M.number()) },
        { add: (a: number, b: number) => a + b },
        { cost: 1 },
      ),
    ];

    const candidates = getMatchingProviders(providers, 'add', [1]);
    expect(candidates).toHaveLength(0);
  });

  it('filters out providers with arg type mismatch', () => {
    const providers = [
      makeProvider(
        'A',
        { add: M.call(M.number()).returns(M.number()) },
        { add: (a: number) => a },
        { cost: 1 },
      ),
    ];

    const candidates = getMatchingProviders(providers, 'add', ['not-a-number']);
    expect(candidates).toHaveLength(0);
  });

  it('returns empty array when no providers match', () => {
    const providers = [
      makeProvider(
        'A',
        { add: M.call(M.eq('alice')).returns(M.number()) },
        { add: (_a: string) => 42 },
        { cost: 1 },
      ),
    ];

    const candidates = getMatchingProviders(providers, 'add', ['bob']);
    expect(candidates).toHaveLength(0);
  });

  it('matches providers with optional args when optional arg is provided', () => {
    const providers = [
      makeProvider(
        'A',
        {
          greet: M.callWhen(M.string())
            .optional(M.string())
            .returns(M.string()),
        },
        { greet: (name: string, _greeting?: string) => `hello ${name}` },
        { cost: 1 },
      ),
    ];

    expect(getMatchingProviders(providers, 'greet', ['alice'])).toHaveLength(1);
    expect(
      getMatchingProviders(providers, 'greet', ['alice', 'hi']),
    ).toHaveLength(1);
    expect(getMatchingProviders(providers, 'greet', [])).toHaveLength(0);
    expect(
      getMatchingProviders(providers, 'greet', ['alice', 'hi', 'extra']),
    ).toHaveLength(0);
  });

  it('matches providers with rest args', () => {
    const providers = [
      makeProvider(
        'A',
        { log: M.call(M.string()).rest(M.string()).returns(M.any()) },
        { log: (..._args: string[]) => undefined },
        { cost: 1 },
      ),
    ];

    expect(getMatchingProviders(providers, 'log', ['info'])).toHaveLength(1);
    expect(
      getMatchingProviders(providers, 'log', ['info', 'msg']),
    ).toHaveLength(1);
    expect(
      getMatchingProviders(providers, 'log', ['info', 'msg', 'extra']),
    ).toHaveLength(1);
    expect(getMatchingProviders(providers, 'log', [])).toHaveLength(0);
    expect(getMatchingProviders(providers, 'log', [42])).toHaveLength(0);
  });

  it('filters out providers without an interface guard', () => {
    const guarded = makeProvider(
      'A',
      { add: M.call(M.number()).returns(M.number()) },
      { add: (a: number) => a },
      { cost: 1 },
    );
    const guardless: Provider<{ cost: number }> = {
      exo: { add: (_a: number) => 0 },
      metadata: constant({ cost: 2 }),
    };

    const candidates = getMatchingProviders([guardless, guarded], 'add', [1]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toBe(guarded);
  });

  it('returns all providers when all match', () => {
    const providers = [
      makeProvider(
        'A',
        { f: M.call(M.string()).returns(M.number()) },
        { f: () => 1 },
        { cost: 1 },
      ),
      makeProvider(
        'B',
        { f: M.call(M.string()).returns(M.number()) },
        { f: () => 2 },
        { cost: 2 },
      ),
      makeProvider(
        'C',
        { f: M.call(M.string()).returns(M.number()) },
        { f: () => 3 },
        { cost: 3 },
      ),
    ];

    const candidates = getMatchingProviders(providers, 'f', ['hello']);
    expect(candidates).toHaveLength(3);
  });
});
