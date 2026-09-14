import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import type { Logger } from '@metamask/logger';
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
 * pins what the kernel actually releases.
 *
 * The crank is driven here rather than by `KernelQueue.run`, which never
 * resolves. `runCrank` mirrors the shape `#runLoop` gives a delivery, rollback
 * on a throw included — without that the action `processGCActionSet` has
 * already spent is committed away rather than restored, and the last test
 * below would be asserting against a store the run loop would never produce.
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
  duringEndpointLookup: { run: () => void };
  logged: unknown[][];
}> {
  const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernelStore = makeKernelStore(kdb);
  const kernelQueue = new KernelQueue(kernelStore, async () => undefined);
  const endpoints = new Map<EndpointId, EndpointHandle>();
  const delivered: Delivered[] = [];
  // Stands in for whatever else runs while the lookup is awaited.
  const duringEndpointLookup = { run: (): void => undefined };
  const logged: unknown[][] = [];
  const logger = {
    log: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      logged.push(args);
    }),
  } as unknown as Logger;
  const kernelRouter = new KernelRouter(
    kernelStore,
    kernelQueue,
    async (endpointId) => {
      duringEndpointLookup.run();
      const endpoint = endpoints.get(endpointId);
      if (!endpoint) {
        throw new Error(`vat ${endpointId} not found`);
      }
      return endpoint;
    },
    () => undefined,
    async () => undefined,
    logger,
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
      let result: CrankResult | undefined;
      try {
        result = await kernelRouter.deliver(item);
      } catch (error) {
        kernelStore.rollbackCrank('delivery');
        throw error;
      }
      kernelStore.collectGarbage();
      return result;
    } finally {
      kernelStore.endCrank();
    }
  };

  return {
    kernelStore,
    runCrank,
    delivered,
    endpoints,
    duringEndpointLookup,
    logged,
  };
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

  // A vat absent from the kernel's tables but not marked terminated still holds
  // these krefs as far as the c-list is concerned, so the kernel must not
  // release its side. `provideVat` waits out a vat that is coming back, so one
  // that reaches here is gone with nothing to wait on.
  it('releases nothing for a vat that is absent but not terminated', async () => {
    const { kernelStore, runCrank } = await makeFixture();
    // The config row is what makes the store call the vat active, which is the
    // half of "absent but not terminated" that distinguishes it from a vat
    // cleanup has already finished with.
    kernelStore.setVatConfig('v1', { bundleName: 'vat1' });
    const kref = kernelStore.initKernelObject('v1');
    kernelStore.addCListEntry('v1', kref, 'o+1');
    kernelStore.setObjectRefCount(kref, { reachable: 0, recognizable: 1 });
    kernelStore.addGCActions([`v1 dropExport ${kref}`]);

    await expect(runCrank()).rejects.toThrow('vat v1 not found');

    expect(kernelStore.getReachableFlag('v1', kref)).toBe(true);
    expect(kernelStore.hasCListEntry('v1', kref)).toBe(true);
    // Selection spends the action from the durable set before delivery, so the
    // rollback is the only thing that gives it back.
    expect([...kernelStore.getGCActions()]).toStrictEqual([
      `v1 dropExport ${kref}`,
    ]);
  });

  // `nextTerminatedVatCleanup` and a remote's incarnation change both tear
  // c-list entries down without waiting for the crank, and resolving the
  // endpoint yields to them. Reusing the answer from before that yield hands
  // `krefsToErefs` a kref whose entry has gone, and it throws rather than
  // returning short.
  it('re-reads the c-list after resolving the endpoint', async () => {
    const {
      kernelStore,
      runCrank,
      delivered,
      endpoints,
      duringEndpointLookup,
    } = await makeFixture();
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
    duringEndpointLookup.run = () => {
      kernelStore.deleteCListEntry('v1', gone, 'o+1');
    };

    await runCrank();

    expect(delivered).toStrictEqual([
      { method: 'dropExports', erefs: ['o+2'] },
    ]);
  });

  // The kref going before delivery is ordinary, but it is the one thing an
  // operator has to go on when a GC action produces nothing, and this is the
  // whole of the delivery when cleanup reached every kref.
  it('reports krefs that cleanup reached first, even when none survive', async () => {
    const { kernelStore, runCrank, delivered, endpoints, logged } =
      await makeFixture();
    registerEndpoint(endpoints, delivered, 'v1');
    const kref = kernelStore.initKernelObject('v1');
    kernelStore.addCListEntry('v1', kref, 'o+1');
    kernelStore.setObjectRefCount(kref, { reachable: 0, recognizable: 1 });
    kernelStore.addGCActions([`v1 dropExport ${kref}`]);

    // After selection, as `nextTerminatedVatCleanup` does.
    await runCrank(() => {
      kernelStore.deleteCListEntry('v1', kref, 'o+1');
    });

    expect(delivered).toStrictEqual([]);
    expect(logged.flat()).toContainEqual(
      expect.stringContaining('1 of 1 kref(s) were cleaned up before delivery'),
    );
  });
});
