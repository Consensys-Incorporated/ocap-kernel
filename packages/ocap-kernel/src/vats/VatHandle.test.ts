import type { VatOneResolution } from '@agoric/swingset-liveslots';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { isJsonRpcMessage } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import type { Json } from '@metamask/utils';
import { delay } from '@ocap/repo-tools/test-utils';
import { TestDuplexStream } from '@ocap/repo-tools/test-utils/streams';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

import type { KernelQueue } from '../KernelQueue.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  VRef,
  ERef,
  EndpointMessage,
  VatDeliveryResult,
} from '../types.ts';
import { VatHandle } from './VatHandle.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

vi.mock('@endo/eventual-send', () => ({
  E: () => ({
    testMethod: vi
      .fn()
      .mockImplementation((param: string) => `param is: ${param}`),
  }),
}));

let mockKernelStore: KernelStore;

const makeVat = async ({
  logger,
  dispatch,
}: {
  logger?: Logger;
  dispatch?: (input: unknown) => void | Promise<void>;
} = {}): Promise<{
  vat: VatHandle;
  stream: TestDuplexStream<JsonRpcMessage, JsonRpcMessage>;
}> => {
  const vatStream = await TestDuplexStream.make<JsonRpcMessage, JsonRpcMessage>(
    dispatch ?? (() => undefined),
    {
      validateInput: isJsonRpcMessage,
    },
  );
  return {
    vat: await VatHandle.make({
      kernelQueue: null as unknown as KernelQueue,
      kernelStore: mockKernelStore,
      vatId: 'v0',
      vatConfig: { sourceSpec: 'not-really-there.js' },
      vatStream,
      logger,
    }),
    stream: vatStream,
  };
};

