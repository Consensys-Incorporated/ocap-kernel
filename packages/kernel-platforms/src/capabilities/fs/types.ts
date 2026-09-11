import type { Guarded } from '@endo/exo';
import {
  array,
  enums,
  exactOptional,
  nonempty,
  object,
  string,
} from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';
import type { readFile, access } from 'node:fs/promises';

// An absolute path, as in `['srv', 'data', 'x']`. Any platform prefix is a
// leading segment, so a Windows drive is `['C:', 'srv']`.
export type PathSegments = string[];

// Throws if the segments argument violates expectations.
export type SegmentsCaveat = (segments: PathSegments) => void;

export type ReadFile = typeof readFile;
export type Access = typeof access;

export const fsMethodNames = ['readFile', 'access'] as const;

export type FsMethodName = (typeof fsMethodNames)[number];

export const fsConfigStruct = object({
  root: nonempty(array(string())),
  methods: exactOptional(array(enums(fsMethodNames))),
});

export type FsConfig = Infer<typeof fsConfigStruct>;

export type FsMethods = {
  readFile: (
    segments: PathSegments,
    options?: Parameters<ReadFile>[1],
  ) => ReturnType<ReadFile>;
  access: (
    segments: PathSegments,
    mode?: Parameters<Access>[1],
  ) => ReturnType<Access>;
};

export type FsCapability = Guarded<Partial<FsMethods>>;
