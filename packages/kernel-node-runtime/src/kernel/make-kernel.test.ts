import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { Logger } from '@metamask/logger';
import { Kernel } from '@metamask/ocap-kernel';
import { describe, expect, it, vi } from 'vitest';

import { makeKernel } from './make-kernel.ts';

vi.mock('@metamask/kernel-store/sqlite/nodejs', async () => {
  const { makeMapKernelDatabase } = await import(
    '../../../ocap-kernel/test/storage.ts'
  );
  return {
    makeSQLKernelDatabase: vi.fn(makeMapKernelDatabase),
  };
});

describe('makeKernel', () => {
  it('should return a Kernel', async () => {
    const { kernel } = await makeKernel({});

    expect(kernel).toBeInstanceOf(Kernel);
  });

  it('gives the kernel store a logger', async () => {
    await makeKernel({});

    expect(vi.mocked(makeSQLKernelDatabase)).toHaveBeenCalledWith(
      expect.objectContaining({ logger: expect.any(Logger) }),
    );
  });
});
