import { M, getMethodGuardPayload, matches } from '@endo/patterns';
import type { InterfaceGuard } from '@endo/patterns';
import { describe, it, expect } from 'vitest';

import { getInterfaceMethodGuards, getMethodPayload } from './guard-algebra.ts';
import type { MethodGuardPayload } from './guard-algebra.ts';
import { narrowInterfaceGuard } from './narrow-interface-guard.ts';
import type { NarrowingDelta } from './narrow-interface-guard.ts';

// One fixture reaching all three positional categories.
const makeBaseGuard = (): InterfaceGuard =>
  M.interface('Store', {
    read: M.callWhen(M.string()).optional(M.number()).returns(M.any()),
    write: M.callWhen(M.string()).rest(M.number()).returns(M.any()),
    drop: M.callWhen(M.string()).returns(M.any()),
  });

const payloadOf = (guard: InterfaceGuard, method: string): MethodGuardPayload =>
  getMethodPayload(getInterfaceMethodGuards(guard)[method]!);

const narrowFrom = (
  baseGuard: InterfaceGuard,
  delta: NarrowingDelta,
): InterfaceGuard =>
  narrowInterfaceGuard({ name: 'Narrowed', baseGuard, delta });

describe('narrowInterfaceGuard', () => {
  it('drops methods the delta does not name', () => {
    const result = narrowFrom(makeBaseGuard(), { read: [] });

    expect(Object.keys(getInterfaceMethodGuards(result))).toStrictEqual([
      'read',
    ]);
  });

  it('drops every method given an empty delta', () => {
    const result = narrowFrom(makeBaseGuard(), {});

    expect(getInterfaceMethodGuards(result)).toStrictEqual({});
  });

  it('leaves a method as the base has it when its delta is empty', () => {
    const baseGuard = makeBaseGuard();

    const result = narrowFrom(baseGuard, { read: [] });

    expect(payloadOf(result, 'read')).toStrictEqual(
      payloadOf(baseGuard, 'read'),
    );
  });

  it('conjoins a pattern onto a required argument', () => {
    const result = narrowFrom(makeBaseGuard(), { read: [M.eq('a')] });
    const [argGuard] = payloadOf(result, 'read').argGuards;

    expect(matches('a', argGuard)).toBe(true);
    expect(matches('b', argGuard)).toBe(false);
    expect(matches(1, argGuard)).toBe(false);
  });

  it('leaves positions the delta does not reach as the base has them', () => {
    const baseGuard = makeBaseGuard();

    const result = narrowFrom(baseGuard, { read: [M.eq('a')] });

    expect(payloadOf(result, 'read').optionalArgGuards).toStrictEqual(
      payloadOf(baseGuard, 'read').optionalArgGuards,
    );
  });

  it('conjoins onto an optional argument without making it required', () => {
    const baseGuard = makeBaseGuard();

    const result = narrowFrom(baseGuard, { read: [undefined, M.lte(10)] });
    const { argGuards, optionalArgGuards } = payloadOf(result, 'read');

    expect(argGuards).toStrictEqual(payloadOf(baseGuard, 'read').argGuards);
    expect(matches(5, optionalArgGuards![0])).toBe(true);
    expect(matches(20, optionalArgGuards![0])).toBe(false);
  });

  it('conjoins onto the rest guard past the fixed arity', () => {
    const baseGuard = makeBaseGuard();

    const result = narrowFrom(baseGuard, { write: [undefined, M.lte(10)] });
    const { argGuards, restArgGuard } = payloadOf(result, 'write');

    expect(argGuards).toStrictEqual(payloadOf(baseGuard, 'write').argGuards);
    expect(matches(5, restArgGuard)).toBe(true);
    expect(matches(20, restArgGuard)).toBe(false);
  });

  it('inherits the return guard verbatim', () => {
    const baseGuard = makeBaseGuard();

    const result = narrowFrom(baseGuard, { read: [M.eq('a')] });

    expect(payloadOf(result, 'read').returnGuard).toBe(
      payloadOf(baseGuard, 'read').returnGuard,
    );
  });

  it('asyncifies a synchronous method guard', () => {
    const baseGuard = M.interface('Sync', {
      read: M.call(M.string()).returns(M.any()),
    });

    const result = narrowFrom(baseGuard, { read: [] });
    const { callKind } = getMethodGuardPayload(
      getInterfaceMethodGuards(result).read!,
    );

    expect(callKind).toBe('async');
  });

  it.each([
    {
      scenario: 'names a method the base does not have',
      makeGuard: makeBaseGuard,
      delta: { missing: [] },
      message: 'the base has no such method',
    },
    {
      scenario:
        'addresses a position past the arity of a base without a rest guard',
      makeGuard: makeBaseGuard,
      delta: { drop: [undefined, M.eq('x')] },
      message: 'the base has arity 1 and no rest guard',
    },
    {
      scenario: 'narrows a method the base guards by default',
      makeGuard: () => M.interface('Any', {}, { defaultGuards: 'passable' }),
      delta: { read: [M.eq('a')] },
      message: 'there is no guard to conjoin onto',
    },
  ])('rejects a delta that $scenario', ({ makeGuard, delta, message }) => {
    expect(() => narrowFrom(makeGuard(), delta)).toThrow(message);
  });
});
