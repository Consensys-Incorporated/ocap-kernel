import { describe, it, expect, vi, beforeEach } from 'vitest';

import { collectGarbageHandler } from './collect-garbage.ts';
import type { Kernel } from '../../Kernel.ts';

describe('collectGarbageHandler', () => {
  let mockKernel: Kernel;

  beforeEach(() => {
    mockKernel = {
      collectGarbage: vi.fn().mockResolvedValue(undefined),
    } as unknown as Kernel;
  });

  it('collects garbage', async () => {
    const result = await collectGarbageHandler.implementation(
      { kernel: mockKernel },
      [],
    );

    expect(mockKernel.collectGarbage).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('propagates errors from collectGarbage', async () => {
    const error = new Error('Collect garbage failed');
    vi.mocked(mockKernel.collectGarbage).mockRejectedValueOnce(error);
    await expect(
      collectGarbageHandler.implementation({ kernel: mockKernel }, []),
    ).rejects.toThrow(error);
  });
});
