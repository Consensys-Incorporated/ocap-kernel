import { lstatSync } from 'node:fs';
import fs from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { makeFsSpecification, makeRootCaveat } from './shared.ts';
import type { PathSegments, SegmentsCaveat } from './types.ts';

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
const toPath = (segments: PathSegments): string => resolve(sep, ...segments);

/**
 * Node.js specific symlink caveat factory using node:fs
 *
 * @returns A caveat function that validates segments against symlinks
 */
const makeNoSymlinksCaveat = (): SegmentsCaveat => {
  return (segments: PathSegments): void => {
    const path = toPath(segments);
    // eslint-disable-next-line n/no-sync
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Symlinks are prohibited: ${path}`);
    }
  };
};

/**
 * Node.js specific path caveat factory
 *
 * @param root - The root the segments must extend
 * @returns A caveat function that validates segments against configured constraints
 */
const makeNodejsPathCaveat = (root: PathSegments): SegmentsCaveat => {
  const withinRoot = makeRootCaveat(root);
  const noSymlinks = makeNoSymlinksCaveat();

  return harden((segments: PathSegments) => {
    withinRoot(segments);
    noSymlinks(segments);
  });
};

export const { configStruct, capabilityFactory } = makeFsSpecification({
  makeReadFile: () => fs.readFile,
  makeAccess: () => fs.access,
  makePathCaveat: makeNodejsPathCaveat,
  toPath,
});
