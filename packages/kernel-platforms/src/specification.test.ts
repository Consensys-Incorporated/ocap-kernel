import { describe, expect, it, vi } from 'vitest';

import { superstructValidationError } from '../test/utils.ts';
import { fsConfigStruct } from './capabilities/fs/types.ts';
import type { FsConfig } from './capabilities/fs/types.ts';
import { makeCapabilitySpecification } from './specification.ts';

describe('makeCapabilitySpecification', () => {
  it('creates specification with configStruct and capabilityFactory', () => {
    const mockCapabilityFactory = vi.fn();
    const specification = makeCapabilitySpecification(
      fsConfigStruct,
      mockCapabilityFactory,
    );

    expect(specification).toHaveProperty('configStruct');
    expect(specification).toHaveProperty('capabilityFactory');
    expect(specification.configStruct).toBe(fsConfigStruct);
    expect(specification.capabilityFactory).toBe(mockCapabilityFactory);
  });

  it('validates config using configStruct', () => {
    const mockCapabilityFactory = vi.fn();
    const specification = makeCapabilitySpecification(
      fsConfigStruct,
      mockCapabilityFactory,
    );

    const validConfig: FsConfig = { root: ['tmp'] };
    expect(() => specification.configStruct.create(validConfig)).not.toThrow();
  });

  it('rejects invalid config using configStruct', () => {
    const mockCapabilityFactory = vi.fn();
    const specification = makeCapabilitySpecification(
      fsConfigStruct,
      mockCapabilityFactory,
    );

    const invalidConfig = { root: 123 };
    expect(() => specification.configStruct.create(invalidConfig)).toThrow(
      superstructValidationError,
    );
  });

  it('calls capabilityFactory with config and options', () => {
    const mockCapabilityFactory = vi.fn().mockReturnValue('mock-capability');
    const specification = makeCapabilitySpecification(
      fsConfigStruct,
      mockCapabilityFactory,
    );

    const config: FsConfig = { root: ['tmp'] };
    const options = { timeout: 5000 };

    const result = specification.capabilityFactory(config, options);

    expect(mockCapabilityFactory).toHaveBeenCalledWith(config, options);
    expect(result).toBe('mock-capability');
  });

  it('calls capabilityFactory with config only', () => {
    const mockCapabilityFactory = vi.fn().mockReturnValue('mock-capability');
    const specification = makeCapabilitySpecification(
      fsConfigStruct,
      mockCapabilityFactory,
    );

    const config: FsConfig = { root: ['tmp'] };

    const result = specification.capabilityFactory(config);

    expect(mockCapabilityFactory).toHaveBeenCalledWith(config);
    expect(result).toBe('mock-capability');
  });
});
