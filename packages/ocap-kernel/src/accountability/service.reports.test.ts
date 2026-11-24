import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeAccountabilityService } from './service.ts';
import type { AccountabilityService } from './service.ts';
import type { KernelSigner } from './signing.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import { kslot } from '../liveslots/kernel-marshal.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type { KRef } from '../types.ts';
import { asVatId } from '../../test/branded.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

const owner = asVatId('v1');
const other = asVatId('v2');

describe("the accountability service's reports on a vat's word", () => {
  let kernelStore: KernelStore;
  let service: AccountabilityService;
  let ko1: KRef;
  let ko2: KRef;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
    service = makeAccountabilityService({
      kernelStore,
      kernelQueue: {
        enqueueInbox: vi.fn(async (_what: string, work: () => unknown) => {
          const outcome = (await work()) as
            | { value: unknown }
            | { failure: Error };
          if ('failure' in outcome) {
            throw outcome.failure;
          }
          return outcome.value;
        }),
      } as unknown as KernelQueue,
      signer: {} as KernelSigner,
    });
    ko1 = kernelStore.initKernelObject(owner);
    ko2 = kernelStore.initKernelObject(other);
  });

  describe('exercise', () => {
    it("records a method invoked on the caller's object, on its word, from the delivery it reports from", async () => {
      kernelStore.recordDelivery({
        target: ko1,
        targetEndpoint: owner,
        sender: other,
        cause: 1,
        method: 'poke',
        message: { methargs: { body: '', slots: [] } },
        trace: { id: 'trace-1', hop: 1, hopLimit: 8 },
      });
      await service.exercise({ caller: owner, cause: 0 }, kslot(ko1), 'poke');
      expect(
        kernelStore.getAccountabilityRecords({ kind: 'exercise' }),
      ).toStrictEqual([
        {
          seq: 2,
          kind: 'exercise',
          witness: 'vat',
          crankNumber: 0,
          traceId: 'trace-1',
          hop: 1,
          hopLimit: 8,
          kref: ko1,
          endpoint: owner,
          method: 'poke',
          cause: 0,
        },
      ]);
    });

    it('records one reported outside a delivery, on no trace', async () => {
      await service.exercise(
        { caller: owner, cause: 'async' },
        kslot(ko1),
        'poke',
      );
      expect(
        kernelStore.getAccountabilityRecords({ kind: 'exercise' }),
      ).toStrictEqual([
        expect.objectContaining({ kref: ko1, method: 'poke', cause: 'async' }),
      ]);
      expect(kernelStore.getAccountabilityRecords()[0]).not.toHaveProperty(
        'traceId',
      );
    });

    it.each([
      ['an object of another vat', (): KRef => ko2, 'poke'],
      ['a method that is not a name', (): KRef => ko1, 7],
    ])('refuses %s', async (_what, kref, method) => {
      await expect(
        service.exercise(
          { caller: owner, cause: 0 },
          kslot(kref()),
          method as never,
        ),
      ).rejects.toThrow(/not the caller's|method name/u);
      expect(kernelStore.getAccountabilityRecords()).toStrictEqual([]);
    });
  });

  describe('convey', () => {
    it('records a hand-off the caller declares, to the owner of the object handed to', async () => {
      await service.convey({ caller: owner, cause: 3 }, kslot(ko1), kslot(ko2));
      expect(kernelStore.getAccountabilityRecords()).toStrictEqual([
        {
          seq: 1,
          kind: 'conveyance',
          witness: 'vat',
          crankNumber: 0,
          kref: ko1,
          sender: owner,
          to: other,
          via: 'declared',
          carrier: ko2,
          cause: 3,
        },
      ]);
    });

    it('leaves a declared hand-off out of a chain of custody', async () => {
      await service.convey({ caller: owner, cause: 3 }, kslot(ko1), kslot(ko2));
      const chain = await service.chain(
        { caller: other, cause: 4 },
        kslot(ko1),
      );
      expect(chain.hops).toStrictEqual([
        { endpoint: other, parties: [], acquisitions: [] },
      ]);
    });
  });
});
