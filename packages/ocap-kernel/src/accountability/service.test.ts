import { describe, it, expect, beforeEach, vi } from 'vitest';

import { makeAccountabilityService } from './service.ts';
import type { AccountabilityService } from './service.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import { kslot } from '../liveslots/kernel-marshal.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type { KRef } from '../types.ts';
import { asKRef, asVatId } from '../../test/branded.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

const owner = asVatId('v1');
const holder = asVatId('v2');
const other = asVatId('v3');

describe('accountability service', () => {
  let kernelStore: KernelStore;
  let kernelQueue: KernelQueue;
  let service: AccountabilityService;
  let ko1: KRef;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
    kernelQueue = {
      writeOutsideCrank: vi.fn(async (write: () => unknown) => write()),
    } as unknown as KernelQueue;
    service = makeAccountabilityService({ kernelStore, kernelQueue });
    ko1 = kernelStore.initKernelObject(owner);
  });

  it('tracks and untracks an object for the caller the kernel names', async () => {
    await service.track({ caller: holder }, kslot(ko1), { recordArgs: true });
    expect(kernelStore.getTrackers(ko1)).toStrictEqual({
      v2: { recordArgs: true },
    });
    await service.untrack({ caller: holder }, kslot(ko1));
    expect(kernelStore.isTracked(ko1)).toBe(false);
  });

  it('does its writes outside a crank', async () => {
    await service.track({ caller: holder }, kslot(ko1));
    expect(kernelQueue.writeOutsideCrank).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a promise', kslot(asKRef('kp1')), 'must be an object, not a promise'],
    ['a plain value', 'ko1', 'must be a remotable'],
  ])('refuses %s', async (_what, arg, problem) => {
    await expect(
      service.track({ caller: holder }, arg as never),
    ).rejects.toThrow(problem);
  });

  it('rejects track options it does not know', async () => {
    await expect(
      service.track({ caller: holder }, kslot(ko1), {
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

    it('shows the owner every record about the object', async () => {
      const records = await service.history({ caller: owner }, kslot(ko1));
      expect(records.map((record) => record.seq)).toStrictEqual([1, 2, 3]);
    });

    it('shows another holder its own chain of custody and the deliveries it sent', async () => {
      const records = await service.history({ caller: holder }, kslot(ko1));
      expect(records.map((record) => record.seq)).toStrictEqual([1, 3]);
    });
  });
});
