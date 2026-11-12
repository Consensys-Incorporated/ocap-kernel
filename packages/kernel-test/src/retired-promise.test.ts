import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, expect, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeTestLogger,
  runTestVats,
} from './utils.ts';

// Fails on main too, by another syscall: after sending the settled promise,
// bob's liveslots resolves it (`"kp2" was already resolved`). With c-list
// entries retired, bob instead dies sending it (`p-1 is not an export
// reference`).
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
