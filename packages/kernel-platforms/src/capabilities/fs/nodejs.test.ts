import { lstatSync, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { makeNoSymlinksCaveat, toPath } from './nodejs.ts';
import { makeFsBase } from './shared.ts';

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

// Mock factories
const createMockStats = (isSymlink: boolean): Stats =>
  ({
    isSymbolicLink: () => isSymlink,
  }) as unknown as Stats;

const createMockLstatSync = (isSymlink: boolean) =>
  vi.mocked(lstatSync).mockReturnValue(createMockStats(isSymlink));

describe('fs nodejs capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMockLstatSync(false);
  });

  describe('fs base', () => {
    describe.each([
      {
        operation: 'readFile',
        mockFn: fs.readFile,
        mockReturn: 'file content',
        requiredArgs: ['utf8'],
        additionalArg: 'utf8',
        additionalMockReturn: 'file content',
      },
      {
        operation: 'access',
        mockFn: fs.access,
        mockReturn: undefined,
        requiredArgs: [] as unknown[],
        additionalArg: 0o644,
        additionalMockReturn: undefined,
      },
    ])(
      '$operation operation',
      ({
        operation,
        mockFn,
        mockReturn,
        requiredArgs,
        additionalArg,
        additionalMockReturn,
      }) => {
        type TestCapability = Record<string, CallableFunction>;

        // Built from the module's own `toPath` and symlink caveat. The
        // configured capability narrows this base, and `narrow` forwards over
        // `E()`, which cannot run under `mock-endoify` — see `shared.test.ts`.
        const makeCapability = (): TestCapability =>
          makeFsBase({
            makeReadFile: () => fs.readFile,
            makeAccess: () => fs.access,
            makePathCaveat: makeNoSymlinksCaveat,
            toPath,
          }) as unknown as TestCapability;

        it('joins segments into a path for the underlying operation', async () => {
          vi.mocked(mockFn).mockResolvedValue(mockReturn as never);

          const result = await makeCapability()[operation]?.(
            ['root', 'file.txt'],
            ...requiredArgs,
          );

          expect(mockFn).toHaveBeenCalledWith(
            '/root/file.txt',
            ...requiredArgs,
          );
          expect(result).toBe(mockReturn);
        });

        it('throws error for a symlink', async () => {
          createMockLstatSync(true);

          await expect(
            makeCapability()[operation]?.(
              ['root', 'file.txt'],
              ...requiredArgs,
            ),
          ).rejects.toThrow('Symlinks are prohibited: /root/file.txt');
          expect(mockFn).not.toHaveBeenCalled();
        });

        it.each([
          { name: 'parent segments', segments: ['root', '..', '..', 'etc'] },
          { name: 'an embedded traversal', segments: ['root', '../../etc'] },
        ])('throws error for $name', async ({ segments }) => {
          await expect(
            makeCapability()[operation]?.(segments, ...requiredArgs),
          ).rejects.toThrow('contains an invalid segment');
          expect(mockFn).not.toHaveBeenCalled();
        });

        it('handles additional arguments correctly', async () => {
          vi.mocked(mockFn).mockResolvedValue(additionalMockReturn as never);

          const result = await makeCapability()[operation]?.(
            ['root', 'file.txt'],
            additionalArg,
          );

          expect(mockFn).toHaveBeenCalledWith('/root/file.txt', additionalArg);
          expect(result).toBe(additionalMockReturn);
        });
      },
    );
  });
});

/* eslint-enable n/no-sync */
