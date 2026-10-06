import { M, getMethodGuardPayload, matches } from '@endo/patterns';
import type { InterfaceGuard, Pattern } from '@endo/patterns';
import { describe, it, expect } from 'vitest';

import { getInterfaceMethodGuards, getMethodPayload } from './guard-algebra.ts';
import type { MethodGuardPayload } from './guard-algebra.ts';
import {
  conjoinDeltas,
  disjoinDeltas,
  makeAbsorbingDelta,
  narrowInterfaceGuard,
  toDisjunctiveDelta,
} from './narrow-interface-guard.ts';
import type {
  DisjunctiveDelta,
  NarrowingDelta,
} from './narrow-interface-guard.ts';

// One fixture reaching all three positional categories.
const makeBaseGuard = (): InterfaceGuard =>
  M.interface('Store', {
    read: M.callWhen(M.string()).optional(M.number()).returns(M.any()),
    write: M.callWhen(M.string()).rest(M.number()).returns(M.any()),
    drop: M.callWhen(M.string()).returns(M.any()),
  });

const payloadOf = (guard: InterfaceGuard, method: string): MethodGuardPayload =>
  getMethodPayload(getInterfaceMethodGuards(guard)[method]!);

const narrowRowsFrom = (
  baseGuard: InterfaceGuard,
  delta: DisjunctiveDelta,
): InterfaceGuard =>
  narrowInterfaceGuard({ name: 'Narrowed', baseGuard, delta });

const narrowFrom = (
  baseGuard: InterfaceGuard,
  delta: NarrowingDelta,
): InterfaceGuard => narrowRowsFrom(baseGuard, toDisjunctiveDelta(delta));

/**
 * Check a call against a method guard as `@endo/exo` does: the whole argument
 * array against `M.splitArray` of the guard's positions, and, without a rest
 * guard, the count against the fixed arity.
 *
 * @param guard - The interface guard.
 * @param method - The method called.
 * @param args - The call's arguments.
 * @returns Whether the guard admits the call.
 */
const admits = (
  guard: InterfaceGuard,
  method: string,
  args: unknown[],
): boolean => {
  const {
    argGuards,
    optionalArgGuards = [],
    restArgGuard,
  } = payloadOf(guard, method);
  return (
    matches(
      harden(args),
      M.splitArray(argGuards, optionalArgGuards, restArgGuard),
    ) &&
    (restArgGuard !== undefined ||
      args.length <= argGuards.length + optionalArgGuards.length)
  );
};

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

  it('renders one row positionally', () => {
    const result = narrowFrom(makeBaseGuard(), {
      read: [M.eq('a'), M.lte(10)],
    });

    expect(getInterfaceMethodGuards(result).read).toStrictEqual(
      M.callWhen(M.and(M.string(), M.eq('a')))
        .optional(M.and(M.number(), M.lte(10)))
        .returns(M.any()),
    );
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

  it('does not require a position behind a trailing hole', () => {
    const result = narrowFrom(makePassableGuard(), {
      read: [M.eq('x'), undefined],
    });

    expect(payloadOf(result, 'read').argGuards).toHaveLength(1);
  });

  // A join pads the shorter delta with holes, which must not demand arguments
  // that operand never required.
  it('requires no more arguments under a join than either operand', () => {
    const result = narrowRowsFrom(
      makePassableGuard(),
      disjoinDeltas(
        { read: [[M.string()]] },
        { read: [[M.string(), M.number()]] },
      ),
    );

    expect(admits(result, 'read', ['x'])).toBe(true);
    expect(admits(result, 'read', ['x', 'anything'])).toBe(true);
    expect(admits(result, 'read', [])).toBe(false);
  });

  it('admits what any row admits and nothing else', () => {
    const result = narrowRowsFrom(makePassableGuard(), {
      read: [
        [M.eq('a'), M.eq(1)],
        [M.eq('b'), undefined],
      ],
    });

    expect(admits(result, 'read', ['a', 1])).toBe(true);
    expect(admits(result, 'read', ['a', 1, 'more'])).toBe(true);
    expect(admits(result, 'read', ['b'])).toBe(true);
    expect(admits(result, 'read', ['b', 'anything'])).toBe(true);
    expect(admits(result, 'read', ['a'])).toBe(false);
    expect(admits(result, 'read', ['a', 2])).toBe(false);
    expect(admits(result, 'read', ['c'])).toBe(false);
  });
});

