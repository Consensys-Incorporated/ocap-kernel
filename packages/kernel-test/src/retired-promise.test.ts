import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, expect, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeTestLogger,
  runTestVats,
} from './utils.ts';

describe('retired promises', () => {
  it('lets a vat resend a settled imported promise it keeps in virtual data', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const kernel = await makeKernel(
      kernelDatabase,
      true,
      makeTestLogger().logger,
    );
    const bundleSpec = getBundleSpec('retained-promise-vat');
    const result = await runTestVats(kernel, {
      bootstrap: 'alice',
      forceReset: true,
      vats: {
        alice: { bundleSpec },
        bob: { bundleSpec },
        carol: { bundleSpec },
      },
    });
    expect(result).toBe('hi');
  });
});
