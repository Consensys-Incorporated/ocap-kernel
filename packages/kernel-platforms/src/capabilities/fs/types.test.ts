import { describe, expect, it } from 'vitest';

import { fsConfigStruct } from './types.ts';
import type { FsConfig } from './types.ts';
import { superstructValidationError } from '../../../test/utils.ts';

describe('fs types', () => {
  describe('fsConfigStruct', () => {
    it.each([
      { name: 'minimal config with rootDir', config: { rootDir: '/root' } },
      {
        name: 'config with one method',
        config: { rootDir: '/root', methods: ['readFile'] },
      },
      {
        name: 'config with every method',
        config: { rootDir: '/root', methods: ['readFile', 'access'] },
      },
      {
        name: 'config with an empty method list',
        config: { rootDir: '/root', methods: [] },
      },
      { name: 'config with empty string rootDir', config: { rootDir: '' } },
    ])('validates $name', ({ config }) => {
      expect(() => fsConfigStruct.create(config)).not.toThrow();
    });

    it.each([
      { name: 'config without rootDir', config: {} },
      { name: 'config with non-string rootDir', config: { rootDir: 123 } },
      {
        name: 'config with an unknown method',
        config: { rootDir: '/root', methods: ['writeFile'] },
      },
      {
        name: 'config with a non-array methods',
        config: { rootDir: '/root', methods: 'readFile' },
      },
      {
        name: 'config with additional properties',
        config: { rootDir: '/root', extraProp: 'value' },
      },
    ])('rejects $name', ({ config }) => {
      expect(() => fsConfigStruct.create(config)).toThrow(
        superstructValidationError,
      );
    });

    it('allows undefined properties', () => {
      const config: FsConfig = { rootDir: '/root' };
      const validated = fsConfigStruct.create(config);

      expect(validated).toStrictEqual({ rootDir: '/root' });
    });

    it('preserves the method list', () => {
      const config: FsConfig = { rootDir: '/root', methods: ['readFile'] };
      const validated = fsConfigStruct.create(config);

      expect(validated).toStrictEqual({
        rootDir: '/root',
        methods: ['readFile'],
      });
    });
  });
});
