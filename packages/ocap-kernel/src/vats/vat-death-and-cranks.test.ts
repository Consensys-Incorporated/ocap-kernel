import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import { describe, it, expect, vi } from 'vitest';

import { VatHandle } from './VatHandle.ts';
import { VatManager } from './VatManager.ts';
import { KernelQueue } from '../KernelQueue.ts';
import { makeKernelStore } from '../store/index.ts';
import type {
  CrankResult,
  PlatformServices,
  RunQueueItem,
  VatConfig,
  VatId,
} from '../types.ts';

/**
 * Where a vat's death meets the run loop, over a real store.
 *
 * `VatManager`'s own tests mock the store, so the turn `terminateVat` resumes
 * in is whatever the mock chooses — and that turn is the whole question here.
 */

const config: VatConfig = { sourceSpec: 'test.js' };

/**
 * A kernel store, run loop and vat manager over one in-memory database.
 *
 * @returns The pieces, plus a `deliver` the test drives the run loop with.
 */
async function makeFixture(): Promise<{
  kernelStore: ReturnType<typeof makeKernelStore>;
  kernelQueue: KernelQueue;
  vatManager: VatManager;
  deliveries: ((result: CrankResult) => void)[];
  deliver: (item: RunQueueItem) => Promise<CrankResult>;
  streamDeaths: ((error: Error, vat: VatHandle) => void)[];
}> {
  const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernelStore = makeKernelStore(kdb);
  const platformServices = {
    launch: vi.fn().mockResolvedValue({
      end: vi.fn(),
    } as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>),
    terminate: vi.fn().mockResolvedValue(undefined),
    terminateAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlatformServices;

  // Captured per fixture rather than read off the shared spy's `mock.calls`,
  // which accumulate across tests.
  const streamDeaths: ((error: Error, vat: VatHandle) => void)[] = [];
  vi.spyOn(VatHandle, 'make').mockImplementation(
    async ({ vatId, vatConfig, onCriticalFailure }) => {
      streamDeaths.push(onCriticalFailure);
      return {
        vatId,
        config: vatConfig,
        terminate: vi.fn().mockResolvedValue(undefined),
        ping: vi.fn(),
      } as unknown as VatHandle;
    },
  );

  // eslint-disable-next-line prefer-const
  let vatManager: VatManager;
  const kernelQueue = new KernelQueue(kernelStore, async (vatId, reason) =>
    vatManager.stopVat(vatId, true, reason),
  );
  vatManager = new VatManager({
    platformServices,
    kernelStore,
    kernelQueue,
    logger: new Logger('test'),
  });

  // Each delivery parks until the test settles it, which is how the test gets
  // to act while a crank is open.
  const deliveries: ((result: CrankResult) => void)[] = [];
  const deliver = async (): Promise<CrankResult> =>
    new Promise<CrankResult>((resolve) => {
      deliveries.push(resolve);
    });

  return {
    kernelStore,
    kernelQueue,
    vatManager,
    deliveries,
    deliver,
    streamDeaths,
  };
}

/**
 * Let every pending microtask and timer callback run.
 *
 * @returns A promise that resolves once they have.
 */
const settle = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Wait until the run loop has parked on a delivery.
 *
 * @param deliveries - The resolvers collected so far.
 * @param count - How many deliveries to wait for.
 */
async function deliveriesReach(
  deliveries: unknown[],
  count: number,
): Promise<void> {
  for (let tries = 0; tries < 50 && deliveries.length < count; tries += 1) {
    await settle();
  }
  expect(deliveries).toHaveLength(count);
}

describe("a vat's death while the run loop is running", () => {
  it('survives a later crank being rolled back', async () => {
    const { kernelStore, kernelQueue, vatManager, deliveries, deliver } =
      await makeFixture();
    // Through `launchVat` so the store holds everything a real termination
    // reads: the config row, the subcluster mapping, the pinned root.
    const subclusterId = kernelStore.addSubcluster({
      bootstrap: 'bob',
      vats: { bob: { sourceSpec: 'test.js' } },
    });
    await vatManager.launchVat(config, 'bob', subclusterId);

    kernelStore.enqueueRun({
      type: 'send',
      target: 'ko1',
      message: { methargs: { body: '#[]', slots: [] } },
    } as unknown as RunQueueItem);
    kernelStore.enqueueRun({
      type: 'send',
      target: 'ko2',
      message: { methargs: { body: '#[]', slots: [] } },
    } as unknown as RunQueueItem);

    const loop = kernelQueue.run(deliver);
    loop.catch(() => undefined);
    await deliveriesReach(deliveries, 1);

    // Asked for mid-crank, so it has to wait out the crank in flight.
    const terminated = vatManager.terminateVat('v1' as VatId);
    await settle();
    deliveries[0]?.({ didDelivery: 'v1' });
    await terminated;

    // `isVatTerminated` is not the signal: cleanup unmarks the vat it finishes
    // with. The config row `deleteVat` removed is what stays removed.
    expect({
      where: 'after terminate',
      active: kernelStore.isVatActive('v1' as VatId),
      hasVat: vatManager.hasVat('v1' as VatId),
    }).toStrictEqual({
      where: 'after terminate',
      active: false,
      hasVat: false,
    });

    // The next crank aborts, and has nothing to do with this vat.
    await deliveriesReach(deliveries, 2);
    deliveries[1]?.({ abort: true });
    await settle();

    expect({
      where: 'after the unrelated crank aborted',
      active: kernelStore.isVatActive('v1' as VatId),
      hasVat: vatManager.hasVat('v1' as VatId),
    }).toStrictEqual({
      where: 'after the unrelated crank aborted',
      active: false,
      hasVat: false,
    });
  });

  // `terminateVat` above records the death out of crank. A broken stream does
  // not: `onCriticalFailure` writes into whichever crank is open, and an abort
  // rolls those writes back while the handle it deleted stays deleted.
  it('survives the crank it died in being rolled back', async () => {
    const {
      kernelStore,
      kernelQueue,
      vatManager,
      deliveries,
      deliver,
      streamDeaths,
    } = await makeFixture();
    const subclusterId = kernelStore.addSubcluster({
      bootstrap: 'bob',
      vats: { bob: { sourceSpec: 'test.js' } },
    });
    await vatManager.launchVat(config, 'bob', subclusterId);
    const vat = vatManager.getVat('v1' as VatId);
    const streamDied = streamDeaths[0] as (
      error: Error,
      vat: VatHandle,
    ) => void;

    kernelStore.enqueueRun({
      type: 'send',
      target: 'ko1',
      message: { methargs: { body: '#[]', slots: [] } },
    } as unknown as RunQueueItem);

    const loop = kernelQueue.run(deliver);
    loop.catch(() => undefined);
    await deliveriesReach(deliveries, 1);

    // The drain catch fires in whatever turn the read error lands in, which is
    // routinely one with a crank open.
    streamDied(new Error('the worker went away'), vat);
    // Aborting for a reason of its own, so nothing re-records the death the way
    // a `terminate` result would.
    deliveries[0]?.({ abort: true });
    await settle();

    expect({
      where: 'after the crank it died in aborted',
      active: kernelStore.isVatActive('v1' as VatId),
      hasVat: vatManager.hasVat('v1' as VatId),
    }).toStrictEqual({
      where: 'after the crank it died in aborted',
      active: false,
      hasVat: false,
    });
  });
});
