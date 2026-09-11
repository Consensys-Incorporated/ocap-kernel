import { describe, expect, it, vi } from 'vitest';

import { makeCaveatedFsOperation, makeFsSpecification } from './shared.ts';
import type { ReadFile, Access, SyncPathCaveat } from './types.ts';

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

    return {
      specification: makeFsSpecification({
        promises: {
          makeReadFile: () => mockReadFile,
          makeAccess: () => mockAccess,
        },
        makePathCaveat: () => mockPathCaveat,
      }),
      mockReadFile,
      mockAccess,
      mockPathCaveat,
    };
  };

  it('creates specification with all capabilities enabled', () => {
    const { specification } = createMockSpecification();

    expect(specification).toHaveProperty('configStruct');
    expect(specification).toHaveProperty('capabilityFactory');
  });

  it('creates capability with promises.readFile', () => {
    const { specification } = createMockSpecification();
    const config = { rootDir: '/root', promises: { readFile: true } };
    const capability = specification.capabilityFactory(config);

    expect(capability).toHaveProperty('promises');
    expect(capability.promises).toHaveProperty('readFile');
    expect(capability.promises).not.toHaveProperty('access');
  });

  it('creates capability with promises.access', () => {
    const { specification } = createMockSpecification();
    const config = { rootDir: '/root', promises: { access: true } };
    const capability = specification.capabilityFactory(config);

    expect(capability).toHaveProperty('promises');
    expect(capability.promises).not.toHaveProperty('readFile');
    expect(capability.promises).toHaveProperty('access');
  });

  it('creates capability with all operations', () => {
    const { specification } = createMockSpecification();
    const config = {
      rootDir: '/root',
      promises: {
        readFile: true,
        access: true,
      },
    };
    const capability = specification.capabilityFactory(config);

    expect(capability).toHaveProperty('promises');
    expect(capability.promises).toHaveProperty('readFile');
    expect(capability.promises).toHaveProperty('access');
  });

  it('creates capability with no operations', () => {
    const { specification } = createMockSpecification();
    const config = { rootDir: '/root' };
    const capability = specification.capabilityFactory(config);

    expect(capability).not.toHaveProperty('promises');
  });
});
