import { describe, expect, it } from 'vitest';

import { fsConfigStruct } from './types.ts';
import type { FsConfig } from './types.ts';
import { superstructValidationError } from '../../../test/utils.ts';

describe('fs types', () => {
  describe('fsConfigStruct', () => {
    it.each([
      { name: 'minimal config with root', config: { root: ['root'] } },
      {
        name: 'config with a multi-segment root',
        config: { root: ['srv', 'data'] },
      },
      {
        name: 'config with a drive-prefixed root',
        config: { root: ['C:', 'srv'] },
      },
      {
        name: 'config with one method',
        config: { root: ['root'], methods: ['readFile'] },
      },
      {
        name: 'config with every method',
        config: { root: ['root'], methods: ['readFile', 'access'] },
      },
      {
        name: 'config with an empty method list',
        config: { root: ['root'], methods: [] },
      },
    ])('validates $name', ({ config }) => {
      expect(() => fsConfigStruct.create(config)).not.toThrow();
    });

    it.each([
      { name: 'config without root', config: {} },
      { name: 'config with a non-array root', config: { root: 123 } },
      { name: 'config with a non-string segment', config: { root: [123] } },
      // An empty root would denote the whole filesystem.
      { name: 'config with an empty root', config: { root: [] } },
      {
        name: 'config with an unknown method',
        config: { root: ['root'], methods: ['writeFile'] },
      },
      {
        name: 'config with a non-array methods',
        config: { root: ['root'], methods: 'readFile' },
      },
      {
        name: 'config with additional properties',
        config: { root: ['root'], extraProp: 'value' },
      },
    ])('rejects $name', ({ config }) => {
      expect(() => fsConfigStruct.create(config)).toThrow(
        superstructValidationError,
      );
    });

    it('allows undefined properties', () => {
      const config: FsConfig = { root: ['root'] };
      const validated = fsConfigStruct.create(config);

      expect(validated).toStrictEqual({ root: ['root'] });
    });

    it('preserves the method list', () => {
      const config: FsConfig = { root: ['root'], methods: ['readFile'] };
      const validated = fsConfigStruct.create(config);

      expect(validated).toStrictEqual({
        root: ['root'],
        methods: ['readFile'],
      });
    });
  });
});
