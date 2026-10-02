import { assert } from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';

import { platformConfigStruct } from './capabilities/index.ts';
import type {
  PlatformFactory,
  PlatformConfig,
  Platform,
  Capability,
  CapabilityName,
  CapabilityFactories,
  PlatformOptions,
} from './types.ts';

const validatePlatformConfig = (
  config: Infer<typeof platformConfigStruct>,
  known: CapabilityName[],
): void => {
  const configured = Object.keys(config) as CapabilityName[];
  if (configured.some((name) => !known.includes(name))) {
    throw new Error(
      `Config provided entry for unregistered capability: ${configured.find((name) => !known.includes(name))}`,
      { cause: { configured, known } },
    );
  }
  assert(config, platformConfigStruct);
};

/**
 * Creates a platform factory from capability factories
 *
 * @param capabilityFactories - The capability factories to use
 * @returns A platform factory function
 */
export const makePlatformFactory = <
  Factories extends Partial<CapabilityFactories>,
>(
  capabilityFactories: Factories,
): PlatformFactory<CapabilityName, Factories> => {
  const knownCapabilities = Object.keys(
    capabilityFactories,
  ) as CapabilityName[];

  /**
   * Creates a platform with the specified capabilities
   *
   * @param config - The configuration for the platform
   * @param options - The options for the platform
   * @returns An object with the specified capabilities
   */
  const createPlatform = async (
    config: Partial<PlatformConfig>,
    options?: Partial<PlatformOptions<Factories>>,
  ): Promise<Platform<keyof typeof config>> => {
    validatePlatformConfig(config, knownCapabilities);

    // A factory may be async — `fs` builds its exo and then narrows it, and
    // `narrow` reads the base's guard over `E()`.
    const capabilityEntries = await Promise.all(
      Object.entries(config).map(async ([name, capabilityConfig]) => {
        const factory =
          capabilityFactories[name as (typeof knownCapabilities)[number]];
        if (!factory) {
          throw new Error(`No factory found for capability: ${name}`);
        }

        const capabilityOptions = options?.[name as keyof typeof config] ?? {};

        // The `any` type assertion is necessary here because TypeScript cannot infer that:
        // 1. The factory for 'name' is specifically typed for that capability
        // 2. The config for 'name' matches the factory's expected config type
        // 3. The generic constraints align between the factory and config
        // This is a limitation of TypeScript's type system with dynamic property access
        const capability = await factory(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          capabilityConfig as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          capabilityOptions as any,
        );

        return [name, harden(capability)] as [
          keyof typeof config,
          Capability<keyof typeof config>,
        ];
      }),
    );

    const platform = Object.fromEntries(capabilityEntries) as Platform<
      keyof typeof config
    >;
    return harden(platform);
  };

  return harden(createPlatform);
};
