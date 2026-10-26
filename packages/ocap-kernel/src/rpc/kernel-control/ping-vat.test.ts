import { describe, it, expect, vi, beforeEach } from 'vitest';

import { pingVatHandler } from './ping-vat.ts';
import type { Kernel } from '../../Kernel.ts';
import type { VatId } from '../../types.ts';

describe('pingVatHandler', () => {
  let mockKernel: Kernel;

  beforeEach(() => {
    mockKernel = {
      pingVat: vi.fn().mockResolvedValue('pong'),
    } as unknown as Kernel;
  });

  it('should ping vat and return result', async () => {
    const params = { id: 'v0' as VatId };
    const result = await pingVatHandler.implementation(
      { kernel: mockKernel },
      params,
    );

    expect(mockKernel.pingVat).toHaveBeenCalledWith(params.id);
    expect(result).toBe('pong');
  });

  it('should propagate errors from kernel.pingVat', async () => {
    const error = new Error('Ping failed');
    vi.mocked(mockKernel.pingVat).mockRejectedValueOnce(error);

    const params = { id: 'v0' as VatId };
    await expect(
      pingVatHandler.implementation({ kernel: mockKernel }, params),
    ).rejects.toThrow(error);
  });
});
