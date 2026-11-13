/**
 * Sheafify a set of providers into an authority manager.
 *
 * `sheafify({ name, providers })` returns a `Sheaf` — an immutable object
 * that produces dispatch sections over a fixed set of providers.
 *
 * Each dispatch through a granted section:
 *   1. Filters to providers whose guard covers the point (getMatchingProviders)
 *   2. Collapses equivalent candidates (same metadata → one representative)
 *   3. Decomposes metadata into constraints + options
 *   4. Invokes the policy on the distinguished options
 *   5. Dispatches to some element of the chosen candidate
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import type { InterfaceGuard } from '@endo/patterns';
import type { MethodSchema } from '@metamask/kernel-utils';
import { asyncifyMethodGuards } from '@metamask/kernel-utils';
import { makeDiscoverableExo } from '@metamask/kernel-utils';
import { stringify } from '@metamask/kernel-utils';

import { getMatchingProviders } from './match.ts';
import { evaluateMetadata } from './metadata.ts';
import type {
  Candidate,
  MetadataSpec,
  Section,
  Policy,
  PolicyContext,
  Provider,
  Sheaf,
} from './types.ts';

type EncodedEntry = [key: string, type: string, value: unknown];

const encodeMetadataEntry = (key: string, value: unknown): EncodedEntry => {
  if (value === undefined) {
    return [key, 'undefined', null];
  }
  if (typeof value === 'bigint') {
    return [key, 'bigint', String(value)];
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return [key, 'NaN', null];
    }
    if (value === Infinity) {
      return [key, '+Infinity', null];
    }
    if (value === -Infinity) {
      return [key, '-Infinity', null];
    }
    if (Object.is(value, -0)) {
      return [key, '-0', null];
    }
  }
  return [key, typeof value, value];
};

/**
 * Serialize metadata for equivalence-class keying (collapse step).
 *
 * Uses type-tagged encoding so that values JSON.stringify conflates
 * (undefined, null, NaN, Infinity, -Infinity) produce distinct keys.
 *
 * @param metadata - The metadata value to serialize.
 * @returns A string key for equivalence comparison.
 */
const metadataKey = (metadata: Record<string, unknown>): string => {
  const keys = Object.keys(metadata);
  if (keys.length === 0) {
    return 'null';
  }
  const entries = Object.entries(metadata)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => encodeMetadataEntry(key, val));
  return JSON.stringify(entries);
};

/**
 * Collapse candidates into equivalence classes by metadata identity.
 * Returns one representative per class; the choice within a class is arbitrary.
 *
 * @param candidates - The candidates to collapse.
 * @returns One representative per equivalence class.
 */
const collapseEquivalent = <MetaData extends Record<string, unknown>>(
  candidates: Candidate<MetaData>[],
): Candidate<MetaData>[] => {
  const seen = new Set<string>();
  const representatives: Candidate<MetaData>[] = [];
  for (const entry of candidates) {
    const key = metadataKey(entry.metadata);
    if (!seen.has(key)) {
      seen.add(key);
      representatives.push(entry);
    }
  }
  return representatives;
};

/**
 * Decompose candidate metadata into constraints (shared by all) and
 * stripped candidates (carrying only distinguishing keys).
 *
 * @param candidates - The collapsed candidates.
 * @returns Constraints and stripped candidates.
 */
const decomposeMetadata = <MetaData extends Record<string, unknown>>(
  candidates: Candidate<MetaData>[],
): {
  constraints: Partial<MetaData>;
  stripped: Candidate<Partial<MetaData>>[];
} => {
  const constraints: Record<string, unknown> = {};

  const head = candidates[0];
  if (head === undefined) {
    return { constraints: {} as Partial<MetaData>, stripped: [] };
  }
  const first = head.metadata;
  for (const key of Object.keys(first)) {
    const val = first[key];
    const shared = candidates.every((entry) => {
      const meta = entry.metadata;
      return Object.hasOwn(meta, key) && Object.is(meta[key], val);
    });
    if (shared) {
      constraints[key] = val;
    }
  }

  const stripped = candidates.map((entry) => {
    const remaining: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(entry.metadata)) {
      if (!Object.hasOwn(constraints, key)) {
        remaining[key] = val;
      }
    }
    return { exo: entry.exo, metadata: remaining as Partial<MetaData> };
  });

  return { constraints: constraints as Partial<MetaData>, stripped };
};

/**
 * Invoke a method on a section exo, throwing if the handler is missing.
 *
 * @param exo - The section exo to invoke.
 * @param method - The method name to call.
 * @param args - The positional arguments.
 * @returns The synchronous return value of the method (typically a Promise).
 */
