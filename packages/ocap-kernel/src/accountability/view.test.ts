import { beforeEach, describe, expect, it } from 'vitest';

import type { AccountabilityRecord } from './types.ts';
import { viewRecords } from './view.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type { Cause, KRef } from '../types.ts';
import { asVatId } from '../../test/branded.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

const owner = asVatId('v1');
const holder = asVatId('v2');

describe('records as a vat reads them', () => {
  let kernelStore: KernelStore;
  let ko1: KRef;

  const poke = (cause: Cause): void =>
    kernelStore.recordDelivery({
      target: ko1,
      targetEndpoint: owner,
      sender: holder,
      cause,
      method: 'poke',
      message: { methargs: { body: '#["poke",[]]', slots: [] } },
    });

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
    ko1 = kernelStore.initKernelObject(owner);
  });

  it('leaves the crank number out, and the rest in', () => {
    kernelStore.recordIntroduction({ kref: ko1, endpoint: holder });
    const [record] = kernelStore.getAccountabilityRecords();
    expect(record).toHaveProperty('crankNumber');

    expect(
      viewRecords(kernelStore, [record as AccountabilityRecord]),
    ).toStrictEqual([
      {
        seq: 1,
        kind: 'introduction',
        witness: 'kernel',
        kref: ko1,
        endpoint: holder,
        sender: null,
        via: 'unknown',
      },
    ]);
  });

  it.each([
    [
      "the record of the sender's delivery in that crank",
      (): void => {
        kernelStore.recordDelivery({
          target: ko1,
          targetEndpoint: holder,
          sender: owner,
          cause: 1,
          method: 'nudge',
          message: { methargs: { body: '#["nudge",[]]', slots: [] } },
        });
        poke(0);
      },
      { delivery: 1 },
    ],
    [
      "'unrecorded' where the kernel wrote none",
      (): void => poke(1),
      'unrecorded',
    ],
    ["'async' as it is", (): void => poke('async'), 'async'],
    [
      "the delivery and the supervisor's word, for a scheduled send",
      (): void => {
        kernelStore.recordDelivery({
          target: ko1,
          targetEndpoint: holder,
          sender: owner,
          cause: 0,
          method: 'nudge',
          message: { methargs: { body: '#["nudge",[]]', slots: [] } },
        });
        poke({ crankNumber: 0, witness: 'liveslots' });
      },
      { delivery: 1, witness: 'liveslots' },
    ],
    [
      "the supervisor's word alone, for a scheduled send the kernel has no record of",
      (): void => poke({ crankNumber: 0, witness: 'liveslots' }),
      { witness: 'liveslots' },
    ],
  ])('names a cause by %s', (_what, arrange, cause) => {
    arrange();
    const records = kernelStore.getAccountabilityRecords();
    const views = viewRecords(kernelStore, records);
    expect(views.at(-1)).toStrictEqual(
      expect.objectContaining({ kind: 'delivery', cause }),
    );
    expect(views.at(-1)).not.toHaveProperty('crankNumber');
  });

  it("names an exercise's cause by the delivery to the vat reporting it", () => {
    kernelStore.recordDelivery({
      target: ko1,
      targetEndpoint: owner,
      sender: holder,
      cause: 0,
      method: 'poke',
      message: { methargs: { body: '#["poke",[]]', slots: [] } },
    });
    kernelStore.recordExercise({
      kref: ko1,
      endpoint: owner,
      method: 'poke',
      cause: 0,
    });
    const views = viewRecords(
      kernelStore,
      kernelStore.getAccountabilityRecords(),
    );
    expect(views.at(-1)).toStrictEqual(
      expect.objectContaining({ kind: 'exercise', cause: { delivery: 1 } }),
    );
  });
});
