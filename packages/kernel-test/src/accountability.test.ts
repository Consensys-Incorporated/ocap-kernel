import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { kunser } from '@metamask/ocap-kernel';
import type {
  AccountabilityRecord,
  IntroductionRecord,
  Kernel,
  KRef,
  VatId,
} from '@metamask/ocap-kernel';
import { describe, expect, it } from 'vitest';

import { getBundleSpec, makeKernel, makeTestLogger } from './utils.ts';

const launch = async (): Promise<{
  kernel: Kernel;
  tracker: KRef;
  holder: KRef;
  trackerVat: VatId;
  holderVat: VatId;
}> => {
  const { logger } = makeTestLogger();
  const kernel = await makeKernel(
    await makeSQLKernelDatabase({}),
    true,
    logger,
  );
  const bundleSpec = getBundleSpec('accountability-vat');
  const { subclusterId, vatRootKrefs } = await kernel.launchSubcluster({
    bootstrap: 'tracker',
    services: ['accountability'],
    vats: {
      tracker: { bundleSpec, parameters: {} },
      holder: { bundleSpec, parameters: {} },
    },
  });
  const [trackerVat, holderVat] = kernel.getSubclusterVats(subclusterId) as [
    VatId,
    VatId,
  ];
  return {
    kernel,
    tracker: vatRootKrefs.tracker as KRef,
    holder: vatRootKrefs.holder as KRef,
    trackerVat,
    holderVat,
  };
};

const call = async (
  kernel: Kernel,
  target: KRef,
  method: string,
  args: unknown[] = [],
): Promise<unknown> => kunser(await kernel.queueMessage(target, method, args));

describe('accountability', () => {
  it('records what is done with a tracked object, and lets its owner read it back', async () => {
    const { kernel, tracker, trackerVat, holderVat } = await launch();
    await call(kernel, tracker, 'track');
    await call(kernel, tracker, 'handOver');
    const history = (await call(
      kernel,
      tracker,
      'history',
    )) as AccountabilityRecord[];

    const thing = history[0]?.kind === 'conveyance' ? history[0].kref : '';
    expect(history).toStrictEqual([
      // `handOver` carried the thing to the holder, its first sight of it.
      expect.objectContaining({
        kind: 'conveyance',
        kref: thing,
        sender: trackerVat,
        to: holderVat,
        via: 'message',
      }),
      expect.objectContaining({
        kind: 'introduction',
        kref: thing,
        endpoint: holderVat,
        sender: trackerVat,
        via: 'message',
      }),
      // The holder's poke.
      expect.objectContaining({
        kind: 'delivery',
        target: thing,
        targetEndpoint: trackerVat,
        sender: holderVat,
        method: 'poke',
        slots: [],
      }),
      // Asking for the history carried the thing to the kernel.
      expect.objectContaining({
        kind: 'conveyance',
        kref: thing,
        sender: trackerVat,
        to: 'kernel',
        via: 'message',
      }),
    ]);
    expect(history[2]).not.toHaveProperty('args');
    expect(history.every((record) => record.witness === 'kernel')).toBe(true);
  });

  it('keeps the arguments when asked, and keeps the records once untracked', async () => {
    const { kernel, tracker } = await launch();
    await call(kernel, tracker, 'track', [{ recordArgs: true }]);
    await call(kernel, tracker, 'handOver');
    await call(kernel, tracker, 'untrack');
    await call(kernel, tracker, 'handOver');

    const deliveries = await kernel.exportRecords({ kind: 'delivery' });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toStrictEqual(
      expect.objectContaining({
        method: 'poke',
        args: { body: '#["poke",[]]', slots: [] },
      }),
    );
  });

  it("records each endpoint's first acquisition of each object", async () => {
    const { kernel, tracker, holder, trackerVat } = await launch();
    const introductions = (await kernel.exportRecords({
      kind: 'introduction',
    })) as IntroductionRecord[];
    const acquired = introductions.map((record) => [
      record.endpoint,
      record.kref,
      record.sender,
      record.via,
    ]);
    // The bootstrap message handed the tracker the holder's root.
    expect(acquired).toContainEqual([trackerVat, holder, 'kernel', 'message']);
    // Its own root is not an acquisition.
    expect(acquired.map(([, kref]) => kref)).not.toContain(tracker);
  });
});
