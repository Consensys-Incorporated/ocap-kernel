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

  it('should revoke object and return null', async () => {
    const kref = asKRef('ko1');
    const result = revokeHandler.implementation(
      { kernel: mockKernel },
      { kref },
    );
    expect(mockKernel.revoke).toHaveBeenCalledWith(kref);
    expect(result).toBeNull();
  });

  it('should propagate errors from kernel.revoke', () => {
    const error = new Error('Revoke failed');
    vi.mocked(mockKernel.revoke).mockImplementation(() => {
      throw error;
    });
    const kref = asKRef('ko1');
    expect(() =>
      revokeHandler.implementation({ kernel: mockKernel }, { kref }),
    ).toThrow(error);
  });
});
