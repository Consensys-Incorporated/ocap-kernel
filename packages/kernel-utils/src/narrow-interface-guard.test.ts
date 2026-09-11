import { M, getMethodGuardPayload, matches } from '@endo/patterns';
import type { InterfaceGuard } from '@endo/patterns';
import { describe, it, expect } from 'vitest';

import { getInterfaceMethodGuards, getMethodPayload } from './guard-algebra.ts';
import type { MethodGuardPayload } from './guard-algebra.ts';
import {
  conjoinDeltas,
  disjoinDeltas,
  narrowInterfaceGuard,
} from './narrow-interface-guard.ts';
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
      scenario: 'narrows a method the base guards with raw defaults',
      makeGuard: () => M.interface('Raw', {}, { defaultGuards: 'raw' }),
      delta: { read: [M.eq('a')] },
      message: 'there is no guard to conjoin onto',
    },
  ])('rejects a delta that $scenario', ({ makeGuard, delta, message }) => {
    expect(() => narrowFrom(makeGuard(), delta)).toThrow(message);
  });
});

describe('narrowInterfaceGuard, against a default-guarded base', () => {
  const makePassableGuard = (): InterfaceGuard =>
    M.interface('Any', {}, { defaultGuards: 'passable' });

  it('synthesizes a guard from the delta alone', () => {
    const result = narrowFrom(makePassableGuard(), { read: [M.eq('a')] });
    const { argGuards, restArgGuard } = payloadOf(result, 'read');

    expect(matches('a', argGuards[0])).toBe(true);
    expect(matches('b', argGuards[0])).toBe(false);
    expect(matches('anything', restArgGuard)).toBe(true);
  });

  it('leaves a method unconstrained when its delta is empty', () => {
    const result = narrowFrom(makePassableGuard(), { read: [] });
    const { argGuards, optionalArgGuards, restArgGuard } = payloadOf(
      result,
      'read',
    );

    expect(argGuards).toStrictEqual([]);
    expect(optionalArgGuards ?? []).toStrictEqual([]);
    expect(matches('anything', restArgGuard)).toBe(true);
    expect(matches(42, restArgGuard)).toBe(true);
  });

  it('treats a hole as unconstrained', () => {
    const result = narrowFrom(makePassableGuard(), {
      read: [undefined, M.eq('x')],
    });
    const { argGuards } = payloadOf(result, 'read');

    expect(matches(42, argGuards[0])).toBe(true);
    expect(matches('x', argGuards[1])).toBe(true);
    expect(matches('y', argGuards[1])).toBe(false);
  });

  it('still drops methods the delta does not name', () => {
    const result = narrowFrom(makePassableGuard(), {});

    expect(getInterfaceMethodGuards(result)).toStrictEqual({});
  });
});

describe('conjoinDeltas', () => {
  it('keeps only the methods the incoming delta names', () => {
    const combined = conjoinDeltas({ read: [], write: [] }, { read: [] });

    expect(combined).toStrictEqual({ read: [] });
  });

  it('does not reinstate a method the existing delta dropped', () => {
    expect(() => conjoinDeltas({ read: [] }, { write: [] })).toThrow(
      'Cannot narrow method "write": the base has no such method.',
    );
  });

  it('conjoins both patterns where the two deltas overlap', () => {
    const combined = conjoinDeltas({ read: [M.lte(10)] }, { read: [M.gte(5)] });
    const [pattern] = combined.read!;

    expect(matches(7, pattern)).toBe(true);
    expect(matches(2, pattern)).toBe(false);
    expect(matches(20, pattern)).toBe(false);
  });

  it.each([
    { side: 'the existing delta', existing: [M.lte(10)], incoming: [] },
    { side: 'the incoming delta', existing: [], incoming: [M.lte(10)] },
  ])('carries a pattern held only by $side', ({ existing, incoming }) => {
    const combined = conjoinDeltas({ read: existing }, { read: incoming });
    const [pattern] = combined.read!;

    expect(matches(7, pattern)).toBe(true);
    expect(matches(20, pattern)).toBe(false);
  });

  it('leaves a position both deltas hole as unconstrained', () => {
    const combined = conjoinDeltas(
      { read: [undefined, M.lte(10)] },
      { read: [undefined] },
    );

    expect(combined.read![0]).toBeUndefined();
  });
});

describe('disjoinDeltas', () => {
  it('takes the union of the methods the two deltas name', () => {
    const disjoined = disjoinDeltas(
      { read: [M.eq('a')] },
      { read: [M.eq('b')], stat: [M.eq('b')] },
    );

    expect(Object.keys(disjoined).sort()).toStrictEqual(['read', 'stat']);
  });

  it('admits either pattern where both deltas name a method', () => {
    const disjoined = disjoinDeltas(
      { read: [M.eq('a')] },
      { read: [M.eq('b')] },
    );
    const [pattern] = disjoined.read!;

    expect(matches('a', pattern)).toBe(true);
    expect(matches('b', pattern)).toBe(true);
    expect(matches('c', pattern)).toBe(false);
  });

  it('carries a method only one delta names at that delta', () => {
    const disjoined = disjoinDeltas({ read: [] }, { stat: [M.eq('b')] });
    const [pattern] = disjoined.stat!;

    expect(matches('b', pattern)).toBe(true);
    expect(matches('a', pattern)).toBe(false);
  });

  it.each([
    { side: 'the left', left: [undefined], right: [M.eq('b')] },
    { side: 'the right', left: [M.eq('a')], right: [undefined] },
    { side: 'the shorter', left: [M.eq('a')], right: [M.eq('a'), M.eq('x')] },
  ])(
    'leaves a position unconstrained where $side delta holes it',
    ({ left, right }) => {
      const disjoined = disjoinDeltas({ read: left }, { read: right });

      expect(disjoined.read!.at(-1)).toBeUndefined();
    },
  );
});
