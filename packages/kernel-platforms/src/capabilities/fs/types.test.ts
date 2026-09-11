import { describe, expect, it } from 'vitest';

import { fsConfigStruct } from './types.ts';
import type { FsConfig } from './types.ts';
import { superstructValidationError } from '../../../test/utils.ts';

describe('fs types', () => {
  describe('fsConfigStruct', () => {
    it.each([
      { name: 'minimal config with rootDir', config: { rootDir: '/root' } },
      {
        name: 'config with rootDir and promises.readFile enabled',
        config: { rootDir: '/root', promises: { readFile: true } },
      },
      {
        name: 'config with rootDir and promises.access enabled',
        config: { rootDir: '/root', promises: { access: true } },
      },
      {
        name: 'config with all operations enabled',
        config: {
          rootDir: '/root',
          promises: {
            readFile: true,
            access: true,
          },
        },
      },
      {
        name: 'config with some operations disabled',
        config: {
          rootDir: '/root',
          promises: {
            readFile: true,
            access: false,
          },
        },
      },
      { name: 'config with empty string rootDir', config: { rootDir: '' } },
    ])('validates $name', ({ config }) => {
      expect(() => fsConfigStruct.create(config)).not.toThrow();
    });

    it.each([
      { name: 'config without rootDir', config: {} },
      { name: 'config with non-string rootDir', config: { rootDir: 123 } },
      {
        name: 'config with non-boolean promises.readFile',
        config: { rootDir: '/root', promises: { readFile: 'true' } },
      },
      {
        name: 'config with non-boolean promises.access',
        config: { rootDir: '/root', promises: { access: 'true' } },
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

      expect(validated.rootDir).toBe('/root');
      expect(validated.promises).toBeUndefined();
    });

    it('preserves boolean values', () => {
      const config: FsConfig = {
        rootDir: '/root',
        promises: {
          readFile: false,
          access: true,
        },
      };
      const validated = fsConfigStruct.create(config);

      expect(validated.rootDir).toBe('/root');
      expect(validated.promises?.readFile).toBe(false);
      expect(validated.promises?.access).toBe(true);
    });
  });
});
