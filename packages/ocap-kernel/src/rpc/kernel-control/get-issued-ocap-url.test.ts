import { describe, it, expect, vi } from 'vitest';

import { getIssuedOcapURLHandler } from './get-issued-ocap-url.ts';
import { asKRef } from '../../../test/branded.ts';
import type { Kernel } from '../../Kernel.ts';

const makeKernel = (): Kernel =>
  ({
    getIssuedOcapURL: vi.fn().mockResolvedValue('ocap://peer123/ko1'),
  }) as unknown as Kernel;

describe('getIssuedOcapURLHandler', () => {
  it('returns a URL for the kref', async () => {
    const kernel = makeKernel();
    const kref = asKRef('ko1');

    const result = await getIssuedOcapURLHandler.implementation(
      { kernel },
      { kref },
    );

    expect({
      result,
      calls: vi.mocked(kernel.getIssuedOcapURL).mock.calls,
    }).toStrictEqual({ result: 'ocap://peer123/ko1', calls: [[kref]] });
  });

  it('propagates errors from kernel.getIssuedOcapURL', async () => {
    const kernel = makeKernel();
    const error = new Error('no ocap URL is issued for ko1');
    vi.mocked(kernel.getIssuedOcapURL).mockRejectedValue(error);

    await expect(
      getIssuedOcapURLHandler.implementation(
        { kernel },
        { kref: asKRef('ko1') },
      ),
    ).rejects.toThrow(error);
  });
});
