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

  const derivedGuard = narrowInterfaceGuard({
    name,
    baseGuard,
    delta: combined,
  });
  const methods = Object.fromEntries(
    Object.keys(getInterfaceMethodGuards(derivedGuard)).map((methodName) => [
      methodName,
      makeForwarder(target, methodName),
    ]),
  ) as unknown as Narrowed;

  // The derived guard's method set is computed at runtime, so nothing ties it
  // to `Narrowed` at the type level.
  const narrowed = makeExo(
    name,
    derivedGuard as InterfaceGuard<{ [Method in keyof Narrowed]: MethodGuard }>,
    methods,
  );
  provenance.set(narrowed, { base: target, delta: combined, baseGuard });
  return narrowed;
};

/**
 * Not yet implemented; throws.
 *
 * Return a narrowing of `refs`' common base admitting exactly what any of them
 * admits. Every ref must be one this module minted from that base, or the base
 * itself.
 *
 * @param _options - The join to mint.
 * @returns The join of the refs.
 */
export const join = async <Joined extends Methods = Methods>(
  _options: JoinOptions,
): Promise<Guarded<Joined>> => {
  throw new Error('join is not implemented');
};

/**
 * Build a pattern matching segment arrays under a prefix, excluding `..` so that
 * traversal out of the prefix is unrepresentable.
 *
 * Empty `segments` matches every `..`-free segment array, which is the top of
 * the prefix lattice. A capability for which unbounded authority is a
 * configuration mistake rejects it at its own config boundary, not here.
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
