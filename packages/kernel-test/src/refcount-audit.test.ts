import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { makeKernelStore } from '@metamask/ocap-kernel';
import type { KRef, VatId } from '@metamask/ocap-kernel';
import { expect, describe, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeMockLogger,
  runTestVats,
} from './utils.ts';

/**
 * The per-crank audit throws from inside the run loop, which nothing restarts.
 * Unless that failure is reported to whoever is waiting on the kernel, the only
 * symptom is a test that hangs until its timeout, with no mention of reference
 * counts anywhere — which would make the audit worthless as a build gate.
 */
describe('reference count audit', () => {
  it('reports a violation to kernel callers rather than hanging', async () => {
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

    const exporterVatId = kernel.getVats()[0]?.id as VatId;
    const exporterKRef = kernelStore.getRootObject(exporterVatId) as KRef;

    kernelStore.setObjectRefCount(exporterKRef, {
      reachable: 7,
      recognizable: 9,
    });

    // The crank carrying this message settles its result before the
    // end-of-crank audit runs, so this one may still succeed.
    await kernel
      .queueMessage(exporterKRef, 'createObject', ['x'])
      .catch(() => undefined);

    // What a caller is told directly is that the run loop is gone; the audit
    // failure that killed it rides along as the `cause`. That chain is the part
    // that has to survive, since "run loop died" on its own names nothing.
    const failure = (await kernel
      .queueMessage(exporterKRef, 'createObject', ['y'])
      .catch((error) => error)) as Error;

    expect(failure.message).toMatch(/Kernel run loop died/u);
    expect(String(failure.cause)).toMatch(
      /reference count invariant violated/u,
    );
  }, 30000);
});
