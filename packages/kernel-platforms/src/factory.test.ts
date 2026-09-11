import { describe, expect, it, vi } from 'vitest';

import { makePlatformFactory } from './factory.ts';
import type { PlatformConfig, PlatformFactory } from './types.ts';

describe('makePlatformFactory', () => {
  const createMockFactories = () => ({
    fs: vi.fn().mockReturnValue({ readFile: vi.fn() }),
  });

  it('creates platform factory', () => {
    const mockFactories = createMockFactories();
    const platformFactory = makePlatformFactory(mockFactories);
    expect(typeof platformFactory).toBe('function');
  });

  it.each([
    {
      name: 'single capability',
      config: { fs: { root: ['tmp'] } },
      expectedCapabilities: ['fs'] as const,
      expectedOptions: {},
    },
    {
      name: 'with options',
      config: { fs: { root: ['tmp'] } },
      expectedCapabilities: ['fs'] as const,
      expectedOptions: { fs: { timeout: 5000 } },
    },
  ])(
    'creates platform with $name',
    async ({ config, expectedCapabilities, expectedOptions }) => {
      const mockFactories = createMockFactories();
      const platformFactory = makePlatformFactory(mockFactories);

      const platform = await platformFactory(
        config,
        expectedOptions as Parameters<PlatformFactory>[1],
      );

      expectedCapabilities.forEach((capability) => {
        expect(platform[capability as keyof typeof platform]).toBeDefined();
        expect(
          mockFactories[capability as keyof typeof mockFactories],
        ).toHaveBeenCalledWith(
          config[capability as keyof typeof config],
          expectedOptions[capability as keyof typeof expectedOptions] ?? {},
        );
      });
    },
  );

  it('creates platform with partial config', async () => {
    const mockFactories = createMockFactories();
    const platformFactory = makePlatformFactory(mockFactories);
    const config = { fs: { root: ['tmp'] } };

    const platform = await platformFactory(config);

    expect(platform.fs).toBeDefined();
  });

  it('throws for unregistered capability', async () => {
    const factories = { fs: vi.fn() };
    const platformFactory = makePlatformFactory(factories);
    const config = {
      fs: { root: ['tmp'] },
      unknown: {},
    } as Partial<PlatformConfig>;
    await expect(platformFactory(config)).rejects.toThrow(
      'Config provided entry for unregistered capability: unknown',
    );
  });
});
