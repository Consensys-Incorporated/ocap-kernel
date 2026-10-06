import { M, getInterfaceGuardPayload } from '@endo/patterns';
import type { InterfaceGuard, MethodGuard, Pattern } from '@endo/patterns';

import {
  buildMethodGuard,
  getInterfaceMethodGuards,
  getMethodPayload,
} from './guard-algebra.ts';

/**
 * Patterns to conjoin onto a base capability's method guards, addressed by
 * argument position.
 *
 * A method the delta does not name is dropped, so forgetting a method removes
 * authority rather than granting it. Within a method, a hole leaves that
 * position as the base has it, and an empty array leaves every position as the
 * base has it.
 */
export type NarrowingDelta = Record<string, DeltaRow>;

/**
 * One method's patterns, addressed by argument position, with `undefined` at a
 * hole.
 */
export type DeltaRow = (Pattern | undefined)[];

/**
 * A delta in disjunctive normal form: each method maps to a non-empty list of
 * rows, and admits a call that any one of its rows admits. A `NarrowingDelta`
 * is the one-row case.
 */
export type DisjunctiveDelta = Record<string, DeltaRow[]>;

/**
 * Lift a delta into disjunctive normal form, as one row per method.
 *
 * @param delta - The delta to lift.
 * @returns The delta with each method's patterns as its only row.
 */
export const toDisjunctiveDelta = (delta: NarrowingDelta): DisjunctiveDelta =>
  Object.fromEntries(
    Object.entries(delta).map(([methodName, row]) => [methodName, [row]]),
  );

/**
 * Conjoin a delta pattern onto a base guard.
 *
 * @param base - The base guard.
 * @param pattern - The pattern to conjoin, or undefined at a hole.
 * @returns The conjunction, or the base guard unchanged at a hole.
 */
const conjoin = (base: Pattern, pattern: Pattern | undefined): Pattern =>
  pattern === undefined ? base : M.and(base, pattern);

/**
 * Conjoin two rows position by position. A hole on either side leaves the other
 * in place.
 *
 * @param left - One row.
 * @param right - The other row.
 * @returns The conjoined row.
 */
const conjoinRows = (left: DeltaRow, right: DeltaRow): DeltaRow =>
  Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const leftPattern = left[index];
    const rightPattern = right[index];
    if (leftPattern === undefined) {
      return rightPattern;
    }
    return conjoin(leftPattern, rightPattern);
  });

/**
 * Conjoin a delta onto a recorded one, so that narrowing a narrowing is one
 * delta against the original base.
 *
 * Keys come from `incoming` alone, since it drops what it does not name, and a
 * key it names that `existing` does not is a method the narrowing being
 * narrowed no longer has. Conjunction distributes over the existing rows:
 * `(r1 ∪ … ∪ rn) ∧ x = (r1 ∧ x) ∪ … ∪ (rn ∧ x)`.
 *
 * @param existing - The delta the base was narrowed by.
 * @param incoming - The delta narrowing it further.
 * @returns The combined delta.
 */
export const conjoinDeltas = (
  existing: DisjunctiveDelta,
  incoming: NarrowingDelta,
): DisjunctiveDelta => {
  const combined: DisjunctiveDelta = {};
  for (const [methodName, row] of Object.entries(incoming)) {
    const inherited = existing[methodName];
    if (inherited === undefined) {
      throw new Error(
        `Cannot narrow method "${methodName}": the base has no such method.`,
      );
    }
    combined[methodName] = inherited.map((inheritedRow) =>
      conjoinRows(inheritedRow, row),
    );
  }
  return combined;
};

/**
 * Disjoin two deltas, so that a join admits exactly what either operand admits.
 *
 * A join is a union of authority. A method absent from an operand contributes
 * no rows, so it survives at the other operand's rows, and where both name it
 * their rows are concatenated. A row of holes admits everything the base does,
 * so it absorbs the method's other rows.
 *
 * Hence the keys are the union of both sides — the opposite of
 * `conjoinDeltas`, which takes its keys from one side because narrowing must
 * not restore authority an intermediate narrowing dropped.
 *
 * @param left - One operand's delta.
 * @param right - The other operand's delta.
 * @returns The disjoined delta.
 */
