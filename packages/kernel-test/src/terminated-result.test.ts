import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { makeKernelStore } from '@metamask/ocap-kernel';
import type { KRef, SubclusterId, VatId } from '@metamask/ocap-kernel';
import { describe, expect, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeMockLogger,
  runTestVats,
} from './utils.ts';

describe('queueMessage result of a terminated subcluster', () => {
  it('releases the returned object once its exporter is terminated', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const kernelStore = makeKernelStore(kernelDatabase);
    const kernel = await makeKernel(kernelDatabase, true, makeMockLogger());
    await runTestVats(kernel, {
      bootstrap: 'exporter',
      forceReset: true,
      vats: {
        exporter: {
          bundleSpec: getBundleSpec('exporter-vat'),
          parameters: { name: 'Exporter' },
        },
      },
    });
    const [subcluster] = kernel.getSubclusters();
    const exporterVatId = kernel.getVats()[0]?.id as VatId;
    const exporterKRef = kernelStore.getRootObject(exporterVatId) as KRef;
    const { slots } = await kernel.queueMessage(exporterKRef, 'createObject', [
      'gift',
    ]);
    const gift = slots[0] as KRef;
    expect(kernelStore.kernelRefExists(gift)).toBe(true);

    await kernel.terminateSubcluster(subcluster?.id as SubclusterId);
    await waitUntilQuiescent(500);
    kernel.collectGarbage();

    expect({
      refCount: kernelStore.getObjectRefCount(gift),
      pins: kernelStore.getPinCount(gift),
    }).toStrictEqual({ refCount: { reachable: 0, recognizable: 0 }, pins: 0 });
  });
});