describe('narrowInterfaceGuard, with several rows', () => {
  const under = (segment: string): Pattern =>
    M.splitArray([M.eq(segment)], [], M.arrayOf(M.string()));

  const makeCopyGuard = (): InterfaceGuard =>
    M.interface('Fs', {
      copy: M.call(M.arrayOf(M.string()), M.arrayOf(M.string())).returns(
        M.string(),
      ),
    });

  it('renders no fixed arguments and a rest guard over the rows', () => {
    const result = narrowRowsFrom(makeCopyGuard(), {
      copy: [[under('data')], [under('logs')]],
    });
    const { argGuards, optionalArgGuards, restArgGuard, returnGuard } =
      payloadOf(result, 'copy');

    expect(argGuards).toStrictEqual([]);
    expect(optionalArgGuards ?? []).toStrictEqual([]);
    expect(restArgGuard).toBeDefined();
    expect(returnGuard).toStrictEqual(M.string());
  });

  it('asyncifies the rendered guard', () => {
    const result = narrowRowsFrom(makeCopyGuard(), {
      copy: [[under('data')], [under('logs')]],
    });
    const { callKind } = getMethodGuardPayload(
      getInterfaceMethodGuards(result).copy!,
    );

    expect(callKind).toBe('async');
  });

  it.each([
    {
      args: [
        ['data', 'x'],
        ['data', 'y'],
      ],
      expected: true,
    },
    {
      args: [
        ['logs', 'x'],
        ['logs', 'y'],
      ],
      expected: true,
    },
    {
      args: [
        ['data', 'x'],
        ['logs', 'y'],
      ],
      expected: false,
    },
    {
      args: [
        ['logs', 'x'],
        ['data', 'y'],
      ],
      expected: false,
    },
  ])(
    'admits copy$args only within one row: $expected',
    ({ args, expected }) => {
      const result = narrowRowsFrom(makeCopyGuard(), {
        copy: [
          [under('data'), under('data')],
          [under('logs'), under('logs')],
        ],
      });

      expect(admits(result, 'copy', args)).toBe(expected);
    },
  );

  it.each([
    { scenario: 'too few arguments', args: [['data', 'x']] },
    {
      scenario: 'too many arguments',
      args: [
        ['data', 'x'],
        ['data', 'y'],
        ['data', 'z'],
      ],
    },
    { scenario: 'an argument the base refuses', args: [['data', 'x'], [1]] },
  ])('refuses $scenario', ({ args }) => {
    const result = narrowRowsFrom(makeCopyGuard(), {
      copy: [[under('data')], [under('logs')]],
    });

    expect(admits(result, 'copy', args)).toBe(false);
  });

  describe('with rows of mixed length over optional and rest positions', () => {
    const makeMixedGuard = (): InterfaceGuard =>
      M.interface('Mixed', {
        put: M.callWhen(M.string())
          .optional(M.number())
          .rest(M.arrayOf(M.string()))
          .returns(M.any()),
      });

    // A rest guard matches the trailing arguments as one array, so the third
    // row's rest pattern is an array pattern.
    const result = narrowRowsFrom(makeMixedGuard(), {
      put: [
        [M.eq('a')],
        [M.eq('b'), M.lte(10)],
        [M.eq('c'), undefined, M.arrayOf(M.eq('z'))],
      ],
    });

    it.each([
      { args: ['a'], expected: true },
      { args: ['a', 99], expected: true },
      { args: ['a', 99, 'any', 'thing'], expected: true },
      { args: ['b'], expected: true },
      { args: ['b', 5], expected: true },
      { args: ['b', 5, 'any'], expected: true },
      { args: ['b', 50], expected: false },
      { args: ['c', 50], expected: true },
      { args: ['c', 50, 'z', 'z'], expected: true },
      { args: ['c', 50, 'y'], expected: false },
      { args: ['a', 'not a number'], expected: false },
      { args: ['a', 1, 2], expected: false },
      { args: [], expected: false },
      { args: ['d'], expected: false },
    ])('admits put$args: $expected', ({ args, expected }) => {
      expect(admits(result, 'put', args)).toBe(expected);
    });
  });

  it('rejects a row past the arity of a base without a rest guard', () => {
    expect(() =>
      narrowRowsFrom(makeCopyGuard(), {
        copy: [[under('data')], [undefined, undefined, M.any()]],
      }),
    ).toThrow('the base has arity 2 and no rest guard');
  });
});

