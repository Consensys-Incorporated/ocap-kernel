import { Kernel } from '@metamask/ocap-kernel';
import { describe, expect, it, vi } from 'vitest';

import { makeKernel } from './make-kernel.ts';

vi.mock('@metamask/kernel-store/sqlite/nodejs', async () => {
  const { makeMapKernelDatabase } =
    await import('../../../ocap-kernel/test/storage.ts');
  return {
    makeSQLKernelDatabase: makeMapKernelDatabase,
  };
});

// `harden(Kernel)` freezes the class, so `vi.spyOn(Kernel, 'make')` throws
// "Cannot redefine property". Replacing the module binding sidesteps that.
vi.mock('@metamask/ocap-kernel', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Kernel: { make: vi.fn().mockResolvedValue({}) },
}));

const makeMock = vi.mocked(Kernel.make);

describe('makeKernel options', () => {
  it('forwards onRunLoopFailure to the kernel', async () => {
    const onRunLoopFailure = vi.fn();

    await makeKernel({ onRunLoopFailure });

    expect(makeMock.mock.calls[0]?.[2]).toMatchObject({ onRunLoopFailure });
  });

  // The conditional spread that forwards the option is the shape that silently
  // drops it, which would reinstate the outage the option exists to report.
  it('omits onRunLoopFailure when none is given', async () => {
    await makeKernel({});

    expect(makeMock).toHaveBeenCalledOnce();
    expect(makeMock.mock.calls[0]?.[2]).not.toHaveProperty('onRunLoopFailure');
  });
});
