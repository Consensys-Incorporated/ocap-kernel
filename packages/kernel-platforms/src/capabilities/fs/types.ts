import type { Guarded } from '@endo/exo';
import {
  array,
  enums,
  exactOptional,
  object,
  string,
} from '@metamask/superstruct';
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

export const fsMethodNames = ['readFile', 'access'] as const;

export type FsMethodName = (typeof fsMethodNames)[number];

export const fsConfigStruct = object({
  rootDir: string(),
  methods: exactOptional(array(enums(fsMethodNames))),
});

export type FsConfig = Infer<typeof fsConfigStruct>;

export type FsMethods = {
  readFile: (
    path: string,
    options?: Parameters<ReadFile>[1],
  ) => ReturnType<ReadFile>;
  access: (path: string, mode?: Parameters<Access>[1]) => ReturnType<Access>;
};

export type FsCapability = Guarded<Partial<FsMethods>>;
