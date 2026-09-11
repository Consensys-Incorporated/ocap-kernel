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
export type NarrowingDelta = Record<string, (Pattern | undefined)[]>;

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
 * Conjoin two deltas, so that narrowing a narrowing is one delta against the
 * original base.
 *
 * Keys come from `incoming` alone, since it drops what it does not name, and a
 * key it names that `existing` does not is a method the narrowing being
 * narrowed no longer has. At each position a hole on either side leaves the
 * other in place.
 *
 * @param existing - The delta the base was narrowed by.
 * @param incoming - The delta narrowing it further.
 * @returns The combined delta.
 */
export const conjoinDeltas = (
  existing: NarrowingDelta,
  incoming: NarrowingDelta,
): NarrowingDelta => {
  const combined: NarrowingDelta = {};
  for (const [methodName, patterns] of Object.entries(incoming)) {
    const inherited = existing[methodName];
    if (inherited === undefined) {
      throw new Error(
        `Cannot narrow method "${methodName}": the base has no such method.`,
      );
    }
    const length = Math.max(inherited.length, patterns.length);
    combined[methodName] = Array.from({ length }, (_, index) => {
      const left = inherited[index];
      const right = patterns[index];
      if (left === undefined) {
        return right;
      }
      return conjoin(left, right);
    });
  }
  return combined;
};

/**
 * Disjoin two deltas, so that a join admits whatever either operand admits.
 *
 * A join is a union of authority, which settles the whole key-and-hole rule at
 * once: a method absent from an operand contributes the empty set, so it
 * survives at the other operand's delta, and a hole contributes everything, so
 * a hole on either side leaves that position unconstrained. A position past the
 * end of a delta is a hole.
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
  left: NarrowingDelta,
  right: NarrowingDelta,
): NarrowingDelta => {
  const disjoined: NarrowingDelta = { ...left, ...right };
  for (const [methodName, leftPatterns] of Object.entries(left)) {
    const rightPatterns = right[methodName];
    if (rightPatterns === undefined) {
      continue;
    }
    const length = Math.max(leftPatterns.length, rightPatterns.length);
    disjoined[methodName] = Array.from({ length }, (_, index) => {
      const leftPattern = leftPatterns[index];
      const rightPattern = rightPatterns[index];
      if (leftPattern === undefined || rightPattern === undefined) {
        return undefined;
      }
      return M.or(leftPattern, rightPattern);
    });
  }
  return disjoined;
};

/**
 * Narrow one method guard by conjoining the delta's patterns onto the
 * positions they address.
 *
 * Positions are walked as required arguments, then optionals, then the rest
 * guard, and each stays in the category it lands in. Every position past the
 * fixed arity conjoins onto the one rest guard, which is the only thing a rest
 * position can express.
 *
 * @param methodName - The method being narrowed, for error messages.
 * @param baseMethodGuard - The guard to narrow.
 * @param patterns - The delta's patterns for this method.
 * @returns The narrowed guard, asyncified for forwarding.
 */
const narrowMethodGuard = (
  methodName: string,
  baseMethodGuard: MethodGuard,
  patterns: (Pattern | undefined)[],
): MethodGuard => {
  const { argGuards, optionalArgGuards, restArgGuard, returnGuard } =
    getMethodPayload(baseMethodGuard);
  const optionals = optionalArgGuards ?? [];
  const maxArity = argGuards.length + optionals.length;

  const beyondArity = patterns.findIndex(
    (pattern, index) => index >= maxArity && pattern !== undefined,
  );
  if (beyondArity !== -1 && restArgGuard === undefined) {
    throw new Error(
      `Cannot narrow argument ${beyondArity} of method "${methodName}": the base has arity ${maxArity} and no rest guard.`,
    );
  }

  return buildMethodGuard(
    M.callWhen(
      ...argGuards.map((guard, index) => conjoin(guard, patterns[index])),
    ),
    optionals.map((guard, index) =>
      conjoin(guard, patterns[argGuards.length + index]),
    ),
    restArgGuard === undefined
      ? undefined
      : patterns.slice(maxArity).reduce(conjoin, restArgGuard),
    returnGuard,
  );
};

/**
 * Synthesize a method guard for a method its base admits by default.
 *
 * `defaultGuards: 'passable'` admits any passable arguments, so there is
 * nothing to conjoin onto and the delta's patterns are the whole guard. The
 * result still admits no more calls than the base did — a delta of length 0
 * synthesizes `M.callWhen().rest(M.any()).returns(M.any())`, which admits
 * exactly what the base admits.
 *
 * Such a base names no methods, so a delta naming one it does not implement is
 * indistinguishable from one it does, and no error can be raised here. The
 * forward rejects at call time instead.
 *
 * @param patterns - The delta's patterns for this method.
 * @returns The synthesized guard.
 */
const synthesizeMethodGuard = (
  patterns: (Pattern | undefined)[],
): MethodGuard =>
  buildMethodGuard(
    M.callWhen(...patterns.map((pattern) => pattern ?? M.any())),
    [],
    M.any(),
    M.any(),
  );

/**
 * Derive the interface guard of a narrowing of a base capability.
 *
 * Each delta pattern is conjoined onto the base's guard at the argument
 * position it addresses. Arity, the required/optional/rest split, and return
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
 * @param options.delta - The patterns to conjoin, by method and position.
 * @returns The derived interface guard.
 */
export const narrowInterfaceGuard = ({
  name,
  baseGuard,
  delta,
}: {
  name: string;
  baseGuard: InterfaceGuard;
  delta: NarrowingDelta;
}): InterfaceGuard => {
  const baseMethodGuards = getInterfaceMethodGuards(baseGuard);
  const { defaultGuards } = getInterfaceGuardPayload(baseGuard) as unknown as {
    defaultGuards?: 'passable' | 'raw';
  };

  const narrowedMethodGuards: Record<string, MethodGuard> = {};
  for (const [methodName, patterns] of Object.entries(delta)) {
    const baseMethodGuard = baseMethodGuards[methodName];
    if (baseMethodGuard === undefined) {
      if (defaultGuards === 'passable') {
        narrowedMethodGuards[methodName] = synthesizeMethodGuard(patterns);
        continue;
      }
      throw new Error(
        defaultGuards === undefined
          ? `Cannot narrow method "${methodName}": the base has no such method.`
          : `Cannot narrow method "${methodName}": the base guards it by default, so there is no guard to conjoin onto.`,
      );
    }
    narrowedMethodGuards[methodName] = narrowMethodGuard(
      methodName,
      baseMethodGuard,
      patterns,
    );
  }

  return M.interface(name, narrowedMethodGuards);
};
