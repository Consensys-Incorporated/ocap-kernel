import { describe, expect, it } from 'vitest';

import { capabilityFactory, configStruct } from './default.ts';
import { httpConfigStruct } from './types.ts';

describe('http default specification', () => {
  it('exports the config struct and a capability factory', () => {
    expect(configStruct).toBe(httpConfigStruct);
    expect(typeof capabilityFactory).toBe('function');
  });
});
