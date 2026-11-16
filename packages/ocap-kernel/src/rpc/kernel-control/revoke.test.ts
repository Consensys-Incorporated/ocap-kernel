import { describe, it, expect, vi, beforeEach } from 'vitest';

import { revokeHandler } from './revoke.ts';
import { asKRef } from '../../../test/branded.ts';
import type { Kernel } from '../../Kernel.ts';

describe('revokeHandler', () => {
  let mockKernel: Kernel;
  beforeEach(() => {
    mockKernel = {
      revoke: vi.fn().mockResolvedValue(undefined),
    } as unknown as Kernel;
  });

  it('revokes the object and returns null', async () => {
    const kref = asKRef('ko1');
    const result = await revokeHandler.implementation(
      { kernel: mockKernel },
      { kref },
    );
    expect(mockKernel.revoke).toHaveBeenCalledWith(kref);
    expect(result).toBeNull();
  });

  it('propagates errors from kernel.revoke', async () => {
    const error = new Error('Revoke failed');
    vi.mocked(mockKernel.revoke).mockRejectedValue(error);
    const kref = asKRef('ko1');
    await expect(
      revokeHandler.implementation({ kernel: mockKernel }, { kref }),
    ).rejects.toThrow(error);
  });
});
