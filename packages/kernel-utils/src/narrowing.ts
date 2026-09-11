import type { Guarded, Methods } from '@endo/exo';
import { M } from '@endo/patterns';
import type { Pattern } from '@endo/patterns';

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

/**
 * Not yet implemented; throws.
 *
 * Conjoin each pattern of `delta` onto the corresponding argument position of
 * `base`'s interface guard, and return an exo under that derived guard whose
 * methods forward to `base`.
 *
 * `Narrowed` describes the resulting method set, which is derived at runtime and
 * so cannot be inferred; supply it to call the result through `E()`.
 *
 * @param _options - The narrowing to mint.
 * @returns The narrowing of the base.
 */
export const narrow = async <Narrowed extends Methods = Methods>(
  _options: NarrowOptions,
): Promise<Guarded<Narrowed>> => {
  throw new Error('narrow is not implemented');
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
