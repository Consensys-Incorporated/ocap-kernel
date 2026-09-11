import { GET_INTERFACE_GUARD } from '@endo/exo';
import { getInterfaceGuardPayload, M } from '@endo/patterns';
import type { MethodGuard } from '@endo/patterns';
import { pathUnder } from '@metamask/kernel-utils';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPlainSegments,
  compileFsDelta,
  makeCaveatedFsOperation,
  makeFsBase,
  makeFsSpecification,
} from './shared.ts';
import type {
  ReadFile,
  Access,
  SegmentsCaveat,
  FsCapability,
} from './types.ts';

const toPath = (segments: string[]): string => `/${segments.join('/')}`;

describe('makeCaveatedFsOperation', () => {
  const makeCaveated = (
    operation: (...args: never[]) => Promise<unknown>,
    caveat: SegmentsCaveat,
  ) => makeCaveatedFsOperation({ operation, caveat, toPath });

  it('applies caveat before operation', async () => {
    const mockOperation = vi.fn().mockResolvedValue('result');
    const mockCaveat = vi.fn().mockReturnValue(undefined);

    const caveatedOperation = makeCaveated(mockOperation, mockCaveat);

    const result = await caveatedOperation(['srv', 'x'], 'arg2', 'arg3');

    expect(mockCaveat).toHaveBeenCalledWith(['srv', 'x']);
    expect(mockOperation).toHaveBeenCalledWith('/srv/x', 'arg2', 'arg3');
    expect(result).toBe('result');
  });

  it('throws on caveat rejection', async () => {
    const mockOperation = vi.fn();
    const mockCaveat = vi.fn().mockImplementation(() => {
      throw new Error('Path not allowed');
    });

    const caveatedOperation = makeCaveated(mockOperation, mockCaveat);

    await expect(caveatedOperation(['srv', 'x'])).rejects.toThrow(
      'Path not allowed',
    );
    expect(mockOperation).not.toHaveBeenCalled();
  });

  it('handles void operations', async () => {
    const mockOperation = vi.fn().mockResolvedValue(undefined);
    const mockCaveat = vi.fn().mockReturnValue(undefined);

    const caveatedOperation = makeCaveated(mockOperation, mockCaveat);

    expect(await caveatedOperation(['srv', 'x'])).toBeUndefined();
    expect(mockOperation).toHaveBeenCalledWith('/srv/x');
  });

  it.each([
    { name: 'a parent traversal', segments: ['srv', '..', 'etc'] },
    { name: 'a bare dot', segments: ['srv', '.', 'x'] },
    { name: 'an embedded forward slash', segments: ['srv', 'data/../../etc'] },
    { name: 'an embedded backslash', segments: ['srv', 'data\\..\\..\\etc'] },
    { name: 'an empty segment', segments: ['srv', '', 'x'] },
  ])('rejects $name before the operation runs', async ({ segments }) => {
    const mockOperation = vi.fn();
    const caveatedOperation = makeCaveated(mockOperation, vi.fn());

    await expect(caveatedOperation(segments)).rejects.toThrow(
      'contains an invalid segment',
    );
    expect(mockOperation).not.toHaveBeenCalled();
  });
});

describe('assertPlainSegments', () => {
  it('accepts a drive-prefixed root', () => {
    expect(() => assertPlainSegments(['C:', 'srv'], 'root')).not.toThrow();
  });

  it('names what it was checking', () => {
    expect(() => assertPlainSegments(['srv', '..'], 'root')).toThrow(
      'root contains an invalid segment: ".."',
    );
  });
});

describe('compileFsDelta', () => {
  it('scopes each configured method to the root', () => {
    expect(
      compileFsDelta({ root: ['srv', 'data'], methods: ['readFile'] }),
    ).toStrictEqual({ readFile: [pathUnder(['srv', 'data'])] });
  });

  it('compiles an omitted method list to an empty delta', () => {
    expect(compileFsDelta({ root: ['srv'] })).toStrictEqual({});
  });
});

describe('makeFsBase', () => {
  const createMockBase = () => {
    const mockReadFile: ReadFile = vi.fn();
    const mockAccess: Access = vi.fn();
    const mockPathCaveat: SegmentsCaveat = vi.fn();

    return {
      base: makeFsBase({
        makeReadFile: () => mockReadFile,
        makeAccess: () => mockAccess,
        makePathCaveat: () => mockPathCaveat,
        toPath,
      }) as unknown as Record<string, CallableFunction>,
      mockReadFile,
      mockAccess,
      mockPathCaveat,
    };
  };

  const guardedMethodNames = (capability: FsCapability): string[] =>
    Object.keys(
      (
        getInterfaceGuardPayload(
          capability[GET_INTERFACE_GUARD](),
        ) as unknown as { methodGuards: Record<string, MethodGuard> }
      ).methodGuards,
    );

  it('holds every method, leaving the method set to the narrowing', () => {
    const { base } = createMockBase();

    expect(
      guardedMethodNames(base as unknown as FsCapability).sort(),
    ).toStrictEqual(['access', 'readFile']);
  });

  it('guards a path as a string array', () => {
    const { base } = createMockBase();

    expect(
      (
        getInterfaceGuardPayload(
          (base as unknown as FsCapability)[GET_INTERFACE_GUARD](),
        ) as unknown as { methodGuards: Record<string, MethodGuard> }
      ).methodGuards.readFile,
    ).toStrictEqual(
      M.callWhen(M.arrayOf(M.string()), M.string()).returns(M.string()),
    );
  });

  it('forwards a call through the caveat as a joined path', async () => {
    const { base, mockReadFile, mockPathCaveat } = createMockBase();
    vi.mocked(mockReadFile).mockResolvedValue('contents' as never);

    expect(await base.readFile?.(['root', 'file.txt'], 'utf8')).toBe(
      'contents',
    );
    expect(mockPathCaveat).toHaveBeenCalledWith(['root', 'file.txt']);
    expect(mockReadFile).toHaveBeenCalledWith('/root/file.txt', 'utf8');
  });

  // `pathUnder` matches segment by segment and cannot see inside one, so a
  // segment like this satisfies a narrowing on its prefix positions and is
  // stopped only here. That is why replacing the root caveat with a pattern is
  // safe, and why this check cannot be dropped along with it.
  it('rejects a separator inside a segment that a prefix pattern admits', async () => {
    const { base, mockReadFile } = createMockBase();

    await expect(
      base.readFile?.(['root', 'x/../../etc'], 'utf8'),
    ).rejects.toThrow('path contains an invalid segment');
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

// The configured capability narrows the base, and `narrow` forwards over `E()`,
// which reads `globalThis.HandledPromise` when it loads; `mock-endoify` sets
// that to plain `Promise`. So only the checks that precede the narrowing can be
// exercised here — the narrowed capability is covered in `@ocap/kernel-test`.
describe('makeFsSpecification', () => {
  const specification = makeFsSpecification({
    makeReadFile: () => vi.fn() as unknown as ReadFile,
    makeAccess: () => vi.fn() as unknown as Access,
    makePathCaveat: () => vi.fn(),
    toPath,
  });

  it('creates specification with all capabilities enabled', () => {
    expect(specification).toHaveProperty('configStruct');
    expect(specification).toHaveProperty('capabilityFactory');
  });

  it.each([
    { name: 'a traversal', root: ['srv', '..'] },
    { name: 'a separator', root: ['srv/data'] },
  ])('rejects a root containing $name', async ({ root }) => {
    await expect(specification.capabilityFactory({ root })).rejects.toThrow(
      'root contains an invalid segment',
    );
  });
});