export const disjoinDeltas = (
  left: DisjunctiveDelta,
  right: DisjunctiveDelta,
): DisjunctiveDelta => {
  const disjoined: DisjunctiveDelta = {};
  for (const methodName of new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])) {
    // TODO: Two rows that differ at exactly one position can be merged into
    // one, disjoining that position, without changing what the method admits.
    const rows = [...(left[methodName] ?? []), ...(right[methodName] ?? [])];
    disjoined[methodName] = rows.some((row) =>
      row.every((pattern) => pattern === undefined),
    )
      ? [[]]
      : rows;
  }
  return disjoined;
};

/**
 * One row's argument guards, split as a method guard splits them. An undefined
 * `rest` admits no arguments past the fixed arity.
 */
type RowGuards = {
  required: Pattern[];
  optionals: Pattern[];
  rest: Pattern | undefined;
};

/**
 * Conjoin one row onto the positions of a base method guard it addresses.
 *
 * Positions are walked as required arguments, then optionals, then the rest
 * guard, and each stays in the category it lands in. Every position past the
 * fixed arity conjoins onto the one rest guard, which is the only thing a rest
 * position can express.
 *
 * @param methodName - The method being narrowed, for error messages.
 * @param baseMethodGuard - The guard to narrow.
 * @param row - The row's patterns.
 * @returns The row's argument guards.
 */
const narrowRow = (
  methodName: string,
  baseMethodGuard: MethodGuard,
  row: DeltaRow,
): RowGuards => {
  const { argGuards, optionalArgGuards, restArgGuard } =
    getMethodPayload(baseMethodGuard);
  const optionals = optionalArgGuards ?? [];
  const maxArity = argGuards.length + optionals.length;

  const beyondArity = row.findIndex(
    (pattern, index) => index >= maxArity && pattern !== undefined,
  );
  if (beyondArity !== -1 && restArgGuard === undefined) {
    throw new Error(
      `Cannot narrow argument ${beyondArity} of method "${methodName}": the base has arity ${maxArity} and no rest guard.`,
    );
  }

  return {
    required: argGuards.map((guard, index) => conjoin(guard, row[index])),
    optionals: optionals.map((guard, index) =>
      conjoin(guard, row[argGuards.length + index]),
    ),
    rest:
      restArgGuard === undefined
        ? undefined
        : row.slice(maxArity).reduce(conjoin, restArgGuard),
  };
};

/**
 * Synthesize one row's argument guards for a method its base admits by
 * default.
 *
 * `defaultGuards: 'passable'` admits any passable arguments, so there is
 * nothing to conjoin onto and the row's patterns are the whole guard. The
 * result still admits no more calls than the base did — an empty row
 * synthesizes `M.callWhen().rest(M.any())`, which admits exactly what the base
 * admits.
 *
 * Such a base names no methods, so a delta naming one it does not implement is
 * indistinguishable from one it does, and no error can be raised here. The
 * forward rejects at call time instead.
 *
 * Trailing holes are dropped rather than made required. Otherwise a join, which
 * pads the shorter operand's delta with holes, would demand arguments that
 * operand never required, and refuse calls it admitted.
 *
 * @param row - The row's patterns.
 * @returns The row's argument guards.
 */
const synthesizeRow = (row: DeltaRow): RowGuards => {
  let end = row.length;
  while (end > 0 && row[end - 1] === undefined) {
    end -= 1;
  }
  return {
    required: row.slice(0, end).map((pattern) => pattern ?? M.any()),
    optionals: [],
    rest: M.any(),
  };
};

/**
 * Assemble a method guard admitting a call that any row admits, asyncified for
 * forwarding.
 *
 * One row is rendered positionally. Several have no common positional form, so
 * the guard takes no fixed arguments and its rest guard matches the whole
 * argument array against one `M.splitArray` per row. A row without a rest guard
 * gets `[]` as its rest, since `M.splitArray` would otherwise default to
 * `M.any()` and admit trailing arguments the base refuses.
 *
 * @param rows - Each row's argument guards.
 * @param returnGuard - The base's return guard.
 * @returns The method guard.
 */
