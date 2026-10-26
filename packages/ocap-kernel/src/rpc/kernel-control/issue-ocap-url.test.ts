import { describe, it, expect, vi, beforeEach } from 'vitest';

import { issueOcapURLHandler } from './issue-ocap-url.ts';
import { asKRef } from '../../../test/branded.ts';
import type { Kernel } from '../../Kernel.ts';

describe('issueOcapURLHandler', () => {
  let mockKernel: Kernel;
  beforeEach(() => {
    mockKernel = {
      issueOcapURL: vi.fn().mockResolvedValue('ocap://peer123/ko1'),
    } as unknown as Kernel;
  });

  it('returns the issued OCAP URL', async () => {
    const kref = asKRef('ko1');
    const result = await issueOcapURLHandler.implementation(
      { kernel: mockKernel },
      { kref },
    );
    expect(mockKernel.issueOcapURL).toHaveBeenCalledWith(kref);
    expect(result).toBe('ocap://peer123/ko1');
  });

  it('propagates errors from kernel.issueOcapURL', async () => {
    const error = new Error('Remote comms not initialized');
    vi.mocked(mockKernel.issueOcapURL).mockRejectedValue(error);
    await expect(
      issueOcapURLHandler.implementation(
        { kernel: mockKernel },
        { kref: asKRef('ko1') },
      ),
    ).rejects.toThrow(error);
  });
});
