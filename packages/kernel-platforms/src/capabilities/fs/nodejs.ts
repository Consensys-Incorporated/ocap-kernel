import { lstatSync } from 'node:fs';
import fs from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { makeFsSpecification } from './shared.ts';
import type { FsSpecification } from './shared.ts';
import type { FsConfigStruct, PathSegments, SegmentsCaveat } from './types.ts';

/**
 * Joins absolute segments into a Node.js path.
 *
 * `resolve` rather than a join on `sep` so a leading drive segment lands as a
 * drive. Callers have already rejected separators and traversals, so there is
 * nothing left for it to normalize away.
 *
 * @param segments - The segments to join
 * @returns The corresponding absolute path
 */
export const toPath = (segments: PathSegments): string =>
  resolve(sep, ...segments);

/**
 * Node.js specific symlink caveat factory using node:fs
 *
 * @returns A caveat function that validates segments against symlinks
 */
export const makeNoSymlinksCaveat = (): SegmentsCaveat => {
  return harden((segments: PathSegments): void => {
    const path = toPath(segments);
    // eslint-disable-next-line n/no-sync
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Symlinks are prohibited: ${path}`);
    }
  });
};

const specification: FsSpecification = makeFsSpecification({
  makeReadFile: () => fs.readFile,
  makeAccess: () => fs.access,
  makePathCaveat: makeNoSymlinksCaveat,
  toPath,
});

// eslint-disable-next-line prefer-destructuring -- annotated for declaration emit
export const configStruct: FsConfigStruct = specification.configStruct;
export const { capabilityFactory } = specification;
