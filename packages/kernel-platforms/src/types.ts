import type { PlatformCapabilityRegistry } from './capabilities/index.ts';

export type CapabilityName = keyof PlatformCapabilityRegistry;

export type Capability<Name extends CapabilityName> =
  PlatformCapabilityRegistry[Name]['capability'];

export type CapabilityConfig<Name extends CapabilityName> =
  PlatformCapabilityRegistry[Name]['config'];

export type CapabilityFactory<Name extends CapabilityName, Options = never> = (
  config: CapabilityConfig<Name>,
  options?: Options,
) => Capability<Name> | Promise<Capability<Name>>;

export type CapabilityFactories = {
  [Key in CapabilityName]: CapabilityFactory<Key>;
};

export type Platform<Name extends CapabilityName> = {
  [Key in Name]: PlatformCapabilityRegistry[Key]['capability'];
};

export type PlatformConfig<Name extends CapabilityName = CapabilityName> = {
  [Key in Name]: PlatformCapabilityRegistry[Key]['config'];
};

/**
 * Extracts the options type from a capability factory
 */
export type ExtractCapabilityOptions<Factory> =
  Factory extends CapabilityFactory<never, infer Options> ? Options : never;

/**
 * Maps capability names to their factory options types
 */
export type PlatformOptions<Factories extends Partial<CapabilityFactories>> = {
  [Key in keyof Factories]: ExtractCapabilityOptions<Factories[Key]>;
};

export type PlatformFactory<
  KnownCapabilities extends CapabilityName = CapabilityName,
  Factories extends Partial<CapabilityFactories> = Partial<CapabilityFactories>,
> = (
  config: Partial<PlatformConfig<KnownCapabilities>>,
  options?: Partial<PlatformOptions<Factories>>,
) => Promise<Platform<keyof typeof config>>;
