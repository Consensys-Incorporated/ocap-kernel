import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import type { MethodGuard } from '@endo/patterns';

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
 * Builds a caveat requiring segments to fall under a root.
 *
 * @param root - The root the segments must extend
 * @returns A caveat that rejects segments outside the root
 */
export const makeRootCaveat = (root: PathSegments): SegmentsCaveat => {
  return (segments: PathSegments): void => {
    if (
      segments.length < root.length ||
      root.some((segment, index) => segments[index] !== segment)
    ) {
      throw new Error(
        `Path ${JSON.stringify(segments)} is outside allowed root ${JSON.stringify(root)}`,
      );
    }
  };
};

// Written out per method rather than via `makeDefaultExo`, whose
// `defaultGuards: 'passable'` leaves an empty guard map: narrowing conjoins a
// delta onto a per-argument guard, so there has to be one to conjoin onto.
const fsMethodGuards: Record<FsMethodName, MethodGuard> = harden({
  readFile: M.callWhen(M.arrayOf(M.string()))
    .optional(M.any())
    .returns(M.any()),
  access: M.callWhen(M.arrayOf(M.string()))
    .optional(M.number())
    .returns(M.undefined()),
});

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Cross-platform FS capability specification factory
 *
 * @param config - The configuration for the capability specification
 * @param config.makeReadFile - The factory returning a read file operation
 * @param config.makeAccess - The factory returning an access operation
 * @param config.makePathCaveat - Factory function to create path caveats
 * @param config.toPath - Converts segments to a platform path
 * @returns The capability specification
 */
export const makeFsSpecification = ({
  makeReadFile,
  makeAccess,
  makePathCaveat,
  toPath,
}: {
  makeReadFile: () => ReadFile;
  makeAccess: () => Access;
  makePathCaveat: (root: PathSegments) => SegmentsCaveat;
  toPath: (segments: PathSegments) => string;
}) =>
  makeCapabilitySpecification(
    fsConfigStruct,
    (config: FsConfig): FsCapability => {
      const { root, methods = [] } = config;
      assertPlainSegments(root, 'root');
      const caveat = makePathCaveat(root);
      const makeOperation = { readFile: makeReadFile, access: makeAccess };

      const guards: Partial<Record<FsMethodName, MethodGuard>> = {};
      const operations: Partial<Record<FsMethodName, FsMethods[FsMethodName]>> =
        {};
      for (const name of methods) {
        guards[name] = fsMethodGuards[name];
        operations[name] = makeCaveatedFsOperation({
          operation: makeOperation[name](),
          caveat,
          toPath,
        }) as FsMethods[FsMethodName];
      }

      return makeExo(
        'Fs',
        M.interface('Fs', guards),
        operations as Partial<FsMethods>,
      );
    },
  );
/* eslint-enable @typescript-eslint/explicit-function-return-type */
