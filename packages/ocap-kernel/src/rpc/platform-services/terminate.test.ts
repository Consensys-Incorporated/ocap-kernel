import { is } from '@metamask/superstruct';
import { describe, it, expect, vi } from 'vitest';

import type { Terminate } from './terminate.ts';
import { terminateSpec, terminateHandler } from './terminate.ts';
import type { VatId } from '../../types.ts';

describe('terminate', () => {
  describe('terminateSpec', () => {
    it('should have correct method name', () => {
      expect(terminateSpec.method).toBe('terminate');
    });

    it('should have correct result type', () => {
      // Test that result validator accepts null
      expect(is(null, terminateSpec.result)).toBe(true);
      expect(is('string', terminateSpec.result)).toBe(false);
      expect(is(123, terminateSpec.result)).toBe(false);
      expect(is(undefined, terminateSpec.result)).toBe(false);
    });

    describe('params validation', () => {
      it('should accept valid params', () => {
        const validParams = {
          vatId: 'v123',
        };

        expect(is(validParams, terminateSpec.params)).toBe(true);
      });

      it('should reject params with missing vatId', () => {
        const invalidParams = {};

        expect(is(invalidParams, terminateSpec.params)).toBe(false);
      });

      it('should reject params with non-string vatId', () => {
        const invalidParams = {
          vatId: 123,
        };

        expect(is(invalidParams, terminateSpec.params)).toBe(false);
      });

      it('should reject params with extra fields', () => {
        const invalidParams = {
          vatId: 'vat-123',
          extra: 'field',
        };

        expect(is(invalidParams, terminateSpec.params)).toBe(false);
      });

      it('should reject null params', () => {
        expect(is(null, terminateSpec.params)).toBe(false);
      });

      it('should reject undefined params', () => {
        expect(is(undefined, terminateSpec.params)).toBe(false);
      });

      it('should reject non-object params', () => {
        expect(is('string', terminateSpec.params)).toBe(false);
        expect(is(123, terminateSpec.params)).toBe(false);
        expect(is([], terminateSpec.params)).toBe(false);
      });

      it('should accept valid numeric vatId', () => {
        const validParams = {
          vatId: 'v1',
        };

        expect(is(validParams, terminateSpec.params)).toBe(true);
      });

      it('should reject invalid vatId format', () => {
        const invalidParams = {
          vatId: 'invalid-format',
        };

        expect(is(invalidParams, terminateSpec.params)).toBe(false);
      });

      it('should accept large numeric vatId', () => {
        const validParams = {
          vatId: 'v999999',
        };

        expect(is(validParams, terminateSpec.params)).toBe(true);
      });
    });
  });

  describe('terminateHandler', () => {
    it('should have correct method name', () => {
      expect(terminateHandler.method).toBe('terminate');
    });

    it('should have correct hooks configuration', () => {
      expect(terminateHandler.hooks).toStrictEqual({
        terminate: true,
      });
    });

    it('should call the terminate hook with correct parameters', async () => {
      const mockTerminate: Terminate = vi.fn(async () => null);

      const hooks = {
        terminate: mockTerminate,
      };

      const params = {
        vatId: 'vat-123' as VatId,
      };

      const result = await terminateHandler.implementation(hooks, params);

      expect(mockTerminate).toHaveBeenCalledTimes(1);
      expect(mockTerminate).toHaveBeenCalledWith('vat-123');
      expect(result).toBeNull();
    });

    it('should return null from the hook', async () => {
      const mockTerminate: Terminate = vi.fn(async () => null);

      const hooks = {
        terminate: mockTerminate,
      };

      const params = {
        vatId: 'test-vat-id' as VatId,
      };

      const result = await terminateHandler.implementation(hooks, params);

      expect(result).toBeNull();
    });

    it('should propagate errors from the hook', async () => {
      const mockTerminate: Terminate = vi.fn(async () => {
        throw new Error('Termination failed');
      });

      const hooks = {
        terminate: mockTerminate,
      };

      const params = {
        vatId: 'failing-vat' as VatId,
      };

      await expect(
        terminateHandler.implementation(hooks, params),
      ).rejects.toThrow('Termination failed');
    });

    it('should handle empty string vatId', async () => {
      const mockTerminate: Terminate = vi.fn(async () => null);

      const hooks = {
        terminate: mockTerminate,
      };

      const params = {
        vatId: '' as VatId,
      };

      await terminateHandler.implementation(hooks, params);

      expect(mockTerminate).toHaveBeenCalledWith('');
    });

    it('should handle unicode characters in vatId', async () => {
      const mockTerminate: Terminate = vi.fn(async () => null);

      const hooks = {
        terminate: mockTerminate,
      };

      const params = {
        vatId: '🌟vat-123🌟' as VatId,
      };

      await terminateHandler.implementation(hooks, params);

      expect(mockTerminate).toHaveBeenCalledWith('🌟vat-123🌟');
    });

    it('should handle async hook that returns a Promise', async () => {
      const mockTerminate: Terminate = vi.fn(async () => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 1));
        return null;
      });

      const hooks = {
        terminate: mockTerminate,
      };

      const params = {
        vatId: 'async-vat' as VatId,
      };

      const result = await terminateHandler.implementation(hooks, params);

      expect(result).toBeNull();
    });

    it.each([
      { error: new Error('Network error'), vatId: 'v1' as VatId },
      { error: new TypeError('Type error'), vatId: 'v2' as VatId },
      { error: new Error('String error'), vatId: 'v3' as VatId },
      { error: new Error('Object error'), vatId: 'v4' as VatId },
    ])(
      'should handle termination error: $error.message for vat $vatId',
      async ({ error, vatId }) => {
        const mockTerminate: Terminate = vi.fn(async () => {
          throw error;
        });

        const hooks = {
          terminate: mockTerminate,
        };

        const params = {
          vatId,
        };

        await expect(
          terminateHandler.implementation(hooks, params),
        ).rejects.toThrow(error);

        expect(mockTerminate).toHaveBeenCalledWith(vatId);
      },
    );
  });
});
