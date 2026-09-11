import { GET_INTERFACE_GUARD } from '@endo/exo';
import { getInterfaceGuardPayload, M } from '@endo/patterns';
import type { MethodGuard } from '@endo/patterns';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPlainSegments,
  makeCaveatedFsOperation,
  makeFsSpecification,
  makeRootCaveat,
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

describe('makeRootCaveat', () => {
  it.each([
    { name: 'the root itself', segments: ['srv', 'data'] },
    { name: 'a path under the root', segments: ['srv', 'data', 'x', 'y'] },
  ])('accepts $name', ({ segments }) => {
    expect(() => makeRootCaveat(['srv', 'data'])(segments)).not.toThrow();
  });

  it.each([
    { name: 'a sibling of the root', segments: ['srv', 'other'] },
    { name: 'a prefix of the root', segments: ['srv'] },
    { name: 'a disjoint path', segments: ['etc', 'passwd'] },
    // `['srv', 'data']` must not admit `/srv/database`.
    { name: 'a longer first segment', segments: ['srv', 'database', 'x'] },
  ])('rejects $name', ({ segments }) => {
    expect(() => makeRootCaveat(['srv', 'data'])(segments)).toThrow(
      'is outside allowed root',
    );
  });
});

describe('makeFsSpecification', () => {
  const createMockSpecification = () => {
    const mockReadFile: ReadFile = vi.fn();
    const mockAccess: Access = vi.fn();
    const mockPathCaveat: SegmentsCaveat = vi.fn();
    const makeReadFile = vi.fn(() => mockReadFile);
    const makeAccess = vi.fn(() => mockAccess);

    return {
      specification: makeFsSpecification({
        makeReadFile,
        makeAccess,
        makePathCaveat: () => mockPathCaveat,
        toPath,
      }),
      mockReadFile,
      mockAccess,
      mockPathCaveat,
      makeReadFile,
      makeAccess,
    };
  };

  const methodGuards = (
    capability: FsCapability,
  ): Record<string, MethodGuard> =>
    (
      getInterfaceGuardPayload(
        capability[GET_INTERFACE_GUARD](),
      ) as unknown as {
        methodGuards: Record<string, MethodGuard>;
      }
    ).methodGuards;

  const guardedMethodNames = (capability: FsCapability): string[] =>
    Object.keys(methodGuards(capability));

  it('creates specification with all capabilities enabled', () => {
    const { specification } = createMockSpecification();

    expect(specification).toHaveProperty('configStruct');
    expect(specification).toHaveProperty('capabilityFactory');
  });

  it.each([
    { methods: ['readFile'] as const },
    { methods: ['access'] as const },
    { methods: ['readFile', 'access'] as const },
    { methods: [] as const },
  ])('exposes exactly the methods named by $methods', ({ methods }) => {
    const { specification } = createMockSpecification();
    const capability = specification.capabilityFactory({
      root: ['root'],
      methods: [...methods],
    });

    expect(guardedMethodNames(capability).sort()).toStrictEqual(
      [...methods].sort(),
    );
  });

  it('exposes no methods when the config omits the method list', () => {
    const { specification } = createMockSpecification();
    const capability = specification.capabilityFactory({ root: ['root'] });

    expect(guardedMethodNames(capability)).toStrictEqual([]);
  });

  it('does not build an operation the config omits', () => {
    const { specification, makeReadFile, makeAccess } =
      createMockSpecification();
    specification.capabilityFactory({
      root: ['root'],
      methods: ['readFile'],
    });

    expect(makeReadFile).toHaveBeenCalledOnce();
    expect(makeAccess).not.toHaveBeenCalled();
  });

  it('forwards a readFile call through the caveat', async () => {
    const { specification, mockReadFile, mockPathCaveat } =
      createMockSpecification();
    vi.mocked(mockReadFile).mockResolvedValue('contents' as never);
    const capability = specification.capabilityFactory({
      root: ['root'],
      methods: ['readFile'],
    });

    expect(await capability.readFile?.(['root', 'file.txt'])).toBe('contents');
    expect(mockPathCaveat).toHaveBeenCalledWith(['root', 'file.txt']);
    expect(mockReadFile).toHaveBeenCalledWith('/root/file.txt');
  });

  it('rejects a root the config cannot address', () => {
    const { specification } = createMockSpecification();

    expect(() =>
      specification.capabilityFactory({ root: ['srv', '..'] }),
    ).toThrow('root contains an invalid segment: ".."');
  });

  // Asserted by the operation not being reached rather than by the rejection
  // value: `mock-endoify` stubs out `assert`, so a guard violation rejects with
  // `undefined` and `rejects.toThrow()` would pass vacuously.
  it.each([
    { name: 'a bare string', segments: '/root/file.txt' },
    { name: 'an array holding a non-string', segments: ['root', 42] },
  ])('does not forward a readFile path that is $name', async ({ segments }) => {
    const { specification, mockReadFile, mockPathCaveat } =
      createMockSpecification();
    const capability = specification.capabilityFactory({
      root: ['root'],
      methods: ['readFile'],
    });

    await capability
      .readFile?.(segments as unknown as string[])
      .catch(() => undefined);

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockPathCaveat).not.toHaveBeenCalled();
  });

  it('does not forward an access mode that is not a number', async () => {
    const { specification, mockAccess } = createMockSpecification();
    const capability = specification.capabilityFactory({
      root: ['root'],
      methods: ['access'],
    });

    await capability
      .access?.(['root', 'file.txt'], 'r' as unknown as number)
      .catch(() => undefined);

    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('guards a readFile path as a string array', () => {
    const { specification } = createMockSpecification();
    const capability = specification.capabilityFactory({
      root: ['root'],
      methods: ['readFile'],
    });

    expect(methodGuards(capability).readFile).toStrictEqual(
      M.callWhen(M.arrayOf(M.string())).optional(M.any()).returns(M.any()),
    );
  });
});
