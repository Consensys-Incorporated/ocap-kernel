import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import type { KRef, VatId } from '@metamask/ocap-kernel';
import { describe, expect, it } from 'vitest';

import {
  extractTestLogs,
  getBundleSpec,
  makeKernel,
  makeTestLogger,
} from './utils.ts';

describe('logger', () => {
  it('captures logs from vat', async () => {
    const vatId = 'v1' as VatId;
    const name = 'Alice';
    const { logger, entries } = makeTestLogger();
    const database = await makeSQLKernelDatabase({});
    const kernel = await makeKernel(database, true, logger);
    const vat = await kernel.launchSubcluster({
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec('logger-vat'),
          parameters: { name },
        },
      },
    });
    expect(vat).toBeDefined();
    const vats = kernel.getVatIds();
    expect(vats).toStrictEqual([vatId]);

    await waitUntilQuiescent();
    await kernel.queueMessage('ko4' as KRef, 'foo', []);

    await waitUntilQuiescent();
    const vatLogs = extractTestLogs(entries, vatId);
    expect(vatLogs).toStrictEqual([`foo: ${name}`]);
  });
});
