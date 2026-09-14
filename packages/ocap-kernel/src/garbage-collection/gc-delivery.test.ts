import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, it, expect, vi } from 'vitest';

import { processGCActionSet } from './garbage-collection.ts';
import { KernelQueue } from '../KernelQueue.ts';
import { KernelRouter } from '../KernelRouter.ts';
import { makeKernelStore } from '../store/index.ts';
import type {
  CrankResult,
  EndpointHandle,
  EndpointId,
  ERef,
  RunQueueItemGCAction,
} from '../types.ts';

/**
 * Kernel-issued GC deliveries end to end, against a real store.
 *
 * Selection has its own real-store coverage next door and delivery has unit
 * coverage over a mocked store, but the two halves have never met: the mock
 * answers `hasCListEntry` and `krefsToErefs` from `vi.fn()`s, so nothing there
 * pins what the kernel actually releases, and nothing pins that a crank the
 * delivery aborts gives the action back.
 *
 * The crank is driven here rather than by `KernelQueue.run`, which never
 * resolves and, for the abort below, would reselect the same action every crank
 * (see #1061). `runCrank` is the shape `#runLoop` gives a delivery.
 */

type Delivered = { method: string; erefs: ERef[] };

/**
 * Build a store over a fresh in-memory database, wired to a router whose
 * endpoints are whatever the test registered.
 *
 * @returns The store, the router, what the endpoints received, and the
 * endpoint table to register into.
 */
async function makeFixture(): Promise<{
  kernelStore: ReturnType<typeof makeKernelStore>;
  runCrank: (
    beforeDeliver?: (item: RunQueueItemGCAction) => void,
  ) => Promise<CrankResult | undefined>;
  delivered: Delivered[];
  endpoints: Map<EndpointId, EndpointHandle>;
}> {
  const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernelStore = makeKernelStore(kdb);
  const kernelQueue = new KernelQueue(kernelStore, async () => undefined);
  const endpoints = new Map<EndpointId, EndpointHandle>();
  const delivered: Delivered[] = [];
  const kernelRouter = new KernelRouter(
    kernelStore,
    kernelQueue,
    (endpointId) => {
      const endpoint = endpoints.get(endpointId);
      if (!endpoint) {
        throw new Error(`vat ${endpointId} not found`);
      }
      return endpoint;
    },
    () => undefined,
  );

  const runCrank = async (
    beforeDeliver?: (item: RunQueueItemGCAction) => void,
  ): Promise<CrankResult | undefined> => {
    kernelStore.startCrank();
    kernelStore.createCrankSavepoint('crank');
    kernelStore.createCrankSavepoint('delivery');
    try {
      const item = processGCActionSet(kernelStore);
      if (!item) {
        return undefined;
      }
      beforeDeliver?.(item);
      const result = await kernelRouter.deliver(item);
      if (result?.abort) {
        kernelStore.rollbackCrank('delivery');
      }
      kernelStore.collectGarbage();
      return result;
    } finally {
      kernelStore.endCrank();
    }
  };

  return { kernelStore, runCrank, delivered, endpoints };
}

/**
 * Register an endpoint that records what it is told to let go of.
 *
 * @param endpoints - The router's endpoint table.
 * @param delivered - Where to record the deliveries.
 * @param endpointId - The endpoint to register.
 * @returns The registered handle.
 */
function registerEndpoint(
  endpoints: Map<EndpointId, EndpointHandle>,
  delivered: Delivered[],
  endpointId: EndpointId,
): EndpointHandle {
  const record =
    (method: string) =>
    async (erefs: ERef[]): Promise<CrankResult> => {
      delivered.push({ method, erefs });
      return { didDelivery: endpointId };
    };
  const endpoint = {
    deliverMessage: vi.fn(),
    deliverNotify: vi.fn(),
    deliverDropExports: vi.fn(record('dropExports')),
    deliverRetireExports: vi.fn(record('retireExports')),
    deliverRetireImports: vi.fn(record('retireImports')),
    deliverBringOutYourDead: vi.fn(),
  } as unknown as EndpointHandle;
  endpoints.set(endpointId, endpoint);
  return endpoint;
}

