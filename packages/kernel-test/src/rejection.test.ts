import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import type { VatId } from '@metamask/ocap-kernel';
import { describe, expect, it } from 'vitest';

import {
  extractTestLogs,
  getBundleSpec,
  makeKernel,
  makeTestLogger,
} from './utils.ts';

describe('rejection', () => {
  it('throwing from remotable method rejects result', async () => {
    const vatIds: VatId[] = ['v1' as VatId, 'v2' as VatId];
    const { logger, entries } = makeTestLogger();
    const database = await makeSQLKernelDatabase({});
    const kernel = await makeKernel(database, true, logger);
    const vat = await kernel.launchSubcluster({
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec('rejection-bootstrap'),
          parameters: {},
        },
        rejector: {
          bundleSpec: getBundleSpec('rejection-rejector'),
          parameters: {},
        },
      },
    });
    expect(vat).toBeDefined();
    const vats = kernel.getVatIds();
    expect([...vats].sort()).toStrictEqual([...vatIds].sort());

    await waitUntilQuiescent();
    const vatLogs = vatIds.map((vatId) => extractTestLogs(entries, vatId));
    expect(vatLogs).toStrictEqual([
      ['bar', 'err', 'bar'],
      ['resolve', 'reject', 'resolve'],
    ]);
  });
});
