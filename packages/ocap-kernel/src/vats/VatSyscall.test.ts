import type {
  VatOneResolution,
  VatSyscallObject,
} from '@agoric/swingset-liveslots';
import type { Logger } from '@metamask/logger';
import type { MockInstance } from 'vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { KernelQueue } from '../KernelQueue.ts';
import { makeFatalKernelError } from '../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../store/index.ts';
import type { KernelMessage, VatId } from '../types.ts';
import { VatSyscall } from './VatSyscall.ts';
import { makeStoreFault } from '../../test/storage.ts';

describe('VatSyscall', () => {
  let kernelQueue: KernelQueue;
  let kernelStore: KernelStore;
  let logger: Logger;
  let vatSys: VatSyscall;

  beforeEach(() => {
    kernelQueue = {
      enqueueSend: vi.fn(),
      resolvePromises: vi.fn(),
      enqueueNotify: vi.fn(),
      isHalted: vi.fn(() => false),
      panic: vi.fn(
        (problem: string, cause: unknown) =>
          new Error(`Kernel panic: ${problem}`, { cause }),
      ),
    } as unknown as KernelQueue;
    kernelStore = {
      translateSyscallVtoK: vi.fn((_: string, vso: VatSyscallObject) => vso),
      getKernelPromise: vi.fn(),
      addPromiseSubscriber: vi.fn(),
      clearReachableFlag: vi.fn(),
      getReachableFlag: vi.fn(),
      forgetKref: vi.fn(),
      getOwner: vi.fn(() => 'v1'),
      orphanKernelObject: vi.fn(),
      // The identity mock for `translateSyscallVtoK` leaves the vref in place,
      // so the c-list round-trip is the identity too.
      krefToEref: vi.fn((_endpointId: string, kref: string) => kref),
      getVatConfig: vi.fn(() => ({})),
      isVatActive: vi.fn(() => true),
      isInCrank: vi.fn(() => true),
    } as unknown as KernelStore;
    logger = {
      debug: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      subLogger: vi.fn(() => logger),
    } as unknown as Logger;
    vatSys = new VatSyscall({
      vatId: 'v1' as VatId,
      kernelQueue,
      kernelStore,
      logger,
    });
  });

  it('buffers send syscall for crank completion', async () => {
    const target = 'ko1';
    const message = {
      methargs: { body: '', slots: [] },
    } as KernelMessage;
    const vso = ['send', target, message] as VatSyscallObject;
    vatSys.handleSyscall(vso);
    expect(kernelQueue.enqueueSend).toHaveBeenCalledWith(
      target,
      message,
      false,
    );
  });

  it('calls resolvePromises for resolve syscall', async () => {
    const resolution = ['kp1', false, {}] as VatOneResolution;
    const vso = ['resolve', [resolution]] as VatSyscallObject;
    vatSys.handleSyscall(vso);
    expect(kernelQueue.resolvePromises).toHaveBeenCalledWith(
      'v1',
      [resolution],
      false,
    );
  });

  it('enqueues send immediately when outside a crank', () => {
    (kernelStore.isInCrank as unknown as MockInstance).mockReturnValue(false);
    const target = 'ko1';
    const message = {
      methargs: { body: '', slots: [] },
    } as KernelMessage;
    const vso = ['send', target, message] as VatSyscallObject;
    vatSys.handleSyscall(vso);
    expect(kernelQueue.enqueueSend).toHaveBeenCalledWith(target, message, true);
  });

  it('resolves promises immediately when outside a crank', () => {
    (kernelStore.isInCrank as unknown as MockInstance).mockReturnValue(false);
    const resolution = ['kp1', false, {}] as VatOneResolution;
    const vso = ['resolve', [resolution]] as VatSyscallObject;
    vatSys.handleSyscall(vso);
    expect(kernelQueue.resolvePromises).toHaveBeenCalledWith(
      'v1',
      [resolution],
      true,
    );
  });

  describe('subscribe syscall', () => {
    it('subscribes to unresolved promise', async () => {
      (
        kernelStore.getKernelPromise as unknown as MockInstance
      ).mockReturnValueOnce({
        state: 'unresolved',
      });
      const vso = ['subscribe', 'kp1'] as VatSyscallObject;
      vatSys.handleSyscall(vso);
      expect(kernelStore.addPromiseSubscriber).toHaveBeenCalledWith(
        'v1',
        'kp1',
      );
    });

    it('notifies for resolved promise', async () => {
      (
        kernelStore.getKernelPromise as unknown as MockInstance
      ).mockReturnValueOnce({
        state: 'fulfilled',
      });
      const vso = ['subscribe', 'kp1'] as VatSyscallObject;
      vatSys.handleSyscall(vso);
      expect(kernelQueue.enqueueNotify).toHaveBeenCalledWith(
        'v1',
        'kp1',
        false,
      );
    });

    it('notifies immediately for resolved promise when outside a crank', () => {
      (kernelStore.isInCrank as unknown as MockInstance).mockReturnValue(false);
      (
        kernelStore.getKernelPromise as unknown as MockInstance
      ).mockReturnValueOnce({
        state: 'fulfilled',
      });
      const vso = ['subscribe', 'kp1'] as VatSyscallObject;
      vatSys.handleSyscall(vso);
      expect(kernelQueue.enqueueNotify).toHaveBeenCalledWith('v1', 'kp1', true);
    });
  });

  describe('dropImports syscall', () => {
    it('clears reachable flags for valid imports', async () => {
      const vso = ['dropImports', ['o-1', 'o-2']] as VatSyscallObject;
      vatSys.handleSyscall(vso);
      expect(kernelStore.clearReachableFlag).toHaveBeenCalledWith('v1', 'o-1');
      expect(kernelStore.clearReachableFlag).toHaveBeenCalledWith('v1', 'o-2');
    });

    it.each([
      ['o+1', 'vat v1 issued invalid syscall dropImports for o+1'],
      ['p-1', 'vat v1 issued invalid syscall dropImports for p-1'],
    ])('returns error for invalid ref %s', async (ref, errMsg) => {
      (
        kernelStore.translateSyscallVtoK as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw new Error(errMsg);
      });
      const vso = ['dropImports', [ref]] as VatSyscallObject;
      const result = vatSys.handleSyscall(vso);
      expect(result).toStrictEqual(['error', errMsg]);
    });
  });

  describe('retireImports syscall', () => {
    it('forgets kref when not reachable', async () => {
      (
        kernelStore.getReachableFlag as unknown as MockInstance
      ).mockReturnValueOnce(false);
      const vso = ['retireImports', ['o-1']] as VatSyscallObject;
      vatSys.handleSyscall(vso);
      expect(kernelStore.forgetKref).toHaveBeenCalledWith('v1', 'o-1');
    });

    it('returns error if still reachable', async () => {
      (
        kernelStore.translateSyscallVtoK as unknown as MockInstance
      ).mockImplementationOnce(() => {
        (
          kernelStore.getReachableFlag as unknown as MockInstance
        ).mockReturnValueOnce(true);
        throw new Error('syscall.retireImports but o-1 is still reachable');
      });
      const vso = ['retireImports', ['o-1']] as VatSyscallObject;
      const result = vatSys.handleSyscall(vso);
      expect(result).toStrictEqual([
        'error',
        'syscall.retireImports but o-1 is still reachable',
      ]);
    });
  });

  describe('exportCleanup syscalls', () => {
    it('retires exports when not reachable', async () => {
      (
        kernelStore.getReachableFlag as unknown as MockInstance
      ).mockReturnValueOnce(false);
      const vso = ['retireExports', ['o+1']] as VatSyscallObject;
      vatSys.handleSyscall(vso);
      expect(kernelStore.forgetKref).toHaveBeenCalledWith('v1', 'o+1');
      expect(logger.debug).toHaveBeenCalledWith(
        'retireExports: deleted object o+1',
      );
    });

    it('returns error for reachable exports', async () => {
      (
        kernelStore.translateSyscallVtoK as unknown as MockInstance
      ).mockImplementationOnce(() => {
        (
          kernelStore.getReachableFlag as unknown as MockInstance
        ).mockReturnValueOnce(true);
        throw new Error('syscall.retireExports but o+1 is still reachable');
      });
      const vso = ['retireExports', ['o+1']] as VatSyscallObject;
      const result = vatSys.handleSyscall(vso);
      expect(result).toStrictEqual([
        'error',
        'syscall.retireExports but o+1 is still reachable',
      ]);
    });

    it('abandons exports without reachability check', async () => {
      const vso = ['abandonExports', ['o+1']] as VatSyscallObject;
      vatSys.handleSyscall(vso);
      expect(kernelStore.forgetKref).toHaveBeenCalledWith('v1', 'o+1');
      expect(logger.debug).toHaveBeenCalledWith(
        'abandonExports: deleted object o+1',
      );
    });

    it('returns error for invalid abandonExports refs', async () => {
      (
        kernelStore.translateSyscallVtoK as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw new Error('vat v1 issued invalid syscall abandonExports for o-1');
      });
      const vso = ['abandonExports', ['o-1']] as VatSyscallObject;
      const result = vatSys.handleSyscall(vso);
      expect(result).toStrictEqual([
        'error',
        'vat v1 issued invalid syscall abandonExports for o-1',
      ]);
    });
  });

  describe('exit syscall', () => {
    it('records vat termination request', async () => {
      const vso = [
        'exit',
        true,
        { message: 'error' },
      ] as unknown as VatSyscallObject;
      vatSys.handleSyscall(vso);
      expect(vatSys.vatRequestedTermination).toStrictEqual({
        reject: true,
        info: { message: 'error' },
      });
    });
  });

  describe('error handling', () => {
    const sendToKo1 = [
      'send',
      'ko1',
      { methargs: { body: '#null', slots: [] }, result: null },
    ] as VatSyscallObject;

    it('handles vat not found error', async () => {
      (kernelStore.isVatActive as unknown as MockInstance).mockReturnValueOnce(
        false,
      );
      const vso = ['send', 'ko1', {}] as VatSyscallObject;
      const result = vatSys.handleSyscall(vso);

      expect(result).toStrictEqual(['error', 'vat not found']);
      expect(vatSys.illegalSyscall).toBeDefined();
    });

    it('handles general syscall errors', async () => {
      const error = new Error('test error');
      (
        kernelStore.translateSyscallVtoK as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw error;
      });

      const vso = ['send', 'ko1', {}] as VatSyscallObject;
      const result = vatSys.handleSyscall(vso);

      expect(result).toStrictEqual(['error', 'test error']);
      expect(logger.error).toHaveBeenCalledWith(
        'Fatal syscall error in vat v1',
        error,
      );
    });

    it.each([
      {
        where: 'during translation',
        fail: (fault: Error) =>
          (
            kernelStore.translateSyscallVtoK as unknown as MockInstance
          ).mockImplementationOnce(() => {
            throw fault;
          }),
      },
      {
        where: 'after translation',
        fail: (fault: Error) =>
          (
            kernelQueue.enqueueSend as unknown as MockInstance
          ).mockImplementationOnce(() => {
            throw fault;
          }),
      },
    ])(
      'stops the kernel on a store fault $where, without blaming the vat',
      ({ fail }) => {
        const storeFault = makeStoreFault();
        fail(storeFault);

        const result = vatSys.handleSyscall(sendToKo1);

        expect({
          result,
          panic: (kernelQueue.panic as unknown as MockInstance).mock.calls,
          illegalSyscall: vatSys.illegalSyscall,
        }).toStrictEqual({
          result: ['error', 'Kernel panic: syscall send from vat v1 failed'],
          panic: [['syscall send from vat v1 failed', storeFault]],
          illegalSyscall: undefined,
        });
      },
    );

    it('terminates the vat on any other failure after translation', () => {
      (
        kernelQueue.enqueueSend as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw new Error('kernel bug');
      });

      const result = vatSys.handleSyscall(sendToKo1);

      expect({
        result,
        illegalSyscall: vatSys.illegalSyscall,
        panic: (kernelQueue.panic as unknown as MockInstance).mock.calls,
      }).toStrictEqual({
        result: ['error', 'kernel bug'],
        illegalSyscall: {
          vatId: 'v1',
          info: makeFatalKernelError(
            'ILLEGAL_SYSCALL',
            'Syscall translation error: prepare to die',
          ),
        },
        panic: [],
      });
    });

    it('refuses a syscall once the kernel has halted, without blaming the vat', () => {
      (kernelQueue.isHalted as unknown as MockInstance).mockReturnValue(true);

      const result = vatSys.handleSyscall(sendToKo1);

      expect({
        result,
        sent: (kernelQueue.enqueueSend as unknown as MockInstance).mock.calls,
        illegalSyscall: vatSys.illegalSyscall,
      }).toStrictEqual({
        result: ['error', 'Kernel has halted'],
        sent: [],
        illegalSyscall: undefined,
      });
    });
  });

  describe('invalid or unknown syscalls', () => {
    // Invalid syscalls (callNow, vatstoreGet, etc.) are rejected by
    // translateSyscallVtoK before reaching handleSyscall's switch.
    // Only truly unknown ops reach the default branch here.
    it('unknown syscall warns', async () => {
      const spy = vi.spyOn(logger, 'warn');
      const vso = ['unknownOp', []] as unknown as VatSyscallObject;
      vatSys.handleSyscall(vso);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('unknown syscall unknownOp'),
        vso,
      );
      spy.mockRestore();
    });
  });

  describe('logging', () => {
    it('is disabled if logger is undefined', async () => {
      const logSpy = vi.spyOn(console, 'log');
      const vatSyscall = new VatSyscall({
        vatId: 'v1' as VatId,
        kernelQueue,
        kernelStore,
      });
      vatSyscall.handleSyscall(['send', 'ko1', {}] as VatSyscallObject);
      expect(logSpy).not.toHaveBeenCalled();
      expect(logger.log).not.toHaveBeenCalled();
    });
  });
});
