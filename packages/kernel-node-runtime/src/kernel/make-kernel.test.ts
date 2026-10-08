import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { Logger, makeArrayTransport } from '@metamask/logger';
import type { LogEntry } from '@metamask/logger';
import { Kernel } from '@metamask/ocap-kernel';
import { describe, expect, it, vi } from 'vitest';

import { makeKernel } from './make-kernel.ts';
import { assertSupportedPlatform } from '../platform.ts';

vi.mock('@metamask/kernel-store/sqlite/nodejs', async () => {
  const { makeMapKernelDatabase } = await import(
    '../../../ocap-kernel/test/storage.ts'
  );
  return {
    makeSQLKernelDatabase: vi.fn(makeMapKernelDatabase),
  };
});

vi.mock('../platform.ts', () => ({
  assertSupportedPlatform: vi.fn(),
}));

describe('makeKernel', () => {
  it('should return a Kernel', async () => {
    const { kernel } = await makeKernel({});

    expect(kernel).toBeInstanceOf(Kernel);
  });

  it('gives the kernel store a tagged sub-logger', async () => {
    const entries: LogEntry[] = [];
    const logger = new Logger({ transports: [makeArrayTransport(entries)] });

    await makeKernel({ logger });

    const storeLogger = vi.mocked(makeSQLKernelDatabase).mock.calls[0]?.[0]
      .logger;
    storeLogger?.debug('diagnostic');
    expect(entries.at(-1)).toMatchObject({
      tags: ['kernel-store'],
      message: 'diagnostic',
    });
  });

  it('checks the platform before opening the database', async () => {
    vi.mocked(assertSupportedPlatform).mockImplementationOnce(() => {
      throw new Error('unsupported');
    });

    await expect(makeKernel({})).rejects.toThrow('unsupported');
    expect(makeSQLKernelDatabase).not.toHaveBeenCalled();
  });
});
