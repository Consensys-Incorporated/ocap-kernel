// `E` comes from `@endo/captp`'s re-export because this package already depends
// on captp; `@endo/eventual-send` would be lighter but is not a dependency.
import { E } from '@endo/captp';
import { GET_INTERFACE_GUARD, makeExo } from '@endo/exo';
import type { Guarded, Methods } from '@endo/exo';
import { M } from '@endo/patterns';
import type { InterfaceGuard, MethodGuard, Pattern } from '@endo/patterns';

import { getInterfaceMethodGuards } from './guard-algebra.ts';
import {
  conjoinDeltas,
  disjoinDeltas,
  narrowInterfaceGuard,
} from './narrow-interface-guard.ts';
import type { NarrowingDelta } from './narrow-interface-guard.ts';

/**
 * `base` is `object` rather than `Methods` because an `@endo/exo` carries no
 * index signature and so does not satisfy `Methods`. A promise for a base is
 * acceptable too, since the forward goes through `E()`.
 */
export type NarrowOptions = {
  name: string;
  base: object;
  delta: NarrowingDelta;
};

export type JoinOptions = {
  name: string;
  refs: object[];
};

type GuardBearer = {
  [GET_INTERFACE_GUARD]: () => InterfaceGuard | undefined;
};

type Forwardable = Record<string, (...args: unknown[]) => unknown>;

type Provenance = {
  base: object;
  delta: NarrowingDelta;
  baseGuard: InterfaceGuard;
};

/**
 * What each minted narrowing was minted from. `join` reads it to establish that
 * its operands share a base, and `narrow` reads it to flatten a chain.
 */
const provenance = new WeakMap<object, Provenance>();

/**
 * Build a method that forwards one call to the target over `E()`.
 *
 * `E()` answers every property with a method-invoker, so the index is optional
 * only to the type system. Invoking one for a method the target lacks rejects,
 * which is what a caller holding no such authority must see rather than a
 * silent `undefined`. The invoker cannot be hoisted out of the call: `E()`
 * refuses one invoked detached from the proxy that produced it.
 *
 * @param target - The capability to forward to.
 * @param methodName - The method to forward.
 * @returns The forwarding method.
 */
const makeForwarder =
  (target: object, methodName: string) =>
  async (...args: unknown[]): Promise<unknown> => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return E(target as Forwardable)[methodName]!(...args);
  };

/**
 * Mint an exo under the guard `delta` derives from `baseGuard`, forwarding to
 * `base`, and record what it was minted from.
 *
 * @param options - The narrowing to mint.
 * @param options.name - The name for the derived exo and its interface guard.
 * @param options.base - The capability to forward to.
 * @param options.baseGuard - That capability's interface guard.
 * @param options.delta - The patterns to conjoin, by method and position.
 * @returns The minted narrowing.
 */
const mint = <Minted extends Methods>({
  name,
  base,
  baseGuard,
  delta,
}: {
  name: string;
  base: object;
  baseGuard: InterfaceGuard;
  delta: NarrowingDelta;
}): Guarded<Minted> => {
  const derivedGuard = narrowInterfaceGuard({ name, baseGuard, delta });
  const methods = Object.fromEntries(
    Object.keys(getInterfaceMethodGuards(derivedGuard)).map((methodName) => [
      methodName,
      makeForwarder(base, methodName),
    ]),
  ) as unknown as Minted;

  // The derived guard's method set is computed at runtime, so nothing ties it
  // to `Minted` at the type level.
  const minted = makeExo(
    name,
    derivedGuard as InterfaceGuard<{ [Method in keyof Minted]: MethodGuard }>,
    methods,
  );
  provenance.set(minted, { base, delta, baseGuard });
  return minted;
};

/**
 * Conjoin each pattern of `delta` onto the corresponding argument position of
 * `base`'s interface guard, and return an exo under that derived guard whose
 * methods forward to `base`.
 *
 * The base's guard is read over `E()` whether or not the base is local, so that
 * one code path survives the base later being a cross-vat presence. Narrowing a
 * narrowing needs no such read, since the first one cached what it fetched, and
 * it flattens: the result forwards straight to the original base under the
 * conjunction of both deltas, so a chain of any depth stays one hop deep and
 * `join` reaches across the whole narrowing tree rather than between siblings
 * only.
 *
 * Nothing checks arguments beyond the returned exo's own guard.
 *
 * `Narrowed` describes the resulting method set, which is derived at runtime and
 * so cannot be inferred; supply it to call the result through `E()`. Every
 * method of the result returns a promise, since the derived guards are
 * `M.callWhen`.
 *
 * @param options - The narrowing to mint.
 * @param options.name - The name for the derived exo and its interface guard.
 * @param options.base - The capability to narrow.
 * @param options.delta - The patterns to conjoin, by method and position.
 * @returns The narrowing of the base.
 */