describe('VatHandle', () => {
  let sendVatCommandMock: MockInstance<VatHandle['sendVatCommand']>;

  beforeEach(() => {
    mockKernelStore = makeKernelStore(makeMapKernelDatabase());
    sendVatCommandMock = vi
      .spyOn(VatHandle.prototype, 'sendVatCommand')
      .mockResolvedValueOnce(['fake', null] as unknown as VatDeliveryResult);
  });

  describe('init', () => {
    it('initializes the vat and sends initVat message', async () => {
      await makeVat();

      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'initVat' as const,
        params: {
          state: [],
          vatConfig: {
            sourceSpec: 'not-really-there.js',
          },
        },
      });
    });

    it('throws if the stream throws', async () => {
      const logger = {
        error: vi.fn(),
        subLogger: vi.fn(() => logger),
      } as unknown as Logger;
      const { stream } = await makeVat({ logger });
      await stream.receiveInput(NaN);
      await delay(10);
      expect(logger.error).toHaveBeenCalledWith(
        'Unexpected read error',
        expect.objectContaining({
          message: expect.stringMatching(/Message failed type validation/u),
        }),
      );
    });

    it('throws if handleMessage throws', async () => {
      const logger = {
        error: vi.fn(),
        subLogger: vi.fn(() => logger),
      } as unknown as Logger;
      const { stream } = await makeVat({ logger });
      await stream.receiveInput({
        id: 'v0:1',
        method: 'ping',
        params: [],
        jsonrpc: '2.0',
      });
      await delay(10);
      expect(logger.error).toHaveBeenCalledWith(
        'Unexpected read error',
        expect.objectContaining({
          message: expect.stringMatching(/^Received unexpected message/u),
        }),
      );
    });
  });

  describe('ping', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      sendVatCommandMock.mockResolvedValueOnce('pong');
      const result = await vat.ping();
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'ping',
        params: [],
      });
      expect(result).toBe('pong');
    });

    it('propagates errors from sendVatCommand', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const error = new Error('Ping failed');
      sendVatCommandMock.mockRejectedValueOnce(error);
      await expect(vat.ping()).rejects.toThrow('Ping failed');
    });
  });

  describe('deliverMessage', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const mockResult: VatDeliveryResult = [[[], []], null];
      sendVatCommandMock.mockResolvedValueOnce(mockResult);
      const target = 'o+0' as VRef;
      const message: EndpointMessage = {
        methargs: { body: '["arg1","arg2"]', slots: [] },
        result: 'p+1' as ERef,
      };
      await vat.deliverMessage(target, message);
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'deliver',
        params: ['message', target, message],
      });
    });
  });

  describe('deliverNotify', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const mockResult: VatDeliveryResult = [[[], []], null];
      sendVatCommandMock.mockResolvedValueOnce(mockResult);
      const resolutions: VatOneResolution[] = [
        ['vp123', false, { body: '"resolved value"', slots: [] }],
      ];
      await vat.deliverNotify(resolutions);
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'deliver',
        params: ['notify', resolutions],
      });
    });
  });

  describe('deliverDropExports', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const mockResult: VatDeliveryResult = [[[], []], null];
      sendVatCommandMock.mockResolvedValueOnce(mockResult);
      const vrefs: VRef[] = ['kp123', 'kp456'];
      await vat.deliverDropExports(vrefs);
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'deliver',
        params: ['dropExports', vrefs],
      });
    });
  });

  describe('deliverRetireExports', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const mockResult: VatDeliveryResult = [[[], []], null];
      sendVatCommandMock.mockResolvedValueOnce(mockResult);
      const vrefs: VRef[] = ['kp123', 'kp456'];
      await vat.deliverRetireExports(vrefs);
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'deliver',
        params: ['retireExports', vrefs],
      });
    });
  });

  describe('deliverRetireImports', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const mockResult: VatDeliveryResult = [[[], []], null];
      sendVatCommandMock.mockResolvedValueOnce(mockResult);
      const vrefs: VRef[] = ['kp123', 'kp456'];
      await vat.deliverRetireImports(vrefs);
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'deliver',
        params: ['retireImports', vrefs],
      });
    });
  });

  describe('deliverBringOutYourDead', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const mockResult: VatDeliveryResult = [[[], []], null];
      sendVatCommandMock.mockResolvedValueOnce(mockResult);
      await vat.deliverBringOutYourDead();
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'deliver',
        params: ['bringOutYourDead'],
      });
    });
  });

  describe('sendVatCommand', () => {
    it('sends a message and resolves the promise', async () => {
      const dispatch = vi.fn();
      const { vat, stream } = await makeVat({ dispatch });
      const mockMessage = {
        method: 'ping' as const,
        params: [] as Json[],
      };

      const sendVatCommandPromise = vat.sendVatCommand(mockMessage);
      await delay(10);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining(mockMessage),
      );

      await stream.receiveInput({
        id: 'v0:1',
        result: 'test-response',
        jsonrpc: '2.0',
      });

      expect(await sendVatCommandPromise).toBe('test-response');
    });
  });

  describe('terminate', () => {
    it('terminates the vat and rejects unresolved messages', async () => {
      const { vat, stream } = await makeVat();
      // terminate will remove the vat from the subcluster
      // so we need to add the vat to a subcluster
      mockKernelStore.addSubcluster({ bootstrap: 'test', vats: {} });
      mockKernelStore.addSubclusterVat('s1', 'test', 'v0');

      // Create a pending message that should be rejected on terminate
      const messagePromise = vat.sendVatCommand({
        method: 'ping' as const,
        params: [],
      });

      await vat.terminate(true);

      await expect(messagePromise).rejects.toThrow('Vat was deleted.');

      expect(await stream.next()).toStrictEqual({
        done: true,
        value: undefined,
      });
    });

    it('rejects pending commands before closing the channel', async () => {
      const inner = await TestDuplexStream.make<JsonRpcMessage, JsonRpcMessage>(
        () => undefined,
        { validateInput: isJsonRpcMessage },
      );
      let releaseEnd = (): void => undefined;
      const stalling = new Promise<void>((resolve) => {
        releaseEnd = resolve;
      });
      const vat = await VatHandle.make({
        kernelQueue: null as unknown as KernelQueue,
        kernelStore: mockKernelStore,
        vatId: 'v0',
        vatConfig: { sourceSpec: 'not-really-there.js' },
        // `end` never settles until released, so a rejection that arrives
        // before then is one that did not wait for the channel to close.
        vatStream: {
          drain: inner.drain.bind(inner),
          write: inner.write.bind(inner),
          end: async () => stalling,
        } as unknown as typeof inner,
      });
      sendVatCommandMock.mockRestore();
      const messagePromise = vat.sendVatCommand({
        method: 'ping' as const,
        params: [],
      });

      const terminating = vat.terminate(true);

      await expect(messagePromise).rejects.toThrow('Vat was deleted.');
      releaseEnd();
      await terminating;
    });

    it('leaves pending commands alone across a restart', async () => {
      const { vat } = await makeVat();
      const settled = vi.fn();
      // eslint-disable-next-line promise/catch-or-return
      vat
        .sendVatCommand({ method: 'ping' as const, params: [] })
        .then(settled, settled);

      await vat.terminate(false);
      await delay(10);

      // The same vat is coming back, and its answer with it.
      expect(settled).not.toHaveBeenCalled();
    });
  });
});