describe('a GC action the kernel issues', () => {
  it('tells the exporter to drop, and stops treating the object as reachable', async () => {
    const { kernelStore, runCrank, delivered, endpoints } = await makeFixture();
    registerEndpoint(endpoints, delivered, 'v1');
    const kref = kernelStore.initKernelObject('v1');
    kernelStore.addCListEntry('v1', kref, 'o+1');
    kernelStore.setObjectRefCount(kref, { reachable: 0, recognizable: 1 });
    kernelStore.addGCActions([`v1 dropExport ${kref}`]);

    await runCrank();

    expect(delivered).toStrictEqual([
      { method: 'dropExports', erefs: ['o+1'] },
    ]);
    expect(kernelStore.getReachableFlag('v1', kref)).toBe(false);
    // A drop is not a retire: the object is still recognizable, so the entry
    // that names it has to survive.
    expect(kernelStore.hasCListEntry('v1', kref)).toBe(true);
    expect(kernelStore.getOwner(kref)).toBe('v1');
  });

  it('tells the exporter to retire, and gives up the object', async () => {
    const { kernelStore, runCrank, delivered, endpoints } = await makeFixture();
    registerEndpoint(endpoints, delivered, 'v1');
    const kref = kernelStore.initKernelObject('v1');
    kernelStore.addCListEntry('v1', kref, 'o+1');
    kernelStore.setObjectRefCount(kref, { reachable: 0, recognizable: 0 });
    kernelStore.addGCActions([`v1 retireExport ${kref}`]);

    await runCrank();

    expect(delivered).toStrictEqual([
      { method: 'retireExports', erefs: ['o+1'] },
    ]);
    expect(kernelStore.hasCListEntry('v1', kref)).toBe(false);
    expect(kernelStore.getOwner(kref)).toBeUndefined();
  });

  it('tells the importer to retire, and leaves ownership alone', async () => {
    const { kernelStore, runCrank, delivered, endpoints } = await makeFixture();
    registerEndpoint(endpoints, delivered, 'v2');
    const kref = kernelStore.initKernelObject('v1');
    // The exporter's own entry, so the object outlives the import being
    // retired and `getOwner` still has something to answer.
    kernelStore.addCListEntry('v1', kref, 'o+1');
    kernelStore.addCListEntry('v2', kref, 'o-1');
    kernelStore.addGCActions([`v2 retireImport ${kref}`]);

    await runCrank();

    expect(delivered).toStrictEqual([
      { method: 'retireImports', erefs: ['o-1'] },
    ]);
    expect(kernelStore.hasCListEntry('v2', kref)).toBe(false);
    // Only the exporter giving up its last name for an object orphans it.
    expect(kernelStore.hasCListEntry('v1', kref)).toBe(true);
    expect(kernelStore.getOwner(kref)).toBe('v1');
  });

  // `nextTerminatedVatCleanup` runs between selection and delivery and can take
  // a c-list entry with it, so the erefs have to come from the krefs that
  // survived rather than the ones the action named. With the survivor at index
  // 0 the two agree, which is why this drops the first.
  it('names the surviving kref when an earlier one was cleaned up first', async () => {
    const { kernelStore, runCrank, delivered, endpoints } = await makeFixture();
    registerEndpoint(endpoints, delivered, 'v1');
    const gone = kernelStore.initKernelObject('v1');
    const kept = kernelStore.initKernelObject('v1');
    kernelStore.addCListEntry('v1', gone, 'o+1');
    kernelStore.addCListEntry('v1', kept, 'o+2');
    kernelStore.setObjectRefCount(gone, { reachable: 0, recognizable: 1 });
    kernelStore.setObjectRefCount(kept, { reachable: 0, recognizable: 1 });
    kernelStore.addGCActions([
      `v1 dropExport ${gone}`,
      `v1 dropExport ${kept}`,
    ]);

    await runCrank((item) => {
      expect(item.krefs).toStrictEqual([gone, kept]);
      kernelStore.deleteCListEntry('v1', gone, 'o+1');
    });

    expect(delivered).toStrictEqual([
      { method: 'dropExports', erefs: ['o+2'] },
    ]);
  });

  // A vat between incarnations still holds these krefs. Releasing the kernel's
  // side would leave the two disagreeing; throwing killed the run loop.
  it('gives the action back when the vat is between incarnations', async () => {
    const { kernelStore, runCrank } = await makeFixture();
    const kref = kernelStore.initKernelObject('v1');
    kernelStore.addCListEntry('v1', kref, 'o+1');
    kernelStore.setObjectRefCount(kref, { reachable: 0, recognizable: 1 });
    kernelStore.addGCActions([`v1 dropExport ${kref}`]);

    const result = await runCrank();

    expect(result).toStrictEqual({ abort: true });
    expect(kernelStore.getReachableFlag('v1', kref)).toBe(true);
    expect(kernelStore.hasCListEntry('v1', kref)).toBe(true);
    expect([...kernelStore.getGCActions()]).toStrictEqual([
      `v1 dropExport ${kref}`,
    ]);
  });
});
