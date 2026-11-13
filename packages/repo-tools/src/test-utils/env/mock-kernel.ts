import {
  object,
  define,
  literal,
  string,
  boolean,
  record,
  exactOptional,
  array,
  type,
  union,
} from '@metamask/superstruct';
import { vi } from 'vitest';

type ResetMocks = () => void;
type SetMockBehavior = (options: {
  isVatConfig?: boolean;
  isVatId?: boolean;
  isKRef?: boolean;
}) => void;

export const setupOcapKernelMock = (): {
  resetMocks: ResetMocks;
  setMockBehavior: SetMockBehavior;
} => {
  let isVatConfigMock = true;
  let isVatIdMock = true;
  let isKRefMock = true;
  // Mock implementation
  vi.doMock('@metamask/ocap-kernel', () => {
    const VatIdStruct = define<unknown>('VatId', () => isVatIdMock);
    const VatConfigStruct = define<unknown>('VatConfig', () => isVatConfigMock);
    const SubclusterIdStruct = define<unknown>('SubclusterId', () => true);
    const ClusterConfigStruct = object({
      bootstrap: string(),
      forceReset: exactOptional(boolean()),
      vats: record(string(), VatConfigStruct),
      bundles: exactOptional(record(string(), VatConfigStruct)),
    });
    const SubclusterStruct = object({
      id: SubclusterIdStruct,
      config: ClusterConfigStruct,
      vats: array(VatIdStruct),
    });

    const KRefStruct = define<unknown>('KRef', () => isKRefMock);

    const RunLoopStatusStruct = union([
      type({ state: literal('idle') }),
      type({ state: literal('running') }),
      type({ state: literal('stopped') }),
      type({ state: literal('failed'), error: string(), detail: string() }),
    ]);

    return {
      isVatId: () => isVatIdMock,
      isVatConfig: () => isVatConfigMock,
      isKRef: () => isKRefMock,
      insistKRef: (value: unknown) => {
        if (!isKRefMock) {
          throw new Error(`Expected KRef, got ${String(value)}`);
        }
      },
      KRefStruct,
      VatIdStruct,
      VatConfigStruct,
      SubclusterIdStruct,
      SubclusterStruct,
      CapDataStruct: object({
        body: string(),
        slots: array(string()),
      }),
      ClusterConfigStruct,
      RunLoopStatusStruct,
      KernelStatusStruct: type({
        subclusters: array(SubclusterStruct),
        vats: array(
          object({
            id: VatIdStruct,
            config: VatConfigStruct,
            subclusterId: SubclusterIdStruct,
          }),
        ),
        runLoop: RunLoopStatusStruct,
      }),
      KernelSendMessageStruct: object({
        id: literal('v0'),
        payload: object({
          method: literal('ping'),
          params: literal(null),
        }),
      }),
      PlatformServicesCommandMethod: {
        launch: 'launch',
        terminate: 'terminate',
        terminateAll: 'terminateAll',
      },
    };
  });

  return {
    resetMocks: (): void => {
      isVatConfigMock = true;
      isVatIdMock = true;
      isKRefMock = true;
    },
    setMockBehavior: (options: {
      isVatConfig?: boolean;
      isVatId?: boolean;
      isKRef?: boolean;
    }): void => {
      if (typeof options.isVatConfig === 'boolean') {
        isVatConfigMock = options.isVatConfig;
      }
      if (typeof options.isVatId === 'boolean') {
        isVatIdMock = options.isVatId;
      }
      if (typeof options.isKRef === 'boolean') {
        isKRefMock = options.isKRef;
      }
    },
  };
};
