import { constants } from 'node:fs';
import fs from 'node:fs/promises';

import { makeFsSpecification } from './shared.ts';
import type { FsSpecification } from './shared.ts';
import type { FsConfigStruct, PathSegments, SegmentsCaveat } from './types.ts';

/**
 * Joins absolute segments into a Node.js path.
 *
 * @param segments - The segments to join
 * @returns The corresponding absolute path
 */
export const toPath = (segments: PathSegments): string =>
  `/${segments.join('/')}`;

/**
 * Asserts that the path is its own `realpath`.
 *
 * A symlink at any position, or on a case-insensitive filesystem a segment
 * differing in case from the entry it names, would let a path satisfy a
 * prefix pattern while naming something outside it. The base cannot see which
 * prefix a holder was narrowed to, so it refuses every alias rather than only
 * those leaving the configured root.
 *
 * @param path - The absolute path to check
 */
export const assertCanonical = async (path: string): Promise<void> => {
  const real = await fs.realpath(path);
  if (real !== path) {
    throw new Error(`Path is not canonical: ${path} resolves to ${real}`);
  }
};

/**
 * Node.js caveat refusing any path that is not canonical.
 *
 * @returns A caveat function that validates segments against aliasing
 */
export const makeCanonicalPathCaveat = (): SegmentsCaveat =>
  harden(async (segments: PathSegments) => assertCanonical(toPath(segments)));

/**
 * Reads a file, refusing one reached through an alias at the time it is opened.
 *
 * The caveat has already run, but a component could be swapped for a symlink
 * between it and the open. So the path is checked again after opening, and
 * must still name the opened file: a swap either side of the open leaves the
 * handle on a file the path no longer names.
 *
 * @param path - The absolute path to read
 * @param encoding - The encoding to decode the contents with
 * @returns The file's contents
 */
export const readFile = async (
  path: string,
  encoding: BufferEncoding,
): Promise<string> => {
  // eslint-disable-next-line no-bitwise -- open flags are a bitmask
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertCanonical(path);
    const [opened, named] = await Promise.all([handle.stat(), fs.stat(path)]);
    if (opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new Error(`Path changed while it was opened: ${path}`);
    }
    return await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
};

const specification: FsSpecification = makeFsSpecification({
  makeReadFile: () => readFile as typeof fs.readFile,
  makeAccess: () => fs.access,
  makePathCaveat: makeCanonicalPathCaveat,
  toPath,
});

// eslint-disable-next-line prefer-destructuring -- annotated for declaration emit
export const configStruct: FsConfigStruct = specification.configStruct;
export const { capabilityFactory } = specification;