const renderMethodGuard = (
  rows: RowGuards[],
  returnGuard: Pattern,
): MethodGuard => {
  const [only] = rows;
  if (only !== undefined && rows.length === 1) {
    return buildMethodGuard({
      base: M.callWhen(...only.required),
      optionals: only.optionals,
      restGuard: only.rest,
      returnGuard,
    });
  }
  return buildMethodGuard({
    base: M.callWhen(),
    restGuard: M.or(
      ...rows.map(({ required, optionals, rest }) =>
        M.splitArray(required, optionals, rest ?? []),
      ),
    ),
    returnGuard,
  });
};

/**
 * Return the delta a base contributes as an operand of a join: every method
 * its guard names, unconstrained, so that it absorbs.
 *
 * A base that guards methods by default cannot absorb. Its methods cannot be
 * enumerated, and a narrowing drops every method its delta does not name, so
 * no delta represents it.
 *
 * @param name - The join's name, for error messages.
 * @param baseGuard - The base's interface guard.
 * @returns The base's delta.
 */
export const makeAbsorbingDelta = (
  name: string,
  baseGuard: InterfaceGuard,
): DisjunctiveDelta => {
  const { defaultGuards } = getInterfaceGuardPayload(baseGuard) as unknown as {
    defaultGuards?: 'passable' | 'raw';
  };
  if (defaultGuards !== undefined) {
    throw new Error(
      `Cannot join "${name}": the base guards methods by default, so its methods cannot be enumerated for it to absorb.`,
    );
  }
  return Object.fromEntries(
    Object.keys(getInterfaceMethodGuards(baseGuard)).map((methodName) => [
      methodName,
      [[]],
    ]),
  );
};

/**
 * Derive the interface guard of a narrowing of a base capability.
 *
 * Each delta pattern is conjoined onto the base's guard at the argument
 * position it addresses, row by row. Arity, the required/optional/rest split, and return
 * guards are inherited verbatim — a narrowed return guard could fail where the
 * base succeeds, which would not be an unaltered forward. Methods the delta
 * does not name are dropped.
 *
 * The result is constructed as a conjunction with the base's guard rather than
 * checked against it, so it admits no call the base does not — the
 * precondition that lets `join` disjoin deltas without deciding pattern
 * subtyping.
 *
 * @param options - Options bag.
 * @param options.name - The name for the derived interface guard.
 * @param options.baseGuard - The interface guard being narrowed.
 * @param options.delta - The patterns to conjoin, by method, row, and position.
 * @returns The derived interface guard.
 */
export const narrowInterfaceGuard = ({
  name,
  baseGuard,
  delta,
}: {
  name: string;
  baseGuard: InterfaceGuard;
  delta: DisjunctiveDelta;
}): InterfaceGuard => {
  const baseMethodGuards = getInterfaceMethodGuards(baseGuard);
  const { defaultGuards } = getInterfaceGuardPayload(baseGuard) as unknown as {
    defaultGuards?: 'passable' | 'raw';
  };

  const narrowedMethodGuards: Record<string, MethodGuard> = {};
  for (const [methodName, rows] of Object.entries(delta)) {
    const baseMethodGuard = baseMethodGuards[methodName];
    if (baseMethodGuard === undefined) {
      if (defaultGuards === 'passable') {
        narrowedMethodGuards[methodName] = renderMethodGuard(
          rows.map(synthesizeRow),
          M.any(),
        );
        continue;
      }
      throw new Error(
        defaultGuards === undefined
          ? `Cannot narrow method "${methodName}": the base has no such method.`
          : `Cannot narrow method "${methodName}": the base guards it by default, so there is no guard to conjoin onto.`,
      );
    }
    narrowedMethodGuards[methodName] = renderMethodGuard(
      rows.map((row) => narrowRow(methodName, baseMethodGuard, row)),
      getMethodPayload(baseMethodGuard).returnGuard,
    );
  }

  return M.interface(name, narrowedMethodGuards);
};
