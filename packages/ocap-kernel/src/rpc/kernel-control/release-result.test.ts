import { describe, it, expect, vi } from 'vitest';

import { releaseResultHandler } from './release-result.ts';
import type { Kernel } from '../../Kernel.ts';
import { asKRef } from '../../../test/branded.ts';

describe('releaseResultHandler', () => {
  it('releases the result named by the kpid and returns null', async () => {
    const kernel = {
      releaseResult: vi.fn().mockResolvedValue(undefined),
    } as unknown as Kernel;

    const result = await releaseResultHandler.implementation({ kernel }, [
      asKRef('kp1'),
    ]);

    expect(kernel.releaseResult).toHaveBeenCalledWith({ kpid: 'kp1' });
    expect(result).toBeNull();
  });

  it('propagates the refusal of a result that is not held', async () => {
    const error = new Error('kp1 is not a held result');
    const kernel = {
      releaseResult: vi.fn().mockRejectedValue(error),
    } as unknown as Kernel;

    await expect(
      releaseResultHandler.implementation({ kernel }, [asKRef('kp1')]),
    ).rejects.toThrow(error);
  });
});
