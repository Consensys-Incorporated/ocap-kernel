import { GET_INTERFACE_GUARD } from '@endo/exo';
import { describe, expect, it } from 'vitest';

import { capabilityFactory } from './browser.ts';
import type { FsConfig } from './types.ts';

describe('fs browser capability', () => {
  describe('capabilityFactory', () => {
    it.each([
      { name: 'readFile', config: { root: ['root'], methods: ['readFile'] } },
      { name: 'access', config: { root: ['root'], methods: ['access'] } },
      {
        name: 'all operations',
        config: { root: ['root'], methods: ['readFile', 'access'] },
      },
    ] as { name: string; config: FsConfig }[])(
      'throws not implemented error for $name',
      ({ config }) => {
        expect(() => capabilityFactory(config)).toThrow(
          /Capability .* is not implemented in the browser/u,
        );
      },
    );

    it('creates capability with no operations', () => {
      const config: FsConfig = { root: ['root'] };
      const capability = capabilityFactory(config);

      expect(capability[GET_INTERFACE_GUARD]()).toBeDefined();
    });
  });
});
