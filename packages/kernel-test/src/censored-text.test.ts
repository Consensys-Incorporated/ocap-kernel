import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, expect, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeTestLogger,
  runTestVats,
} from './utils.ts';

describe('censored text', () => {
  it('starts a vat whose strings SES would reject as source', async () => {
    const { logger } = makeTestLogger();
    const kernel = await makeKernel(
      await makeSQLKernelDatabase({}),
      true,
      logger,
    );
    const result = await runTestVats(kernel, {
      bootstrap: 'main',
      vats: { main: { bundleSpec: getBundleSpec('censored-text-vat') } },
    });
    expect(result).toStrictEqual([
      'Trailing comma is not allowed in import()',
      'see import(x)',
      '<!-- x',
      'x -->',
    ]);
  });
});
