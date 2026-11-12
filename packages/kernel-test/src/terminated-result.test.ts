import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { makeKernelStore } from '@metamask/ocap-kernel';
import type {
  Kernel,
  KRef,
  QueueMessageResult,
  SubclusterId,
  VatId,
} from '@metamask/ocap-kernel';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeMockLogger,
  runTestVats,
} from './utils.ts';

type Store = ReturnType<typeof makeKernelStore>;

/**
 * Launch an exporter, fetch an object from it, and terminate its subcluster.
 *
 * @param kernelDatabase - The database.
 * @returns The kernel, its store, the result and the gift in it.
 */
async function fetchThenTerminate(kernelDatabase: KernelDatabase): Promise<{
  kernel: Kernel;
  kernelStore: Store;
  result: QueueMessageResult;
  gift: KRef;
}> {
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
  const result = await kernel.queueMessage(exporterKRef, 'createObject', [
    'gift',
  ]);
  const gift = result.slots[0] as KRef;
  await kernel.terminateSubcluster(subcluster?.id as SubclusterId);
  await waitUntilQuiescent(500);
  kernel.collectGarbage();
  return { kernel, kernelStore, result, gift };
}

const snapshot = (kernelStore: Store, gift: KRef, kpid: KRef) => ({
  giftExists: kernelStore.kernelRefExists(gift),
  giftRefCount: kernelStore.getObjectRefCount(gift),
  kpidExists: kernelStore.kernelRefExists(kpid),
  held: kernelStore.getHeldResults(),
  audit: kernelStore.auditRefCounts(),
});

describe('queueMessage result of a terminated subcluster', () => {
  let dbDir: string | undefined;

  afterEach(async () => {
    if (dbDir) {
      await rm(dbDir, { recursive: true, force: true });
      dbDir = undefined;
    }
  });

  it('keeps the returned object while the result is held, after its exporter is terminated', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const { kernelStore, result, gift } =
      await fetchThenTerminate(kernelDatabase);
    const kpid = result.kpid as KRef;

    expect(snapshot(kernelStore, gift, kpid)).toStrictEqual({
      giftExists: true,
      giftRefCount: { reachable: 1, recognizable: 1 },
      kpidExists: true,
      held: [kpid],
      audit: [],
    });
  });

  it('releases the returned object once its exporter is terminated and the result is released', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const { kernel, kernelStore, result, gift } =
      await fetchThenTerminate(kernelDatabase);
    const kpid = result.kpid as KRef;

    await kernel.releaseResult(result);
    await waitUntilQuiescent(500);
    kernel.collectGarbage();

    expect(snapshot(kernelStore, gift, kpid)).toStrictEqual({
      giftExists: false,
      giftRefCount: { reachable: 0, recognizable: 0 },
      kpidExists: false,
      held: [],
      audit: [],
    });
  });

  it('releases the returned object once its exporter is terminated and the kernel restarts', async () => {
    dbDir = await mkdtemp(path.join(os.tmpdir(), 'terminated-result-'));
    const dbFilename = path.join(dbDir, 'kernel.db');
    const firstDatabase = await makeSQLKernelDatabase({ dbFilename });
    const { kernel, result, gift } = await fetchThenTerminate(firstDatabase);
    const kpid = result.kpid as KRef;
    await kernel.stop();

    const kernelDatabase = await makeSQLKernelDatabase({ dbFilename });
    const kernelStore = makeKernelStore(kernelDatabase);
    const restarted = await makeKernel(kernelDatabase, false, makeMockLogger());
    await waitUntilQuiescent(500);
    restarted.collectGarbage();

    expect(snapshot(kernelStore, gift, kpid)).toStrictEqual({
      giftExists: false,
      giftRefCount: { reachable: 0, recognizable: 0 },
      kpidExists: false,
      held: [],
      audit: [],
    });
  });
});
