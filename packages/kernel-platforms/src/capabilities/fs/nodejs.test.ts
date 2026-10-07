import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { makeCanonicalPathCaveat, readFile, toPath } from './nodejs.ts';
import { makeFsBase } from './shared.ts';
import type { PathSegments } from './types.ts';

type TestCapability = {
  readFile: (segments: PathSegments, encoding: string) => Promise<string>;
  access: (segments: PathSegments, mode?: number) => Promise<void>;
};

// The configured capability narrows this base, and `narrow` forwards over
// `E()`, which cannot run under `mock-endoify` — see `shared.test.ts`.
const makeCapability = (): TestCapability =>
  makeFsBase({
    makeReadFile: () => readFile as typeof fs.readFile,
    makeAccess: () => fs.access,
    makePathCaveat: makeCanonicalPathCaveat,
    toPath,
  }) as unknown as TestCapability;

/**
 * Create a root holding a file, a directory symlink leaving the root, and a
 * file symlink, under a canonical temporary directory.
 *
 * @returns Segment arrays into the tree.
 */
const makeTree = async (): Promise<{
  root: PathSegments;
  file: PathSegments;
  outside: PathSegments;
}> => {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'fs-')));
  await fs.mkdir(join(dir, 'root'));
  await fs.mkdir(join(dir, 'outside'));
  await fs.writeFile(join(dir, 'root', 'file.txt'), 'inside');
  await fs.writeFile(join(dir, 'outside', 'secret.txt'), 'outside');
  await fs.symlink(join(dir, 'outside'), join(dir, 'root', 'dir-link'));
  await fs.symlink(
    join(dir, 'outside', 'secret.txt'),
    join(dir, 'root', 'file-link'),
  );
  const segments = dir.split(sep).filter(Boolean);
  return {
    root: [...segments, 'root'],
    file: [...segments, 'root', 'file.txt'],
    outside: [...segments, 'outside', 'secret.txt'],
  };
};

describe('toPath', () => {
  it('joins segments into an absolute path', () => {
    expect(toPath(['srv', 'data'])).toBe(`${sep}srv${sep}data`);
  });
});

describe('fs nodejs base', () => {
  it('reads a file at a canonical path', async () => {
    const { file } = await makeTree();

    expect(await makeCapability().readFile(file, 'utf8')).toBe('inside');
  });

  it('checks access at a canonical path', async () => {
    const { file } = await makeTree();

    expect(
      await makeCapability().access(file, fs.constants.R_OK),
    ).toBeUndefined();
  });

  it.each([
    { name: 'a directory symlink', tail: ['dir-link', 'secret.txt'] },
    { name: 'a file symlink', tail: ['file-link'] },
  ])('refuses a path through $name', async ({ tail }) => {
    const { root } = await makeTree();
    const capability = makeCapability();

    await expect(
      capability.readFile([...root, ...tail], 'utf8'),
    ).rejects.toThrow('Path is not canonical');
    await expect(capability.access([...root, ...tail])).rejects.toThrow(
      'Path is not canonical',
    );
  });

  it.each([
    { name: 'parent segments', tail: ['..', 'outside', 'secret.txt'] },
    { name: 'an embedded traversal', tail: ['../outside/secret.txt'] },
  ])('refuses $name', async ({ tail }) => {
    const { root } = await makeTree();

    await expect(
      makeCapability().readFile([...root, ...tail], 'utf8'),
    ).rejects.toThrow('contains an invalid segment');
  });
});

describe('readFile', () => {
  // Stands in for a symlink swapped into the path after the caveat passed and
  // swapped back before the re-check: the handle is on the outside file while
  // the path names the inside one.
  it('refuses a path that named another file when it was opened', async () => {
    const { file, outside } = await makeTree();
    const { open } = fs;
    const spy = vi
      .spyOn(fs, 'open')
      .mockImplementationOnce(async () => open(toPath(outside)));

    await expect(readFile(toPath(file), 'utf8')).rejects.toThrow(
      'Path changed while it was opened',
    );
    spy.mockRestore();
  });
});