describe('makeAbsorbingDelta', () => {
  it('leaves every method the base names unconstrained', () => {
    expect(makeAbsorbingDelta('Joined', makeBaseGuard())).toStrictEqual({
      read: [[]],
      write: [[]],
      drop: [[]],
    });
  });

  it.each(['passable', 'raw'] as const)(
    'refuses a base whose default guards are %s',
    (defaultGuards) => {
      expect(() =>
        makeAbsorbingDelta('Joined', M.interface('Any', {}, { defaultGuards })),
      ).toThrow(
        'Cannot join "Joined": the base guards methods by default, so its methods cannot be enumerated for it to absorb.',
      );
    },
  );
});

describe('toDisjunctiveDelta', () => {
  it('makes each method its own only row', () => {
    const pattern = M.eq('a');

    expect(toDisjunctiveDelta({ read: [pattern], drop: [] })).toStrictEqual({
      read: [[pattern]],
      drop: [[]],
    });
  });
});

describe('conjoinDeltas', () => {
  it('keeps only the methods the incoming delta names', () => {
    const combined = conjoinDeltas({ read: [[]], write: [[]] }, { read: [] });

    expect(combined).toStrictEqual({ read: [[]] });
  });

  it('does not reinstate a method the existing delta dropped', () => {
    expect(() => conjoinDeltas({ read: [[]] }, { write: [] })).toThrow(
      'Cannot narrow method "write": the base has no such method.',
    );
  });

  it('conjoins both patterns where the two deltas overlap', () => {
    const combined = conjoinDeltas(
      { read: [[M.lte(10)]] },
      { read: [M.gte(5)] },
    );
    const [pattern] = combined.read![0]!;

    expect(matches(7, pattern)).toBe(true);
    expect(matches(2, pattern)).toBe(false);
    expect(matches(20, pattern)).toBe(false);
  });

  it.each([
    { side: 'the existing delta', existing: [M.lte(10)], incoming: [] },
    { side: 'the incoming delta', existing: [], incoming: [M.lte(10)] },
  ])('carries a pattern held only by $side', ({ existing, incoming }) => {
    const combined = conjoinDeltas({ read: [existing] }, { read: incoming });
    const [pattern] = combined.read![0]!;

    expect(matches(7, pattern)).toBe(true);
    expect(matches(20, pattern)).toBe(false);
  });

  it('leaves a position both deltas hole as unconstrained', () => {
    const combined = conjoinDeltas(
      { read: [[undefined, M.lte(10)]] },
      { read: [undefined] },
    );

    expect(combined.read![0]![0]).toBeUndefined();
  });

  it('distributes over the existing rows', () => {
    const combined = conjoinDeltas(
      { read: [[M.eq('a'), M.eq(1)], [M.eq('b')]] },
      { read: [undefined, M.lte(5)] },
    );
    const [first, second] = combined.read!;

    expect(combined.read).toHaveLength(2);
    expect(matches('a', first![0])).toBe(true);
    expect(matches(1, first![1])).toBe(true);
    expect(matches('b', second![0])).toBe(true);
    expect(matches(3, second![1])).toBe(true);
    expect(matches(7, second![1])).toBe(false);
  });
});

