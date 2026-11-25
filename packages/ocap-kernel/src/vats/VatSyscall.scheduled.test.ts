import type {
  VatOneResolution,
  VatSyscallObject,
} from '@agoric/swingset-liveslots';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VatSyscall } from './VatSyscall.ts';
import type { AccountabilityRecord } from '../accountability/types.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import type { KernelStore } from '../store/index.ts';
import type { KernelMessage, VatId } from '../types.ts';

const message = { methargs: { body: '', slots: [] } } as KernelMessage;
const send = ['send', 'ko1', message] as VatSyscallObject;
const tracedDelivery = {
  kind: 'delivery',
  traceId: 'trace-1',
  hop: 2,
  hopLimit: 8,
} as AccountabilityRecord;

describe('a syscall from a callback the vat scheduled during a delivery', () => {
  let kernelQueue: KernelQueue;
  let kernelStore: KernelStore;
  let records: AccountabilityRecord[];
  let vatSys: VatSyscall;

  beforeEach(() => {
    records = [];
    kernelQueue = {
      enqueueSend: vi.fn(),
      resolvePromises: vi.fn(),
    } as unknown as KernelQueue;
    kernelStore = {
      translateSyscallVtoK: vi.fn((_: string, vso: VatSyscallObject) => vso),
      isVatActive: vi.fn(() => true),
      isInCrank: vi.fn(() => false),
      getCrankNumber: vi.fn(() => 9),
      getAccountabilityRecords: vi.fn(() => records),
    } as unknown as KernelStore;
    vatSys = new VatSyscall({
      vatId: 'v1' as VatId,
      kernelQueue,
      kernelStore,
    });
  });

  it("charges a send to that delivery's crank, on the supervisor's word, and carries its trace on", () => {
    records = [tracedDelivery];
    vatSys.handleSyscall(send, 5);
    expect(kernelQueue.enqueueSend).toHaveBeenCalledWith('ko1', message, {
      sender: 'v1',
      immediate: true,
      cause: { crankNumber: 5, witness: 'liveslots' },
      trace: { id: 'trace-1', hop: 3, hopLimit: 8 },
    });
    expect(kernelStore.getAccountabilityRecords).toHaveBeenCalledWith({
      endpoint: 'v1',
      crank: 5,
      witness: 'kernel',
    });
  });

  it("carries no trace on from a delivery at its trace's hop limit", () => {
    records = [{ ...tracedDelivery, hop: 7 } as AccountabilityRecord];
    vatSys.handleSyscall(send, 5);
    expect(kernelQueue.enqueueSend).toHaveBeenCalledWith('ko1', message, {
      sender: 'v1',
      immediate: true,
      cause: { crankNumber: 5, witness: 'liveslots' },
      trace: null,
    });
  });

  it('carries no trace where the kernel has no record of the delivery', () => {
    vatSys.handleSyscall(send, 5);
    expect(kernelQueue.enqueueSend).toHaveBeenCalledWith('ko1', message, {
      sender: 'v1',
      immediate: true,
      cause: { crankNumber: 5, witness: 'liveslots' },
      trace: null,
    });
  });

  it("carries the delivery's trace on a resolution", () => {
    records = [tracedDelivery];
    const resolution = ['kp1', false, {}] as VatOneResolution;
    vatSys.handleSyscall(['resolve', [resolution]], 5);
    expect(kernelQueue.resolvePromises).toHaveBeenCalledWith(
      'v1',
      [resolution],
      { immediate: true, trace: { id: 'trace-1', hop: 3, hopLimit: 8 } },
    );
  });

  it.each([
    ['before the first', 0],
    ['the kernel has not run', 10],
    ['that is not a crank', 2.5],
  ])('takes no word of a crank %s', (_what, crank) => {
    vatSys.handleSyscall(send, crank);
    expect(kernelQueue.enqueueSend).toHaveBeenCalledWith('ko1', message, {
      sender: 'v1',
      immediate: true,
      cause: 'async',
      trace: null,
    });
    expect(kernelStore.getAccountabilityRecords).not.toHaveBeenCalled();
  });

  it("takes the supervisor's word while another vat's crank is open", () => {
    vi.mocked(kernelStore.isInCrank).mockReturnValue(true);
    vatSys.handleSyscall(send, 5);
    expect(kernelQueue.enqueueSend).toHaveBeenCalledWith('ko1', message, {
      sender: 'v1',
      immediate: false,
      cause: { crankNumber: 5, witness: 'liveslots' },
      trace: null,
    });
  });

  it("takes the delivery in flight over the supervisor's word", () => {
    vi.mocked(kernelStore.isInCrank).mockReturnValue(true);
    vatSys.delivering = true;
    vatSys.handleSyscall(send, 5);
    expect(kernelQueue.enqueueSend).toHaveBeenCalledWith('ko1', message, {
      sender: 'v1',
      immediate: false,
      cause: 9,
    });
    expect(kernelStore.getAccountabilityRecords).not.toHaveBeenCalled();
  });
});
