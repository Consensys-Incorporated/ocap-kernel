import { exactOptional, object, string, boolean } from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';
import type { PathLike } from 'node:fs';
import type { readFile, access } from 'node:fs/promises';

export type { PathLike };

// Throws if the path argument violates expectations (async version).
export type PathCaveat = (path: PathLike) => Promise<void>;
// Throws if the path argument violates expectations (sync version).
export type SyncPathCaveat = (path: PathLike) => void;

export type ReadFile = typeof readFile;
export type Access = typeof access;

export const fsConfigStruct = object({
  rootDir: string(),
  promises: exactOptional(
    object({
      readFile: exactOptional(boolean()),
      access: exactOptional(boolean()),
    }),
  ),
});

export type FsCapability = Partial<{
  promises: Partial<{
    readFile: ReadFile;
    access: Access;
  }>;
}>;

export type FsConfig = Infer<typeof fsConfigStruct>;