describe('disjoinDeltas', () => {
  it('takes the union of the methods the two deltas name', () => {
    const disjoined = disjoinDeltas(
      { read: [[M.eq('a')]] },
      { read: [[M.eq('b')]], stat: [[M.eq('b')]] },
    );

    expect(Object.keys(disjoined).sort()).toStrictEqual(['read', 'stat']);
  });

  it('concatenates the rows where both deltas name a method', () => {
    const a = [M.eq('a'), M.eq('a')];
    const b = [M.eq('b'), M.eq('b')];

    expect(disjoinDeltas({ read: [a] }, { read: [b] })).toStrictEqual({
      read: [a, b],
    });
  });

  it('carries a method only one delta names at that delta', () => {
    const row = [M.eq('b')];

    expect(disjoinDeltas({ read: [[]] }, { stat: [row] })).toStrictEqual({
      read: [[]],
      stat: [row],
    });
  });

  it('keeps every row of a join of joins', () => {
    const [first, second, third] = ['a', 'b', 'c'].map((value) => [
      M.eq(value),
    ]);

    expect(
      disjoinDeltas(disjoinDeltas({ read: [first!] }, { read: [second!] }), {
        read: [third!],
      }),
    ).toStrictEqual({ read: [first, second, third] });
  });

  it('does not deduplicate rows', () => {
    const row = [M.eq('a')];

    expect(disjoinDeltas({ read: [row] }, { read: [row] })).toStrictEqual({
      read: [row, row],
    });
  });

  it.each([
    { scenario: 'an empty row', hole: [] },
    { scenario: 'a row of holes', hole: [undefined, undefined] },
  ])('lets $scenario absorb the other rows', ({ hole }) => {
    expect(
      disjoinDeltas({ read: [[M.eq('a')]] }, { read: [hole] }),
    ).toStrictEqual({ read: [[]] });
  });
});

describe('a join, rendered', () => {
  const under = (segment: string): Pattern =>
    M.splitArray([M.eq(segment)], [], M.arrayOf(M.string()));

  const makeCopyGuard = (): InterfaceGuard =>
    M.interface('Fs', {
      copy: M.callWhen(M.arrayOf(M.string()), M.arrayOf(M.string())).returns(
        M.string(),
      ),
      stat: M.callWhen(M.arrayOf(M.string())).returns(M.string()),
    });

  const data = toDisjunctiveDelta({ copy: [under('data'), under('data')] });
  const logs = toDisjunctiveDelta({
    copy: [under('logs'), under('logs')],
    stat: [under('logs')],
  });

  it.each([
    {
      args: [
        ['data', 'x'],
        ['data', 'y'],
      ],
      expected: true,
    },
    {
      args: [
        ['logs', 'x'],
        ['logs', 'y'],
      ],
      expected: true,
    },
    {
      args: [
        ['data', 'x'],
        ['logs', 'y'],
      ],
      expected: false,
    },
  ])(
    'admits copy$args exactly as an operand does: $expected',
    ({ args, expected }) => {
      const joined = narrowRowsFrom(makeCopyGuard(), disjoinDeltas(data, logs));

      expect(admits(joined, 'copy', args)).toBe(expected);
    },
  );

  it('renders a method only one operand names positionally', () => {
    const baseGuard = makeCopyGuard();

    expect(
      payloadOf(narrowRowsFrom(baseGuard, disjoinDeltas(data, logs)), 'stat'),
    ).toStrictEqual(
      payloadOf(narrowFrom(baseGuard, { stat: [under('logs')] }), 'stat'),
    );
  });

  it('renders a join absorbed by its base as the base', () => {
    const baseGuard = makeCopyGuard();
    const joined = narrowRowsFrom(
      baseGuard,
      disjoinDeltas(data, makeAbsorbingDelta('Joined', baseGuard)),
    );

    expect(payloadOf(joined, 'copy')).toStrictEqual(
      payloadOf(baseGuard, 'copy'),
    );
  });

  it('narrows a join row by row', () => {
    const joined = disjoinDeltas(data, logs);
    const narrowed = narrowRowsFrom(
      makeCopyGuard(),
      conjoinDeltas(joined, {
        copy: [M.splitArray([], [], M.arrayOf(M.not(M.eq('secret'))))],
      }),
    );

    expect(
      admits(narrowed, 'copy', [
        ['data', 'x'],
        ['data', 'y'],
      ]),
    ).toBe(true);
    expect(
      admits(narrowed, 'copy', [
        ['logs', 'x'],
        ['logs', 'y'],
      ]),
    ).toBe(true);
    expect(
      admits(narrowed, 'copy', [
        ['data', 'secret'],
        ['data', 'y'],
      ]),
    ).toBe(false);
    expect(
      admits(narrowed, 'copy', [
        ['data', 'x'],
        ['logs', 'y'],
      ]),
    ).toBe(false);
    expect(Object.keys(getInterfaceMethodGuards(narrowed))).toStrictEqual([
      'copy',
    ]);
  });
});
