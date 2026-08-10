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
    // Wrapped so that a test can see what the database was constructed with,
    // while still getting a real store back.
    makeSQLKernelDatabase: vi.fn(makeMapKernelDatabase),
  };
});

describe('makeKernel', () => {
  it('should return a Kernel', async () => {
    const { kernel } = await makeKernel({});

    expect(kernel).toBeInstanceOf(Kernel);
  });

  // FAILING REPRO — see the commit message for this test.
  //
  // The kernel store is the only collaborator `makeKernel` builds without
  // handing it a logger, so every `logger?.` call inside the SQLite driver is
  // dead code in production — including the four abort failures #1012 added
  // logging for.
  it('gives the kernel store a logger', async () => {
    await makeKernel({});

    expect(makeSQLKernelDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ logger: expect.any(Logger) }),
    );
  });
});
