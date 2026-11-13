import { is } from '@metamask/superstruct';
import { describe, it, expect, vi } from 'vitest';

import type { HandleLaunch } from './launch.ts';
import { launchSpec, launchHandler } from './launch.ts';
import type { VatConfig, VatId } from '../../types.ts';

describe('launch', () => {
  describe('launchSpec', () => {
    it('should have correct method name', () => {
      expect(launchSpec.method).toBe('launch');
    });

    it('should have correct result type', () => {
      // Test that result validator accepts null
      expect(is(null, launchSpec.result)).toBe(true);
      expect(is('string', launchSpec.result)).toBe(false);
      expect(is(123, launchSpec.result)).toBe(false);
      expect(is(undefined, launchSpec.result)).toBe(false);
    });

    describe('params validation', () => {
      it('should accept valid params with minimal vat config', () => {
        const validParams = {
          vatId: 'v123',
          vatConfig: {
            bundleName: 'test-vat',
          },
        };

        expect(is(validParams, launchSpec.params)).toBe(true);
      });

      it('should accept valid params with full vat config', () => {
        const validParams = {
          vatId: 'v456',
          vatConfig: {
            bundleName: 'full-test-vat',
            creationOptions: {
              virtualObjectCacheSize: 100,
              enablePipelining: true,
              managerType: 'local',
              enableDisavow: false,
              useTranscript: true,
              reapInterval: 1000,
              critical: false,
            },
            parameters: {
              key: 'value',
              number: 42,
            },
          },
        };

        expect(is(validParams, launchSpec.params)).toBe(true);
      });

      it('should reject params with missing vatId', () => {
        const invalidParams = {
          vatConfig: {
            bundleName: 'test-vat',
          },
        };

        expect(is(invalidParams, launchSpec.params)).toBe(false);
      });

      it('should reject params with missing vatConfig', () => {
        const invalidParams = {
          vatId: 'vat-123',
        };

        expect(is(invalidParams, launchSpec.params)).toBe(false);
      });

      it('should reject params with non-string vatId', () => {
        const invalidParams = {
          vatId: 123,
          vatConfig: {
            bundleName: 'test-vat',
          },
        };

        expect(is(invalidParams, launchSpec.params)).toBe(false);
      });

      it('should reject params with invalid vatConfig structure', () => {
        const invalidParams = {
          vatId: 'vat-123',
          vatConfig: {
            // missing required bundleName, sourceSpec, or bundleSpec field
            invalidField: 'invalid-value',
          },
        };

        expect(is(invalidParams, launchSpec.params)).toBe(false);
      });

      it('should reject params with extra fields', () => {
        const invalidParams = {
          vatId: 'vat-123',
          vatConfig: {
            bundleName: 'test-vat',
          },
          extra: 'field',
        };

        expect(is(invalidParams, launchSpec.params)).toBe(false);
      });
    });
  });

  describe('launchHandler', () => {
    it('should have correct method name', () => {
      expect(launchHandler.method).toBe('launch');
    });

    it('should have correct hooks configuration', () => {
      expect(launchHandler.hooks).toStrictEqual({
        launch: true,
      });
    });

    it('should call the launch hook with correct parameters', async () => {
      const mockLaunch: HandleLaunch = vi.fn(async () => null);

      const hooks = {
        launch: mockLaunch,
      };

      const params = {
        vatId: 'vat-123' as VatId,
        vatConfig: {
          bundleName: 'test-vat',
        },
      };

      const result = await launchHandler.implementation(hooks, params);

      expect(mockLaunch).toHaveBeenCalledTimes(1);
      expect(mockLaunch).toHaveBeenCalledWith('vat-123', {
        bundleName: 'test-vat',
      });
      expect(result).toBeNull();
    });

    it('should return null from the hook', async () => {
      const mockLaunch: HandleLaunch = vi.fn(async () => null);

      const hooks = {
        launch: mockLaunch,
      };

      const params = {
        vatId: 'test-vat-id' as VatId,
        vatConfig: {
          bundleName: 'test-vat-name',
        },
      };

      const result = await launchHandler.implementation(hooks, params);

      expect(result).toBeNull();
    });

    it('should propagate errors from the hook', async () => {
      const mockLaunch: HandleLaunch = vi.fn(async () => {
        throw new Error('Launch failed');
      });

      const hooks = {
        launch: mockLaunch,
      };

      const params = {
        vatId: 'failing-vat' as VatId,
        vatConfig: {
          bundleName: 'failing-vat',
        },
      };

      await expect(launchHandler.implementation(hooks, params)).rejects.toThrow(
        'Launch failed',
      );
    });

    it('should handle complex vat configurations', async () => {
      const mockLaunch: HandleLaunch = vi.fn(async () => null);

      const hooks = {
        launch: mockLaunch,
      };

      const complexVatConfig = {
        bundleName: 'complex-vat',
        creationOptions: {
          virtualObjectCacheSize: 500,
          enablePipelining: false,
          managerType: 'local' as const,
          enableDisavow: true,
          useTranscript: false,
          reapInterval: 2000,
          critical: true,
        },
        parameters: {
          config: { nested: { value: true } },
          array: [1, 2, 3],
          string: 'test',
        },
      };

      const params = {
        vatId: 'complex-vat-id' as VatId,
        vatConfig: complexVatConfig as VatConfig,
      };

      await launchHandler.implementation(hooks, params);

      expect(mockLaunch).toHaveBeenCalledWith(
        'complex-vat-id',
        complexVatConfig,
      );
    });

    it('should handle async hook that returns a Promise', async () => {
      const mockLaunch: HandleLaunch = vi.fn(async () => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 1));
        return null;
      });

      const hooks = {
        launch: mockLaunch,
      };

      const params = {
        vatId: 'async-vat' as VatId,
        vatConfig: {
          bundleName: 'async-vat',
        },
      };

      const result = await launchHandler.implementation(hooks, params);

      expect(result).toBeNull();
    });
  });
});
