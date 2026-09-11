import { lstatSync } from 'node:fs';
import fs from 'node:fs/promises';
import { relative } from 'node:path';

import { makeFsSpecification } from './shared.ts';
import type { PathLike, SyncPathCaveat } from './types.ts';

/**
 * Node.js specific symlink caveat factory using node:fs
 *
 * @returns A caveat function that validates a path against symlinks
 */
const makeNoSymlinksCaveat = (): SyncPathCaveat => {
  return (path: PathLike): void => {
    const pathString = path.toString();
    // eslint-disable-next-line n/no-sync
    const stats = lstatSync(pathString);
    if (stats.isSymbolicLink()) {
      throw new Error(`Symlinks are prohibited: ${pathString}`);
    }
  };
};

/**
 * Node.js specific root directory caveat factory using node:path
 *
 * @param rootDir - The root directory to validate paths against
 * @returns A caveat function that validates a path against the root directory
 */
const makeRootCaveat = (rootDir: string): SyncPathCaveat => {
  return (path: PathLike): void => {
    const pathString = path.toString();
    const relativePath = relative(rootDir, pathString);
    if (relativePath.startsWith('..')) {
      throw new Error(`Path ${pathString} is outside allowed root ${rootDir}`);
    }
  };
};

/**
 * Node.js specific path caveat factory using node:path tools
 *
 * @param rootDir - The root directory to validate paths against
 * @returns A caveat function that validates a path against configured constraints
 */
const makeNodejsPathCaveat = (rootDir: string): SyncPathCaveat => {
  const noSymlinks = makeNoSymlinksCaveat();
  const withinRoot = makeRootCaveat(rootDir);

  return harden((path: PathLike) => {
    noSymlinks(path);
    withinRoot(path);
  });
};

export const { configStruct, capabilityFactory } = makeFsSpecification({
  promises: {
    makeReadFile: () => fs.readFile,
    makeAccess: () => fs.access,
  },
  makePathCaveat: makeNodejsPathCaveat,
});
