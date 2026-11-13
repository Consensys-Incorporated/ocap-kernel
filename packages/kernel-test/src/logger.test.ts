import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Logger, makeArrayTransport } from '@metamask/logger';
import type { LogEntry } from '@metamask/logger';
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

  it('leaves logged objects mutable under lockdown', () => {
    class Thing {
      value = 1;
    }
    const thing = new Thing();
    const history = [{ step: 1 }];
    const entries: LogEntry[] = [];
    const logger = new Logger({ transports: [makeArrayTransport(entries)] });

    logger.info('history:', history, thing);
    history.push({ step: 2 });
    thing.value = 2;

    expect(entries).toStrictEqual([
      {
        level: 'info',
        tags: [],
        message: 'history:',
        data: [[{ step: 1 }], thing],
      },
    ]);
    expect(Object.isFrozen(entries[0]?.data?.[0])).toBe(true);
  });
});