export const narrow = async <Narrowed extends Methods = Methods>({
  name,
  base,
  delta,
}: NarrowOptions): Promise<Guarded<Narrowed>> => {
  const inherited = provenance.get(base);
  const target = inherited?.base ?? base;
  const combined = inherited ? conjoinDeltas(inherited.delta, delta) : delta;
  const baseGuard =
    inherited?.baseGuard ??
    (await E(base as GuardBearer)[GET_INTERFACE_GUARD]());
  if (baseGuard === undefined) {
    throw new Error(
      `Cannot narrow "${name}": the base has no interface guard.`,
    );
  }

  return mint<Narrowed>({ name, base: target, baseGuard, delta: combined });
};

/**
 * Return a narrowing of `refs`' common base admitting exactly what any of them
 * admits, with the operands' deltas disjoined method by method and position by
 * position.
 *
 * Every ref must be one this module minted from that base, or the base itself.
 * The base admits everything and so absorbs, which gives the lattice a
 * representable top and lets a fold over a list need no special case.
 *
 * At least one ref must be a minted narrowing, so the base absorbs only in
 * company: the common base is discovered from a minted ref's record, and an
 * unminted ref is recognizable as that base only by identity against it. A call
 * whose refs are all unminted therefore throws, `refs: []` included, rather
 * than trusting an unminted ref to be the base it cannot confirm. The
 * degenerate `refs: [base]` — a request to copy the base — throws for the same
 * reason, and is not worth a guard fetch to support.
 *
 * The result carries a record of its own, naming the same base and the
 * disjoined delta, so a join can be narrowed or joined again.
 *
 * @param options - The join to mint.
 * @param options.name - The name for the derived exo and its interface guard.
 * @param options.refs - The narrowings to join, and optionally their base.
 * @returns The join of the refs.
 */
export const join = async <Joined extends Methods = Methods>({
  name,
  refs,
}: JoinOptions): Promise<Guarded<Joined>> => {
  const records = refs.map((ref) => provenance.get(ref));
  const minted = records.filter(
    (record): record is Provenance => record !== undefined,
  );
  const [first] = minted;
  if (first === undefined) {
    throw new Error(`Cannot join "${name}": no ref was minted by narrowing.`);
  }
  const { base, baseGuard } = first;
  if (minted.some((record) => record.base !== base)) {
    throw new Error(`Cannot join "${name}": the refs do not share a base.`);
  }

  const unconstrained = Object.fromEntries(
    Object.keys(getInterfaceMethodGuards(baseGuard)).map((methodName) => [
      methodName,
      [],
    ]),
  );
  const deltas = refs.map((ref, index) => {
    const record = records[index];
    if (record !== undefined) {
      return record.delta;
    }
    if (ref !== base) {
      throw new Error(
        `Cannot join "${name}": ref ${index} was not minted by narrowing.`,
      );
    }
    return unconstrained;
  });

  return mint<Joined>({
    name,
    base,
    baseGuard,
    delta: deltas.reduce(disjoinDeltas),
  });
};

/**
 * Build a pattern matching segment arrays under a prefix, excluding `..` so that
 * traversal out of the prefix is unrepresentable.
 *
 * Empty `segments` matches every `..`-free segment array, which is the top of
 * the prefix lattice. A capability for which unbounded authority is a
 * configuration mistake rejects it at its own config boundary, not here.
 *
 * A pattern cannot see inside a segment, so this confines nothing on its own:
 * `['srv', 'x/../../etc']` matches `pathUnder(['srv'])` and resolves to `/etc`.
 * The capability must itself reject a segment that is empty, `.`, `..`, or
 * carries a separator, as `@metamask/kernel-platforms` does for `fs`.
 *
 * @param segments - The prefix the matched arrays must start with.
 * @returns A pattern over segment arrays.
 */
export const pathUnder = (segments: string[]): Pattern =>
  M.splitArray(
    segments.map((segment) => M.eq(segment)),
    [],
    M.arrayOf(M.and(M.string(), M.not(M.eq('..')))),
  );
