import { lstatSync, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { relative } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { capabilityFactory } from './nodejs.ts';
import type { FsConfig, PathLike } from './types.ts';

/* eslint-disable n/no-sync */

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    access: vi.fn(),
  },
  readFile: vi.fn(),
  access: vi.fn(),
}));

// Mock fs
vi.mock('node:fs', () => ({
  lstatSync: vi.fn(),
}));

// Mock path
vi.mock('node:path', () => ({
  relative: vi.fn(),
}));

// Mock factories
const createMockStats = (isSymlink: boolean): Stats =>
  ({
    isSymbolicLink: () => isSymlink,
  }) as unknown as Stats;

const createMockRelative = (returnValue: string) =>
  vi.mocked(relative).mockReturnValue(returnValue);

const createMockLstatSync = (isSymlink: boolean) =>
  vi.mocked(lstatSync).mockReturnValue(createMockStats(isSymlink));

describe('fs nodejs capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mocks
    createMockLstatSync(false);
    createMockRelative('subdir/file.txt');
  });

  describe('caveat functions', () => {
    describe('makeNoSymlinksCaveat', () => {
      const createSymlinkCaveat = () => (path: PathLike) => {
        const pathString = path.toString();
        const stats = lstatSync(pathString);
        if (stats.isSymbolicLink()) {
          throw new Error(`Symlinks are prohibited: ${pathString}`);
        }
      };

      it('throws error for symlinks', () => {
        createMockLstatSync(true);
        const caveat = createSymlinkCaveat();

        expect(() => caveat('/symlink/path')).toThrow(
          'Symlinks are prohibited: /symlink/path',
        );
        expect(lstatSync).toHaveBeenCalledWith('/symlink/path');
      });

      it.each([
        {
          name: 'string',
          input: '/path',
        },
        {
          name: 'Buffer',
          input: Buffer.from('/path'),
        },
      ])('accepts $name paths', ({ input }) => {
        createMockLstatSync(false);
        const caveat = createSymlinkCaveat();

        expect(caveat(input)).toBeUndefined();
        expect(lstatSync).toHaveBeenCalledWith(input.toString());
      });
    });

    describe('makeRootCaveat', () => {
      const createRootCaveat = () => (path: PathLike) => {
        const pathString = path.toString();
        const relativePath = relative('/root', pathString);
        if (relativePath.startsWith('..')) {
          throw new Error(`Path ${pathString} is outside allowed root /root`);
        }
      };

      it('accepts paths within root directory', () => {
        createMockRelative('subdir/file.txt');
        const caveat = createRootCaveat();

        expect(caveat('/root/subdir/file.txt')).toBeUndefined();
        expect(relative).toHaveBeenCalledWith('/root', '/root/subdir/file.txt');
      });

      it.each([
        {
          name: 'outside root',
          input: '/outside/file.txt',
          relativeReturn: '../../outside/file.txt',
          expectedError: 'Path /outside/file.txt is outside allowed root /root',
        },
        {
          name: 'with root prefix but outside',
          input: '/root-other/file.txt',
          relativeReturn: '../../root-other/file.txt',
          expectedError:
            'Path /root-other/file.txt is outside allowed root /root',
        },
      ])(
        'throws error for paths $name',
        ({ input, relativeReturn, expectedError }) => {
          createMockRelative(relativeReturn);
          const caveat = createRootCaveat();

          expect(() => caveat(input)).toThrow(expectedError);
          expect(relative).toHaveBeenCalledWith('/root', input.toString());
        },
      );

      it('accepts root directory itself', () => {
        createMockRelative('');
        const caveat = createRootCaveat();

        expect(caveat('/root')).toBeUndefined();
        expect(relative).toHaveBeenCalledWith('/root', '/root');
      });
    });
  });

  describe('capabilityFactory', () => {
    describe.each([
      {
        operation: 'readFile',
        mockFn: fs.readFile,
        validArgs: ['/root/file.txt'],
        mockReturn: 'file content',
        additionalArgs: ['/root/file.txt', { encoding: 'utf8' }],
        additionalMockReturn: Buffer.from('file content'),
      },
      {
        operation: 'access',
        mockFn: fs.access,
        validArgs: ['/root/file.txt'],
        mockReturn: undefined,
        additionalArgs: ['/root/file.txt', 0o644],
        additionalMockReturn: undefined,
      },
    ])(
      '$operation operation',
      ({
        operation,
        mockFn,
        validArgs,
        mockReturn,
        additionalArgs,
        additionalMockReturn,
      }) => {
        type TestCapability = Record<string, CallableFunction>;

        const makeCapability = (): TestCapability => {
          const config: FsConfig = {
            rootDir: '/root',
            methods: [operation],
          };
          return capabilityFactory(config) as unknown as TestCapability;
        };

        it('returns expected result for valid path', async () => {
          vi.mocked(mockFn).mockResolvedValue(mockReturn as never);

          const result = await makeCapability()[operation]?.(...validArgs);
          expect(mockFn).toHaveBeenCalledWith(...validArgs);
          expect(result).toBe(mockReturn);
        });

        it.each([
          {
            name: 'outside root',
            relativeReturn: '../../outside/file.txt',
            isSymlink: false,
            expectedError: `Path ${validArgs[0]} is outside allowed root /root`,
          },
          {
            name: 'symlink',
            relativeReturn: '/root/file.txt',
            isSymlink: true,
            expectedError: `Symlinks are prohibited: ${validArgs[0]}`,
          },
        ])(
          'throws error for path $name',
          async ({ relativeReturn, isSymlink, expectedError }) => {
            createMockRelative(relativeReturn);
            createMockLstatSync(isSymlink);

            await expect(
              makeCapability()[operation]?.(...validArgs),
            ).rejects.toThrow(expectedError);
            expect(mockFn).not.toHaveBeenCalled();
          },
        );

        it('handles additional arguments correctly', async () => {
          vi.mocked(mockFn).mockResolvedValue(additionalMockReturn as never);

          const result = await makeCapability()[operation]?.(...additionalArgs);

          expect(mockFn).toHaveBeenCalledWith(...additionalArgs);
          expect(result).toBe(additionalMockReturn);
        });
      },
    );
  });
});

/* eslint-enable n/no-sync */
