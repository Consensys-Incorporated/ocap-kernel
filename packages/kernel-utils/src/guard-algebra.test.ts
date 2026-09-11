import { M, getMethodGuardPayload, matches } from '@endo/patterns';
import type { Pattern } from '@endo/patterns';
import { describe, it, expect } from 'vitest';

import {
  asyncifyMethodGuards,
  buildMethodGuard,
  getGuardAt,
  getInterfaceMethodGuards,
  getMethodPayload,
} from './guard-algebra.ts';
import type { MethodGuardPayload } from './guard-algebra.ts';

const makePayload = (): {
  payload: MethodGuardPayload;
  argGuard: Pattern;
  optionalGuard: Pattern;
  restGuard: Pattern;
} => {
  const argGuard = M.string();
  const optionalGuard = M.number();
  const restGuard = M.any();
  return {
    payload: {
      argGuards: [argGuard],
      optionalArgGuards: [optionalGuard],
      restArgGuard: restGuard,
      returnGuard: M.any(),
    },
    argGuard,
    optionalGuard,
    restGuard,
  };
};

describe('getInterfaceMethodGuards', () => {
  it('returns the method guards of an interface guard', () => {
    const guard = M.interface('Calc', {
      add: M.call(M.number(), M.number()).returns(M.number()),
      negate: M.call(M.number()).returns(M.number()),
    });

    expect(Object.keys(getInterfaceMethodGuards(guard)).sort()).toStrictEqual([
      'add',
      'negate',
    ]);
  });

  it('returns an empty map for a default-guarded interface', () => {
    const guard = M.interface('Any', {}, { defaultGuards: 'passable' });

    expect(getInterfaceMethodGuards(guard)).toStrictEqual({});
  });
});

describe('getMethodPayload', () => {
  it('returns the argument and return guard components', () => {
    const methodGuard = M.call(M.string())
      .optional(M.number())
      .rest(M.string())
      .returns(M.eq(0));
    const { argGuards, optionalArgGuards, restArgGuard, returnGuard } =
      getMethodPayload(methodGuard);

    expect(argGuards).toHaveLength(1);
    expect(optionalArgGuards).toHaveLength(1);
    expect(matches('rest', restArgGuard)).toBe(true);
    expect(matches(0, returnGuard)).toBe(true);
  });
});

describe('getGuardAt', () => {
  type GuardKey = 'argGuard' | 'optionalGuard' | 'restGuard';

  it.each<[number, GuardKey]>([
    [0, 'argGuard'],
    [1, 'optionalGuard'],
    [2, 'restGuard'],
    [7, 'restGuard'],
  ])('reads position %i as the %s', (idx, key) => {
    const fixture = makePayload();

    expect(getGuardAt(fixture.payload, idx)).toBe(fixture[key]);
  });

  it('returns undefined past the arity of a payload without a rest guard', () => {
    const payload: MethodGuardPayload = {
      argGuards: [M.string()],
      returnGuard: M.any(),
    };

    expect(getGuardAt(payload, 1)).toBeUndefined();
  });
});

describe('buildMethodGuard', () => {
  it.each([
    { shape: 'required args only', optionals: 0, rest: false },
    { shape: 'optional args', optionals: 1, rest: false },
    { shape: 'a rest guard', optionals: 0, rest: true },
    { shape: 'optional args and a rest guard', optionals: 1, rest: true },
  ])('assembles a guard with $shape', ({ optionals, rest }) => {
    const optionalGuards = Array.from({ length: optionals }, () => M.number());

    const methodGuard = buildMethodGuard(
      M.callWhen(M.string()),
      optionalGuards,
      rest ? M.any() : undefined,
      M.any(),
    );
    const payload = getMethodPayload(methodGuard);

    expect(payload.argGuards).toHaveLength(1);
    expect(payload.optionalArgGuards ?? []).toHaveLength(optionals);
    expect(payload.restArgGuard === undefined).toBe(!rest);
  });
});

describe('asyncifyMethodGuards', () => {
  it('upgrades sync method guards for async dispatch', () => {
    const guard = M.interface('Calc', {
      add: M.call(M.number()).returns(M.number()),
    });

    const { add } = asyncifyMethodGuards(guard);
    const { callKind } = getMethodGuardPayload(add!);

    expect(callKind).toBe('async');
  });

  it('preserves argument positions and return guards', () => {
    const guard = M.interface('Logger', {
      log: M.call(M.string())
        .optional(M.number())
        .rest(M.any())
        .returns(M.eq(0)),
    });

    const { log } = asyncifyMethodGuards(guard);
    const { argGuards, optionalArgGuards, restArgGuard, returnGuard } =
      getMethodPayload(log!);

    expect(argGuards).toHaveLength(1);
    expect(optionalArgGuards).toHaveLength(1);
    expect(restArgGuard).toBeDefined();
    expect(matches(0, returnGuard)).toBe(true);
  });
});
