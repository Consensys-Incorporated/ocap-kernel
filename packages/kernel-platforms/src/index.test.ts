import { describe, expect, it } from 'vitest';

import { platformConfigStruct } from './index.ts';
import type { CapabilityName, Capability, CapabilityConfig } from './index.ts';

describe('kernel-platforms index', () => {
  it('exports platformConfigStruct', () => {
    expect(platformConfigStruct).toBeDefined();
    expect(typeof platformConfigStruct.create).toBe('function');
  });

  it('exports type definitions', () => {
    const capabilityName: CapabilityName = 'fs';
    expect(capabilityName).toBe('fs');

    // oxlint-disable-next-line typescript/no-unused-vars
    type TestCapability = Capability<'fs'>;
    // oxlint-disable-next-line typescript/no-unused-vars
    type TestConfig = CapabilityConfig<'fs'>;

    expect(true).toBe(true);
  });
});
