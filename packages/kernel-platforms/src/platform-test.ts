import { describe, expect, it } from 'vitest';

import type { PlatformFactory } from './types.ts';

/**
 * Assertions every platform entry point shares.
 *
 * Constructing a capability is not among them: `fs` narrows its base, and
 * `narrow` forwards over `E()`, which cannot run under `mock-endoify`. A
 * platform built for real is covered in `@ocap/kernel-test`. What remains here
 * is config validation, which runs before any capability factory.
 *
 * @param makePlatform - The platform factory to check
 * @param platformName - The platform's name, for the suite title
 */
export const createPlatformTestSuite = (
  makePlatform: PlatformFactory,
  platformName: string,
): void => {
  describe(`${platformName} platform`, () => {
    it('exports makePlatform function', () => {
      expect(typeof makePlatform).toBe('function');
    });

    it('rejects a config naming an unregistered capability', async () => {
      await expect(
        makePlatform({ nope: {} } as unknown as Parameters<PlatformFactory>[0]),
      ).rejects.toThrow('unregistered capability');
    });

    it('rejects a config the capability struct refuses', async () => {
      await expect(
        makePlatform({
          fs: { root: 'tmp' },
        } as unknown as Parameters<PlatformFactory>[0]),
      ).rejects.toThrow();
    });
  });
};
