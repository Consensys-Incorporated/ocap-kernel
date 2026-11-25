import { describe, it, expect, beforeEach, vi } from 'vitest';

import { makeAccountabilityService } from './service.ts';
import type { AccountabilityService } from './service.ts';
import type { KernelSigner } from './signing.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import { kslot } from '../liveslots/kernel-marshal.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type { KRef, VatConfig } from '../types.ts';
import { asKRef, asVatId } from '../../test/branded.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

const owner = asVatId('v1');
const holder = asVatId('v2');
const other = asVatId('v3');

describe('accountability service', () => {
  let kernelStore: KernelStore;
  let kernelQueue: KernelQueue;
  let signer: KernelSigner;
  let service: AccountabilityService;
  let ko1: KRef;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
    for (const vatId of [owner, holder, other]) {
      kernelStore.setVatConfig(vatId, { sourceSpec: 'x' } as VatConfig);
    }
    kernelQueue = {
      enqueueInbox: vi.fn(async (_what: string, work: () => unknown) => {
        const outcome = (await work()) as
          | { value: unknown }
          | { failure: Error };
        if ('failure' in outcome) {
          throw outcome.failure;
        }
        return outcome.value;
      }),
    } as unknown as KernelQueue;
    signer = {
      sign: vi.fn(async (payload: unknown) => ({
        payload,
        signer: 'peer',
        incarnationId: 'inc',
        signature: 'sig',
      })),
      getPeerId: vi.fn(async () => 'peer'),
    } as unknown as KernelSigner;
    service = makeAccountabilityService({ kernelStore, kernelQueue, signer });
    ko1 = kernelStore.initKernelObject(owner);
  });

  it('tracks and untracks an object for the caller the kernel names', async () => {
    await service.track({ caller: holder, cause: 1 }, kslot(ko1));
    expect(kernelStore.getTrackers(ko1)).toStrictEqual({ v2: {} });
    await service.untrack({ caller: holder, cause: 1 }, kslot(ko1));
    expect(kernelStore.isTracked(ko1)).toBe(false);
  });

  it('does its writes in a crank of their own', async () => {
    await service.track({ caller: holder, cause: 1 }, kslot(ko1));
    expect(kernelQueue.enqueueInbox).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a promise', kslot(asKRef('kp1')), 'must be an object, not a promise'],
    ['a plain value', 'ko1', 'must be a remotable'],
  ])('refuses %s', async (_what, arg, problem) => {
    await expect(
      service.track({ caller: holder, cause: 1 }, arg as never),
    ).rejects.toThrow(problem);
  });

  it('records the arguments for the owner and refuses to for another holder', async () => {
    await expect(
      service.track({ caller: holder, cause: 1 }, kslot(ko1), {
        recordArgs: true,
      }),
    ).rejects.toThrow(`only the owner of ${ko1} may record its arguments`);
    expect(kernelStore.isTracked(ko1)).toBe(false);
    await service.track({ caller: owner, cause: 1 }, kslot(ko1), {
      recordArgs: true,
    });
    expect(kernelStore.getTrackers(ko1)).toStrictEqual({
      v1: { recordArgs: true },
    });
  });

  it('refuses to track for a caller the kernel no longer has', async () => {
    const gone = asVatId('v9');
    await expect(
      service.track({ caller: gone, cause: 1 }, kslot(ko1)),
    ).rejects.toThrow('v9 no longer exists');
    expect(kernelStore.isTracked(ko1)).toBe(false);
  });

  it('rejects track options it does not know', async () => {
    await expect(
      service.track({ caller: holder, cause: 1 }, kslot(ko1), {
        recordArgs: 'yes',
      } as never),
    ).rejects.toThrow('recordArgs');
  });

  describe('history', () => {
    beforeEach(() => {
      kernelStore.recordConveyance({
        kref: ko1,
        sender: owner,
        to: holder,
        via: 'message',
        carrier: ko1,
      });
      kernelStore.recordConveyance({
        kref: ko1,
        sender: owner,
        to: other,
        via: 'message',
        carrier: ko1,
      });
      kernelStore.recordDelivery({
        target: ko1,
        targetEndpoint: owner,
        sender: holder,
        cause: 2,
        method: 'poke',
        message: { methargs: { body: '#["poke",[]]', slots: [] } },
      });
    });

    it('shows the owner every record about the object, as a vat reads them', async () => {
      const records = await service.history(
        { caller: owner, cause: 1 },
        kslot(ko1),
      );
      expect(records.map((record) => record.seq)).toStrictEqual([1, 2, 3]);
      expect(records.some((record) => 'crankNumber' in record)).toBe(false);
      expect(records[2]).toStrictEqual(
        expect.objectContaining({ kind: 'delivery', cause: 'unrecorded' }),
      );
    });

    it('shows another holder its own chain of custody and the deliveries it sent', async () => {
      const records = await service.history(
        { caller: holder, cause: 1 },
        kslot(ko1),
      );
      expect(records.map((record) => record.seq)).toStrictEqual([1, 3]);
    });

    it('builds the chain from the caller', async () => {
      const chain = await service.chain(
        { caller: holder, cause: 1 },
        kslot(ko1),
      );
      expect(chain.hops.map(({ endpoint }) => endpoint)).toStrictEqual([
        holder,
        owner,
      ]);
    });
  });

  describe('trace', () => {
    const trace = { id: 'trace-1', hop: 0, hopLimit: 8 };

    beforeEach(() => {
      kernelStore.recordDelivery({
        target: ko1,
        targetEndpoint: owner,
        sender: holder,
        cause: 2,
        method: 'poke',
        message: { methargs: { body: '#["poke",[]]', slots: [] } },
        trace,
      });
      kernelStore.recordResolution({
        kpid: asKRef('kp2'),
        endpoint: holder,
        sender: owner,
        rejected: false,
        slots: [],
        trace: { ...trace, hop: 1 },
      });
      kernelStore.recordDelivery({
        target: ko1,
        targetEndpoint: owner,
        sender: other,
        cause: 4,
        method: 'poke',
        message: { methargs: { body: '#["poke",[]]', slots: [] } },
      });
    });

    it.each([
      ['the owner', owner, 'trace-1', [1, 2]],
      ['a holder it reached', holder, 'trace-1', [1, 2]],
      ['an endpoint it did not reach', other, 'trace-1', []],
      ['anyone, of a trace there is no record of', owner, 'trace-2', []],
    ])(
      'shows %s the whole trace or none of it',
      async (_who, caller, traceId, expected) => {
        const records = await service.trace({ caller, cause: 1 }, traceId);
        expect(records.map((record) => record.seq)).toStrictEqual(expected);
      },
    );

    it('rejects a trace id that is not a string', async () => {
      await expect(
        service.trace({ caller: owner, cause: 1 }, 1 as never),
      ).rejects.toThrow('Argument must be a trace ID');
    });
  });

  describe('receipt', () => {
    it('signs the record of the delivery the caller is handling', async () => {
      kernelStore.recordDelivery({
        target: ko1,
        targetEndpoint: owner,
        sender: holder,
        cause: 2,
        method: 'poke',
        message: { methargs: { body: '#["poke",[]]', slots: [] } },
      });
      const [delivery] = kernelStore.getAccountabilityRecords();
      const receipt = await service.receipt({ caller: owner, cause: 0 });
      expect(receipt).toStrictEqual({
        payload: { kind: 'receipt', delivery },
        signer: 'peer',
        incarnationId: 'inc',
        signature: 'sig',
      });
    });

    it.each([
      ['outside a delivery', 'async' as const, 'outside a delivery'],
      [
        "from a callback, on the supervisor's word",
        { crankNumber: 7, witness: 'liveslots' } as const,
        'outside a delivery',
      ],
      [
        'for a delivery that left no record',
        7,
        'no record of the delivery to v1 in crank 7',
      ],
    ])('refuses a receipt %s', async (_what, cause, problem) => {
      await expect(service.receipt({ caller: owner, cause })).rejects.toThrow(
        problem,
      );
      expect(signer.sign).not.toHaveBeenCalled();
    });
  });
});
