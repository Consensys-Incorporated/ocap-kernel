import { lstatSync, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { capabilityFactory } from './nodejs.ts';
import type { FsConfig } from './types.ts';

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

  describe('capabilityFactory', () => {
    describe.each([
      {
        operation: 'readFile',
        mockFn: fs.readFile,
        mockReturn: 'file content',
        additionalArg: { encoding: 'utf8' },
        additionalMockReturn: Buffer.from('file content'),
      },
      {
        operation: 'access',
        mockFn: fs.access,
        mockReturn: undefined,
        additionalArg: 0o644,
        additionalMockReturn: undefined,
      },
    ])(
      '$operation operation',
      ({
        operation,
        mockFn,
        mockReturn,
        additionalArg,
        additionalMockReturn,
      }) => {
        type TestCapability = Record<string, CallableFunction>;

        const makeCapability = (): TestCapability => {
          const config: FsConfig = {
            root: ['root'],
            methods: [operation],
          };
          return capabilityFactory(config) as unknown as TestCapability;
        };

        it('joins segments into a path for the underlying operation', async () => {
          vi.mocked(mockFn).mockResolvedValue(mockReturn as never);

          const result = await makeCapability()[operation]?.([
            'root',
            'file.txt',
          ]);

          expect(mockFn).toHaveBeenCalledWith('/root/file.txt');
          expect(result).toBe(mockReturn);
        });

        it('throws error for a path outside the root', async () => {
          await expect(
            makeCapability()[operation]?.(['outside', 'file.txt']),
          ).rejects.toThrow('is outside allowed root');
          expect(mockFn).not.toHaveBeenCalled();
        });

        it('throws error for a symlink', async () => {
          createMockLstatSync(true);

          await expect(
            makeCapability()[operation]?.(['root', 'file.txt']),
          ).rejects.toThrow('Symlinks are prohibited: /root/file.txt');
          expect(mockFn).not.toHaveBeenCalled();
        });

        it.each([
          { name: 'parent segments', segments: ['root', '..', '..', 'etc'] },
          { name: 'an embedded traversal', segments: ['root', '../../etc'] },
        ])('throws error for $name', async ({ segments }) => {
          await expect(makeCapability()[operation]?.(segments)).rejects.toThrow(
            'contains an invalid segment',
          );
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
