import type {
  VatOneResolution,
  VatSyscallObject,
} from '@agoric/swingset-liveslots';
import type { CapData } from '@endo/marshal';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type {
  KRef,
  VRef,
  KernelMessage,
  EndpointMessage,
} from '../../types.ts';
import type { StoreContext } from '../types.ts';
import * as clistModule from './clist.ts';
import * as reachableModule from './reachable.ts';
import * as refCountModule from './refcount.ts';
import { getTranslators } from './translators.ts';
import * as vatModule from './vat.ts';
import { asKRef, asVRef, asVatId } from '../../../test/branded.ts';

describe('getTranslators', () => {
  const mockKrefToEref = vi.fn();
  const mockErefToKref = vi.fn();
  const mockAllocateErefForKref = vi.fn();
  const mockExportFromEndpoint = vi.fn();
  const mockSetReachableFlag = vi.fn();
  const mockKernelRefExists = vi.fn();
  const mockCtx = {} as StoreContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKernelRefExists.mockReturnValue(true);

    vi.spyOn(clistModule, 'getCListMethods').mockReturnValue({
      krefToEref: mockKrefToEref,
      erefToKref: mockErefToKref,
      allocateErefForKref: mockAllocateErefForKref,
    } as unknown as ReturnType<typeof clistModule.getCListMethods>);

    vi.spyOn(reachableModule, 'getReachableMethods').mockReturnValue({
      setReachableFlag: mockSetReachableFlag,
    } as unknown as ReturnType<typeof reachableModule.getReachableMethods>);

    vi.spyOn(refCountModule, 'getRefCountMethods').mockReturnValue({
      kernelRefExists: mockKernelRefExists,
    } as unknown as ReturnType<typeof refCountModule.getRefCountMethods>);

    vi.spyOn(vatModule, 'getVatMethods').mockReturnValue({
      exportFromEndpoint: mockExportFromEndpoint,
    } as unknown as ReturnType<typeof vatModule.getVatMethods>);
  });

  describe('translateRefKtoE', () => {
    it('returns existing eref when found', () => {
      const vatId = asVatId('v1');
      const kref = asKRef('ko1');
      const expectedEref = asVRef('o+1');
      mockKrefToEref.mockReturnValue(expectedEref);
      const { translateRefKtoE } = getTranslators(mockCtx);
      const result = translateRefKtoE(vatId, kref, false);
      expect(mockKrefToEref).toHaveBeenCalledWith(vatId, kref);
      expect(result).toStrictEqual(expectedEref);
      expect(mockAllocateErefForKref).not.toHaveBeenCalled();
    });

    it('allocates new eref when not found and importIfNeeded is true', () => {
      const vatId = asVatId('v1');
      const kref = asKRef('ko1');
      const expectedEref = asVRef('o+1');
      mockKrefToEref.mockReturnValue(null);
      mockAllocateErefForKref.mockReturnValue(expectedEref);
      const { translateRefKtoE } = getTranslators(mockCtx);
      const result = translateRefKtoE(vatId, kref, true);
      expect(mockKrefToEref).toHaveBeenCalledWith(vatId, kref);
      expect(mockAllocateErefForKref).toHaveBeenCalledWith(vatId, kref);
      expect(result).toStrictEqual(expectedEref);
    });

    it('refuses to import a kref the kernel has deleted', () => {
      const vatId = asVatId('v1');
      const kref = asKRef('ko1');
      mockKrefToEref.mockReturnValue(null);
      mockKernelRefExists.mockReturnValue(false);
      const { translateRefKtoE } = getTranslators(mockCtx);
      expect(() => translateRefKtoE(vatId, kref, true)).toThrow(
        `cannot import deleted kref "${kref}" into "${vatId}"`,
      );
      expect(mockAllocateErefForKref).not.toHaveBeenCalled();
    });

    it('throws error when not found and importIfNeeded is false', () => {
      const vatId = asVatId('v1');
      const kref = asKRef('ko1');
      mockKrefToEref.mockReturnValue(null);
      const { translateRefKtoE } = getTranslators(mockCtx);
      expect(() => translateRefKtoE(vatId, kref, false)).toThrow(
        `unmapped kref "${kref}" endpoint="${vatId}"`,
      );
    });
  });

  describe('translateCapDataKtoE', () => {
    it('translates capdata from kernel to vat space', () => {
      const vatId = asVatId('v1');
      const kref1 = asKRef('ko1');
      const kref2 = asKRef('ko2');
      const eref1 = asVRef('o+1');
      const eref2 = asVRef('o+2');
      const capdata: CapData<KRef> = {
        body: 'test body',
        slots: [kref1, kref2],
      };
      const expectedCapData: CapData<VRef> = {
        body: 'test body',
        slots: [eref1, eref2],
      };
      mockKrefToEref.mockImplementation((_vId, kr) => {
        if (kr === kref1) {
          return eref1;
        }
        if (kr === kref2) {
          return eref2;
        }
        return null;
      });
      const { translateCapDataKtoE } = getTranslators(mockCtx);
      const result = translateCapDataKtoE(vatId, capdata);
      expect(result).toStrictEqual(expectedCapData);
      expect(mockKrefToEref).toHaveBeenCalledWith(vatId, kref1);
      expect(mockKrefToEref).toHaveBeenCalledWith(vatId, kref2);
    });
  });

  describe('translateMessageKtoE', () => {
    it('translates message from kernel to vat space', () => {
      const vatId = asVatId('v1');
      const kref = asKRef('ko1');
      const resultKref = asKRef('kp1');
      const eref = asVRef('o+1');
      const resultEref = asVRef('p-1');
      const message: KernelMessage = {
        methargs: {
          body: 'test method',
          slots: [kref],
        },
        result: resultKref,
      };
      mockKrefToEref.mockImplementation((_vId, kr) => {
        if (kr === kref) {
          return eref;
        }
        if (kr === resultKref) {
          return resultEref;
        }
        return null;
      });
      const expectedMessage: EndpointMessage = {
        methargs: {
          body: 'test method',
          slots: [eref],
        },
        result: resultEref,
      };
      const { translateMessageKtoE } = getTranslators(mockCtx);
      const result = translateMessageKtoE(vatId, message);
      expect(result).toStrictEqual(expectedMessage);
    });

    it('handles null result in message', () => {
      const vatId = asVatId('v1');
      const kref = asKRef('ko1');
      const eref = asVRef('o+1');
      const message: KernelMessage = {
        methargs: {
          body: 'test method',
          slots: [kref],
        },
        result: null,
      };
      mockKrefToEref.mockImplementation((_vId, kr) => {
        if (kr === kref) {
          return eref;
        }
        return null;
      });
      const expectedMessage: EndpointMessage = {
        methargs: {
          body: 'test method',
          slots: [eref],
        },
        result: null,
      };
      const { translateMessageKtoE } = getTranslators(mockCtx);
      const result = translateMessageKtoE(vatId, message);
      expect(result).toStrictEqual(expectedMessage);
    });
  });

  describe('translateSyscallVtoK', () => {
    const vatId = asVatId('v1');

    beforeEach(() => {
      mockErefToKref.mockImplementation((_vId, vr) => {
        if (vr === 'o+1') {
          return 'ko1';
        }
        if (vr === 'o+2') {
          return 'ko2';
        }
        if (vr === 'p-1') {
          return 'kp1';
        }
        return null;
      });
      mockExportFromEndpoint.mockImplementation((_vId, vr) => {
        return `exported-${vr}`;
      });
    });

    it('translates "send" syscall', () => {
      const vref = asVRef('o+1');
      const kref = asKRef('ko1');
      const vso: VatSyscallObject = [
        'send',
        vref,
        {
          methargs: {
            body: 'test method',
            slots: ['o+2'],
          },
          result: 'p-1',
        },
      ] as VatSyscallObject;
      const expectedKso: VatSyscallObject = [
        'send',
        kref,
        {
          methargs: {
            body: 'test method',
            slots: ['ko2'],
          },
          result: 'kp1',
        },
      ] as VatSyscallObject;
      const { translateSyscallVtoK } = getTranslators(mockCtx);
      const result = translateSyscallVtoK(vatId, vso);
      expect(result).toStrictEqual(expectedKso);
    });

    it('throws TypeError when message.result in "send" syscall is not a string', () => {
      const vref = asVRef('o+1');
      const vso: VatSyscallObject = [
        'send',
        vref,
        {
          methargs: {
            body: 'test method',
            slots: ['o+2'],
          },
          result: null,
        },
      ] as VatSyscallObject;

      const { translateSyscallVtoK } = getTranslators(mockCtx);
      expect(() => translateSyscallVtoK(vatId, vso)).toThrow(
        TypeError('message result must be a string'),
      );
    });

    it('translates "subscribe" syscall', () => {
      const vref = asVRef('p-1');
      const kref = asKRef('kp1');
      const vso: VatSyscallObject = ['subscribe', vref];
      const expectedKso: VatSyscallObject = ['subscribe', kref];
      const { translateSyscallVtoK } = getTranslators(mockCtx);
      const result = translateSyscallVtoK(vatId, vso);
      expect(result).toStrictEqual(expectedKso);
    });

    it('translates "resolve" syscall', () => {
      const vresolutions: VatOneResolution[] = [
        [
          'p-1',
          false,
          { body: 'data', slots: ['o+2'] } as unknown as CapData<VRef>,
        ],
      ];
      const kresoltuions: VatOneResolution[] = [
        ['kp1', false, { body: 'data', slots: ['ko2'] }],
      ];
      const vso: VatSyscallObject = ['resolve', vresolutions];
      const expectedKso: VatSyscallObject = ['resolve', kresoltuions];
      const { translateSyscallVtoK } = getTranslators(mockCtx);
      const result = translateSyscallVtoK(vatId, vso);
      expect(result).toStrictEqual(expectedKso);
    });

    it('translates "exit" syscall', () => {
      const vcapdata: CapData<VRef> = {
        body: 'exit info',
        slots: [asVRef('o+1')],
      };
      const kcapdata: CapData<KRef> = {
        body: 'exit info',
        slots: [asKRef('ko1')],
      };
      const vso: VatSyscallObject = ['exit', true, vcapdata];
      const expectedKso: VatSyscallObject = ['exit', true, kcapdata];
      const { translateSyscallVtoK } = getTranslators(mockCtx);
      const result = translateSyscallVtoK(vatId, vso);
      expect(result).toStrictEqual(expectedKso);
    });

    it.each([
      'dropImports',
      'retireImports',
      'retireExports',
      'abandonExports',
    ])('translates "%s" syscall', (op) => {
      const vrefs: VRef[] = [asVRef('o+1'), asVRef('o+2')];
      const krefs: KRef[] = [asKRef('ko1'), asKRef('ko2')];
      const vso: VatSyscallObject = [op, vrefs] as VatSyscallObject;
      const expectedKso: VatSyscallObject = [op, krefs] as VatSyscallObject;
      const { translateSyscallVtoK } = getTranslators(mockCtx);
      const result = translateSyscallVtoK(vatId, vso);
      expect(result).toStrictEqual(expectedKso);
    });

    it.each([
      'callNow',
      'vatstoreGet',
      'vatstoreGetNextKey',
      'vatstoreSet',
      'vatstoreDelete',
    ])('throws error for invalid syscall "%s"', (op) => {
      const vso: VatSyscallObject = [op] as unknown as VatSyscallObject;
      const { translateSyscallVtoK } = getTranslators(mockCtx);
      expect(() => translateSyscallVtoK(vatId, vso)).toThrow(
        `vat ${vatId} issued invalid syscall ${op}`,
      );
    });

    it('throws error for unknown syscall type', () => {
      const vso: VatSyscallObject = ['unknown'] as unknown as VatSyscallObject;
      const { translateSyscallVtoK } = getTranslators(mockCtx);
      expect(() => translateSyscallVtoK(vatId, vso)).toThrow(
        `vat ${vatId} issued unknown syscall unknown`,
      );
    });
  });
});
