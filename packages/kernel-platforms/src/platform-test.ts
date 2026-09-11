import { describe, expect, it } from 'vitest';

import type { PlatformFactory } from './types.ts';

export const createPlatformTestSuite = (
  makePlatform: PlatformFactory,
  platformName: string,
): void => {
  describe(`${platformName} platform`, () => {
    it('exports makePlatform function', () => {
      expect(typeof makePlatform).toBe('function');
    });

    it.each([
      {
        name: 'fs capability',
        config: { fs: { root: ['tmp'] } },
        expectedFs: { type: 'object' },
      },
    ])('creates platform with $name', async ({ config, expectedFs }) => {
      const platform = await makePlatform(config);
      expect(typeof platform.fs).toBe(expectedFs.type);
    });

    it('creates platform with partial config', async () => {
      const config = { fs: { root: ['tmp'] } };
      const platform = await makePlatform(config);

      expect(platform.fs).toBeDefined();
      expect(typeof platform.fs).toBe('object');
    });
  });
};
