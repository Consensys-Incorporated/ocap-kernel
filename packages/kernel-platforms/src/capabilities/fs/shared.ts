import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import type { MethodGuard } from '@endo/patterns';
import { narrow, pathUnder } from '@metamask/kernel-utils';
import type { NarrowingDelta } from '@metamask/kernel-utils';

import type {
  PathSegments,
  SegmentsCaveat,
  ReadFile,
  Access,
  FsConfig,
  FsCapability,
  FsMethodName,
  FsMethods,
} from './types.ts';
import { fsConfigStruct } from './types.ts';
import { makeCapabilitySpecification } from '../../specification.ts';
import type { CapabilitySpecification } from '../../specification.ts';

// The guard can only require strings, so `['srv', 'data/../../etc']` reaches
// here intact and would resolve to `/etc` on the way to a syscall. Rejecting
// these is what makes a prefix check sufficient.
const plainSegment = /^[^/\\]+$/u;

/**
 * Asserts that every segment addresses exactly one path component.
 *
 * @param segments - The segments to check
 * @param label - What is being checked, for the error message
 */
export const assertPlainSegments = (
  segments: PathSegments,
  label: string,
): void => {
  const bad = segments.find(
    (segment) =>
      segment === '.' || segment === '..' || !plainSegment.test(segment),
  );
  if (bad !== undefined) {
    throw new Error(
      `${label} contains an invalid segment: ${JSON.stringify(bad)}`,
    );
  }
};

/**
 * Wraps a path-taking FS operation as a segments-taking one, with validation.
 *
 * @param options - The operation and the restrictions to apply to it
 * @param options.operation - The underlying operation to wrap
 * @param options.caveat - The caveat to apply to the segments argument
 * @param options.toPath - Converts segments to a platform path
 * @returns The operation restricted by the provided caveat
 */
export const makeCaveatedFsOperation = ({
  operation,
  caveat,
  toPath,
}: {
  operation: (...args: never[]) => Promise<unknown>;
  caveat: SegmentsCaveat;
  toPath: (segments: PathSegments) => string;
}): ((segments: PathSegments, ...rest: unknown[]) => Promise<unknown>) => {
  return harden(async (segments: PathSegments, ...rest: unknown[]) => {
    try {
      assertPlainSegments(segments, 'path');
      caveat(segments);
      // We don't need async caveats yet, but we could await one here.
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Caveat failed';
      throw new Error(`fs.${operation.name}: ${message}`, { cause });
    }
    return operation(...([toPath(segments), ...rest] as unknown as never[]));
  });
};

/**
 * Compile fs config into the narrowing delta that enforces it.
 *
 * Separate from the factory so that a general JSON delta encoding could replace
 * it without touching the capability.
 *
 * @param config - The capability's configuration
 * @param config.root - The prefix every path must extend
 * @param config.methods - The methods the delta retains
 * @returns The delta to narrow the full fs exo by
 */
export const compileFsDelta = ({
  root,
  methods = [],
}: FsConfig): NarrowingDelta =>
  Object.fromEntries(methods.map((name) => [name, [pathUnder(root)]]));

// Written out per method rather than via `makeDefaultExo`, whose
// `defaultGuards: 'passable'` leaves an empty guard map: narrowing conjoins a
// delta onto a per-argument guard, so there has to be one to conjoin onto.
// `readFile`'s encoding is required rather than optional because without one
// Node resolves a `Buffer`, and no typed array is Passable even frozen, so the
// result could never cross the exo boundary. Requiring it fails the call at the
// call site instead of on the way back.
const fsMethodGuards: Record<FsMethodName, MethodGuard> = harden({
  readFile: M.callWhen(M.arrayOf(M.string()), M.string()).returns(M.string()),
  access: M.callWhen(M.arrayOf(M.string()))
    .optional(M.number())
    .returns(M.undefined()),
});

export type FsPlatformOptions = {
  makeReadFile: () => ReadFile;
  makeAccess: () => Access;
  makePathCaveat: () => SegmentsCaveat;
  toPath: (segments: PathSegments) => string;
};

/**
 * Build the unrestricted fs exo that every configured capability narrows.
 *
 * It holds every method and depends on no config, so one base serves all of a
 * platform's narrowings and `join` reaches across them. Not exported from the
 * package: a holder of this holds the whole filesystem.
 *
 * @param options - The platform's operations and path handling
 * @param options.makeReadFile - The factory returning a read file operation
 * @param options.makeAccess - The factory returning an access operation
 * @param options.makePathCaveat - The factory returning the platform's caveat
 * @param options.toPath - Converts segments to a platform path
 * @returns The full fs exo
 */
export const makeFsBase = ({
  makeReadFile,
  makeAccess,
  makePathCaveat,
  toPath,
}: FsPlatformOptions): FsCapability => {
  const caveat = makePathCaveat();
  const operations = {
    readFile: makeCaveatedFsOperation({
      operation: makeReadFile(),
      caveat,
      toPath,
    }),
    access: makeCaveatedFsOperation({
      operation: makeAccess(),
      caveat,
      toPath,
    }),
  } as unknown as FsMethods;

  return makeExo('FsBase', M.interface('FsBase', fsMethodGuards), {
    ...operations,
  });
};

/**
 * Build the capability factory that narrows `base` by a config.
 *
 * The config's bound is the root of this capability's narrowing tree, so it is
 * applied by the same `narrow` a holder would use. A holder narrowing further
 * therefore flattens onto this base rather than stacking on it.
 *
 * @param base - The full fs exo to narrow
 * @returns A factory taking config to the narrowed capability
 */
const makeNarrowingFactory =
  (base: FsCapability) =>
  async (config: FsConfig): Promise<FsCapability> => {
    // `pathUnder([])` admits every path, so an unbounded root has to be refused
    // here rather than by the pattern.
    assertPlainSegments(config.root, 'root');
    return narrow<Partial<FsMethods>>({
      name: 'Fs',
      base,
      delta: compileFsDelta(config),
    });
  };

export type FsSpecification = CapabilitySpecification<
  typeof fsConfigStruct,
  Promise<FsCapability>
>;

/**
 * Cross-platform FS capability specification factory
 *
 * @param options - The platform's operations and path handling
 * @returns The capability specification
 */
export const makeFsSpecification = (
  options: FsPlatformOptions,
): FsSpecification =>
  makeCapabilitySpecification(
    fsConfigStruct,
    makeNarrowingFactory(makeFsBase(options)),
  );
