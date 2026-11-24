import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { kunser } from '@metamask/ocap-kernel';
import type {
  AccountabilityRecordView,
  Chain,
  ConveyanceRecord,
  DeliveryRecord,
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
  const bundleSpec = getBundleSpec('accounting-vat');
  const vat = { bundleSpec, parameters: {}, globals: ['setTimeout' as const] };
  const { subclusterId, vatRootKrefs } = await kernel.launchSubcluster({
    bootstrap: 'tracker',
    services: ['accountability'],
    vats: { tracker: vat, holder: vat },
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

const historyOf = async (
  kernel: Kernel,
  tracker: KRef,
  kind: AccountabilityRecordView['kind'],
): Promise<AccountabilityRecordView[]> =>
  (
    (await call(kernel, tracker, 'history')) as AccountabilityRecordView[]
  ).filter((record) => record.kind === kind);

describe('accountability inside the vat', () => {
  it("records each invocation of an accountable wrapper on the vat's word, from the delivery it was handling", async () => {
    const { kernel, tracker, trackerVat } = await launch();
    await call(kernel, tracker, 'track');
    expect(await call(kernel, tracker, 'handOver')).toBe('poked');
    const [delivery] = await historyOf(kernel, tracker, 'delivery');
    const [exercise] = await historyOf(kernel, tracker, 'exercise');
    expect(exercise).toStrictEqual({
      seq: expect.any(Number),
      kind: 'exercise',
      witness: 'vat',
      kref: (delivery as DeliveryRecord).target,
      endpoint: trackerVat,
      method: 'poke',
      cause: { delivery: delivery?.seq },
    });
  });

  it('records a hand-off a vat declares, and keeps it out of the chain of custody', async () => {
    const { kernel, tracker, holder, trackerVat, holderVat } = await launch();
    await call(kernel, tracker, 'track');
    await call(kernel, tracker, 'declare');
    await call(kernel, tracker, 'handOver');
    const conveyances = (await historyOf(
      kernel,
      tracker,
      'conveyance',
    )) as ConveyanceRecord[];
    expect(conveyances.filter(({ via }) => via === 'declared')).toStrictEqual([
      expect.objectContaining({
        witness: 'vat',
        sender: trackerVat,
        to: holderVat,
        via: 'declared',
        carrier: holder,
        cause: 'unrecorded',
      }),
    ]);
    const chain = (await call(kernel, holder, 'chainOfHeld')) as Chain;
    expect(chain.hops[0]?.acquisitions).toStrictEqual([
      expect.objectContaining({ kind: 'conveyance', via: 'message' }),
    ]);
  });

  it("records a tracked object written into durable state on liveslots' word, once", async () => {
    const { kernel, tracker, holder, holderVat } = await launch();
    await call(kernel, tracker, 'track');
    await call(kernel, tracker, 'handOver');
    await call(kernel, holder, 'keep');
    await call(kernel, holder, 'keep');
    const [delivery] = await historyOf(kernel, tracker, 'delivery');
    expect(await historyOf(kernel, tracker, 'incorporation')).toStrictEqual([
      {
        seq: expect.any(Number),
        kind: 'incorporation',
        witness: 'liveslots',
        kref: (delivery as DeliveryRecord).target,
        endpoint: holderVat,
        object: expect.stringMatching(/^o\+d\d+\/\d+$/u),
      },
    ]);
  });

  it('charges a send from a timer callback to the delivery that scheduled it', async () => {
    const { kernel, tracker, holder, holderVat } = await launch();
    await call(kernel, tracker, 'track');
    await call(kernel, tracker, 'handOver');
    expect(await call(kernel, holder, 'pokeHeldLater')).toBe('poked');
    const {
      payload: { records },
    } = await kernel.exportAccountabilityRecords({ kind: 'delivery' });
    const deliveries = records as DeliveryRecord[];
    const later = deliveries.at(-1) as DeliveryRecord;
    expect(later).toStrictEqual(
      expect.objectContaining({
        sender: holderVat,
        method: 'poke',
        cause: { crankNumber: expect.any(Number), witness: 'liveslots' },
      }),
    );
    const scheduledIn = (later.cause as { crankNumber: number }).crankNumber;
    expect(scheduledIn).toBeLessThan(later.crankNumber);
    expect(scheduledIn).toBeGreaterThan(deliveries[0]?.crankNumber as number);
    // As the vat reads it: on the supervisor's word, of a delivery the kernel
    // has no record of, since the holder's root is not tracked.
    expect((await historyOf(kernel, tracker, 'delivery')).at(-1)).toStrictEqual(
      expect.objectContaining({ cause: { witness: 'liveslots' } }),
    );
  });

  it('carries a trace through a timer callback', async () => {
    const { kernel, tracker, holderVat } = await launch();
    await call(kernel, tracker, 'track', [{ trace: {} }]);
    await call(kernel, tracker, 'handOver');
    expect(await call(kernel, tracker, 'awaitPing')).toBe('pinged');
    const [poke] = await historyOf(kernel, tracker, 'delivery');
    const trace = (await call(kernel, tracker, 'trace', [
      (poke as { traceId?: string }).traceId,
    ])) as AccountabilityRecordView[];
    expect(trace).toContainEqual(
      expect.objectContaining({ kind: 'exercise', method: 'poke', hop: 0 }),
    );
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'delivery',
        targetEndpoint: holderVat,
        method: 'ping',
        hop: 1,
        cause: { delivery: poke?.seq, witness: 'liveslots' },
      }),
    );
  });
});