const invokeExo = (exo: Section, method: string, args: unknown[]): unknown => {
  const obj = exo as Record<string, (...a: unknown[]) => unknown>;
  const fn = obj[method];
  if (fn === undefined) {
    throw new Error(`Section has guard for '${method}' but no handler`);
  }
  return fn.call(obj, ...args);
};

type ResolvedProvider<M extends Record<string, unknown>> = {
  exo: Section;
  spec: MetadataSpec<M> | undefined;
};

const drivePolicy = async <M extends Record<string, unknown>>(
  policy: Policy<M>,
  candidates: Candidate<Partial<M>>[],
  context: PolicyContext<M>,
  invoke: (candidate: Candidate<Partial<M>>) => Promise<unknown>,
): Promise<unknown> => {
  const errors: unknown[] = [];
  const gen = policy(candidates, context);
  let next = await gen.next([...errors]);
  while (!next.done) {
    try {
      const result = await invoke(next.value);
      await gen.return(undefined);
      return result;
    } catch (error) {
      errors.push(error);
      next = await gen.next([...errors]);
    }
  }
  throw new Error(`No viable section for ${context.method}`, {
    cause: errors,
  });
};

export const sheafify = <
  MetaData extends Record<string, unknown> = Record<string, unknown>,
>({
  name,
  providers,
}: {
  name: string;
  providers: Provider<MetaData>[];
}): Sheaf<MetaData> => {
  const frozenProviders: readonly ResolvedProvider<MetaData>[] = harden(
    providers.map((provider) => ({
      exo: provider.exo,
      spec: provider.metadata,
    })),
  );
  const buildSection = ({
    guard,
    policy,
    schema,
  }: {
    guard: InterfaceGuard;
    policy: Policy<MetaData>;
    schema?: Record<string, MethodSchema>;
  }): object => {
    const asyncMethodGuards = asyncifyMethodGuards(guard);
    const asyncGuard =
      schema === undefined
        ? M.interface(`${name}:section`, asyncMethodGuards)
        : M.interface(`${name}:section`, asyncMethodGuards, {
            defaultGuards: 'passable',
          });

    const dispatch = async (
      method: string,
      args: unknown[],
    ): Promise<unknown> => {
      const candidates = getMatchingProviders(frozenProviders, method, args);
      const evaluatedCandidates: Candidate<MetaData>[] = candidates.map(
        (provider) => ({
          exo: provider.exo,
          metadata: evaluateMetadata(provider.spec, args),
        }),
      );
      switch (evaluatedCandidates.length) {
        case 0:
          throw new Error(`No section covers ${method}(${stringify(args, 0)})`);
        case 1:
          return invokeExo(
            (evaluatedCandidates[0] as Candidate<MetaData>).exo,
            method,
            args,
          );
        default: {
          const collapsed = collapseEquivalent(evaluatedCandidates);
          if (collapsed.length === 1) {
            return invokeExo(
              (collapsed[0] as Candidate<MetaData>).exo,
              method,
              args,
            );
          }
          const { constraints, stripped } = decomposeMetadata(collapsed);
          const strippedToCollapsed = new Map(
            stripped.map((strippedCandidate, i) => [
              strippedCandidate,
              collapsed[i] as Candidate<MetaData>,
            ]),
          );
          return drivePolicy(
            policy,
            stripped,
            { method, args, constraints },
            async (candidate) => {
              const resolved = strippedToCollapsed.get(candidate);
              if (resolved === undefined) {
                throw new Error(
                  `Policy yielded an unrecognized candidate for '${method}'. ` +
                    `The yielded value must be one of the Candidate objects ` +
                    `passed into the policy (object identity, not structural equality). ` +
                    `Did the policy construct a new object instead of yielding from the candidates array?`,
                );
              }
              return invokeExo(resolved.exo, method, args);
            },
          );
        }
      }
    };

    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> =
      {};
    for (const method of Object.keys(asyncMethodGuards)) {
      handlers[method] = async (...args: unknown[]) => dispatch(method, args);
    }

    const exo = (schema === undefined
      ? makeExo(`${name}:section`, asyncGuard, handlers)
      : makeDiscoverableExo(
          `${name}:section`,
          handlers,
          schema,
          asyncGuard,
        )) as unknown as Section;

    return exo;
  };

  const getSection = ({
    guard,
    policy,
  }: {
    guard: InterfaceGuard;
    policy: Policy<MetaData>;
  }): object => buildSection({ guard, policy });

  const getDiscoverableSection = ({
    guard,
    policy,
    schema,
  }: {
    guard: InterfaceGuard;
    policy: Policy<MetaData>;
    schema: Record<string, MethodSchema>;
  }): object => buildSection({ guard, policy, schema });

  return harden({
    getSection,
    getDiscoverableSection,
  });
};
