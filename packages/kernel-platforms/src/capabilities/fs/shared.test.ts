import { GET_INTERFACE_GUARD } from '@endo/exo';
import { getInterfaceGuardPayload, M } from '@endo/patterns';
import type { MethodGuard } from '@endo/patterns';
import { describe, expect, it, vi } from 'vitest';

import { makeCaveatedFsOperation, makeFsSpecification } from './shared.ts';
import type {
  ReadFile,
  Access,
  SyncPathCaveat,
  FsCapability,
} from './types.ts';

describe('makeCaveatedFsOperation', () => {
  it('applies caveat before operation', async () => {
    const mockOperation = vi.fn().mockResolvedValue('result');
    const mockCaveat = vi.fn().mockReturnValue(undefined);

    const caveatedOperation = makeCaveatedFsOperation(
      mockOperation,
      mockCaveat,
    );

    const result = await caveatedOperation('/path', 'arg2', 'arg3');

    expect(mockCaveat).toHaveBeenCalledWith('/path');
    expect(mockOperation).toHaveBeenCalledWith('/path', 'arg2', 'arg3');
    expect(result).toBe('result');
  });

  it('throws on caveat rejection', async () => {
    const mockOperation = vi.fn();
    const mockCaveat = vi.fn().mockImplementation(() => {
      throw new Error('Path not allowed');
    });

    const caveatedOperation = makeCaveatedFsOperation(
      mockOperation,
      mockCaveat,
    );

    await expect(caveatedOperation('/path')).rejects.toThrow(
      'Path not allowed',
    );
    expect(mockCaveat).toHaveBeenCalledWith('/path');
    expect(mockOperation).not.toHaveBeenCalled();
  });

  it('handles void operations', async () => {
    const mockOperation = vi.fn().mockResolvedValue(undefined);
    const mockCaveat = vi.fn().mockReturnValue(undefined);

    const caveatedOperation = makeCaveatedFsOperation(
      mockOperation,
      mockCaveat,
    );

    expect(await caveatedOperation('/path')).toBeUndefined();
    expect(mockCaveat).toHaveBeenCalledWith('/path');
    expect(mockOperation).toHaveBeenCalledWith('/path');
  });
});

describe('makeFsSpecification', () => {
  const createMockSpecification = () => {
    const mockReadFile: ReadFile = vi.fn();
    const mockAccess: Access = vi.fn();
    const mockPathCaveat: SyncPathCaveat = vi.fn();
    const makeReadFile = vi.fn(() => mockReadFile);
    const makeAccess = vi.fn(() => mockAccess);

    return {
      specification: makeFsSpecification({
        makeReadFile,
        makeAccess,
        makePathCaveat: () => mockPathCaveat,
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
      rootDir: '/root',
      methods: [...methods],
    });

    expect(guardedMethodNames(capability).sort()).toStrictEqual(
      [...methods].sort(),
    );
  });

  it('exposes no methods when the config omits the method list', () => {
    const { specification } = createMockSpecification();
    const capability = specification.capabilityFactory({ rootDir: '/root' });

    expect(guardedMethodNames(capability)).toStrictEqual([]);
  });

  it('does not build an operation the config omits', () => {
    const { specification, makeReadFile, makeAccess } =
      createMockSpecification();
    specification.capabilityFactory({
      rootDir: '/root',
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
      rootDir: '/root',
      methods: ['readFile'],
    });

    expect(await capability.readFile?.('/root/file.txt')).toBe('contents');
    expect(mockPathCaveat).toHaveBeenCalledWith('/root/file.txt');
    expect(mockReadFile).toHaveBeenCalledWith('/root/file.txt');
  });

  // Asserted by the operation not being reached rather than by the rejection
  // value: `mock-endoify` stubs out `assert`, so a guard violation rejects with
  // `undefined` and `rejects.toThrow()` would pass vacuously.
  it('does not forward a readFile path that is not a string', async () => {
    const { specification, mockReadFile, mockPathCaveat } =
      createMockSpecification();
    const capability = specification.capabilityFactory({
      rootDir: '/root',
      methods: ['readFile'],
    });

    await capability.readFile?.(42 as unknown as string).catch(() => undefined);

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockPathCaveat).not.toHaveBeenCalled();
  });

  it('does not forward an access mode that is not a number', async () => {
    const { specification, mockAccess } = createMockSpecification();
    const capability = specification.capabilityFactory({
      rootDir: '/root',
      methods: ['access'],
    });

    await capability
      .access?.('/root/file.txt', 'r' as unknown as number)
      .catch(() => undefined);

    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('guards a readFile path as a string', () => {
    const { specification } = createMockSpecification();
    const capability = specification.capabilityFactory({
      rootDir: '/root',
      methods: ['readFile'],
    });

    expect(methodGuards(capability).readFile).toStrictEqual(
      M.callWhen(M.string()).optional(M.any()).returns(M.any()),
    );
  });
});
