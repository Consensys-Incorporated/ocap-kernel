import type { VatOneResolution } from '@agoric/swingset-liveslots';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { isJsonRpcMessage } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import type { Json } from '@metamask/utils';
import { delay } from '@ocap/repo-tools/test-utils';
import { TestDuplexStream } from '@ocap/repo-tools/test-utils/streams';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

import { asERef, asSubclusterId, asVatId } from '../../test/branded.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import { makeFatalKernelError } from '../liveslots/kernel-marshal.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  VRef,
  ERef,
  EndpointMessage,
  VatDeliveryResult,
} from '../types.ts';
import { MAX_VAT_MESSAGE_LENGTH } from './vat-limits.ts';
import { VatHandle } from './VatHandle.ts';
import { VatSyscall } from './VatSyscall.ts';
import type { InitVatResult } from '../rpc/vat/initVat.ts';
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
  onStreamFailure = () => undefined,
  kernelQueue = null as unknown as KernelQueue,
}: {
  logger?: Logger;
  kernelQueue?: KernelQueue;
  dispatch?: (input: unknown) => void | Promise<void>;
  onStreamFailure?: (error: Error) => void;
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
      kernelQueue,
      kernelStore: mockKernelStore,
      vatId: asVatId('v0'),
      vatConfig: { sourceSpec: 'not-really-there.js' },
      vatStream,
      logger,
      onStreamFailure,
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
      .mockResolvedValueOnce([
        'fake',
        null,
        'sha256:00',
      ] as unknown as InitVatResult);
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

    it('keeps the bundle hash the worker reports', async () => {
      await makeVat();
      expect(mockKernelStore.getVatBundleHash(asVatId('v0'))).toBe('sha256:00');
    });

    it('keeps no bundle hash when the first delivery failed', async () => {
      sendVatCommandMock
        .mockReset()
        .mockResolvedValueOnce([
          'fake',
          'boom',
          'sha256:00',
        ] as unknown as InitVatResult);
      await makeVat();
      expect(mockKernelStore.getVatBundleHash(asVatId('v0'))).toBeUndefined();
    });

    it.each([
      ['the stream throws', NaN, /Message failed type validation/u],
      [
        'handleMessage throws',
        { id: 'v0:1', method: 'ping', params: [], jsonrpc: '2.0' },
        /^Received unexpected message/u,
      ],
      [
        'a syscall is over the size limit',
        {
          jsonrpc: '2.0',
          method: 'syscall',
          params: [
            'exit',
            false,
            { body: 'x'.repeat(MAX_VAT_MESSAGE_LENGTH), slots: [] },
          ],
        },
        /^Vat v0 sent a syscall over 12000000 characters$/u,
      ],
    ])('reports the failure if %s', async (_case, input, cause) => {
      const onStreamFailure = vi.fn();
      const { stream } = await makeVat({ onStreamFailure });

      await stream.receiveInput(input);
      await delay(10);

      expect(onStreamFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Unexpected stream read error.',
          cause: expect.objectContaining({
            message: expect.stringMatching(cause),
          }),
        }),
      );
    });

    it('reports a channel that closes with no error', async () => {
      const onStreamFailure = vi.fn();
      const { stream } = await makeVat({ onStreamFailure });

      await stream.return();
      await delay(10);

      expect(onStreamFailure).toHaveBeenCalledOnce();
      expect(onStreamFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Unexpected stream read error.',
          cause: expect.objectContaining({ message: 'vat channel closed' }),
        }),
      );
    });

    it('fails a pending command when the channel closes', async () => {
      const { vat, stream } = await makeVat({ onStreamFailure: vi.fn() });
      sendVatCommandMock.mockRestore();
      const pinging = vat.sendVatCommand({
        method: 'ping' as const,
        params: [],
      });

      await stream.return();

      await expect(pinging).rejects.toThrow('Unexpected stream read error.');
    });

    it('says nothing when it closes its own channel', async () => {
      const onStreamFailure = vi.fn();
      const { vat } = await makeVat({ onStreamFailure });

      await vat.terminate(true);
      await delay(10);

      expect(onStreamFailure).not.toHaveBeenCalled();
    });

    it('leaves a pending command waiting once the kernel will close the channel', async () => {
      const onStreamFailure = vi.fn();
      const { vat, stream } = await makeVat({ onStreamFailure });
      sendVatCommandMock.mockRestore();
      const settled = vi.fn();
      vat
        .sendVatCommand({ method: 'ping' as const, params: [] })
        .then(settled)
        .catch(settled);

      vat.expectClose();
      await stream.return();
      await delay(10);

      expect(settled).not.toHaveBeenCalled();
      expect(onStreamFailure).not.toHaveBeenCalled();
    });

    it('rejects pending commands when the channel dies', async () => {
      const { vat, stream } = await makeVat();
      sendVatCommandMock.mockRestore();
      const messagePromise = vat.sendVatCommand({
        method: 'ping' as const,
        params: [],
      });

      await stream.receiveInput(NaN);

      await expect(messagePromise).rejects.toThrow(
        'Unexpected stream read error.',
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
        params: {
          delivery: ['message', target, message],
          crankNumber: mockKernelStore.getCrankNumber(),
        },
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
        params: {
          delivery: ['notify', resolutions],
          crankNumber: mockKernelStore.getCrankNumber(),
        },
      });
    });
  });

  describe('deliverDropExports', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const mockResult: VatDeliveryResult = [[[], []], null];
      sendVatCommandMock.mockResolvedValueOnce(mockResult);
      const vrefs: VRef[] = ['kp123' as VRef, 'kp456' as VRef];
      await vat.deliverDropExports(vrefs);
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'deliver',
        params: {
          delivery: ['dropExports', vrefs],
          crankNumber: mockKernelStore.getCrankNumber(),
        },
      });
    });
  });

  describe('deliverRetireExports', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const mockResult: VatDeliveryResult = [[[], []], null];
      sendVatCommandMock.mockResolvedValueOnce(mockResult);
      const vrefs: VRef[] = ['kp123' as VRef, 'kp456' as VRef];
      await vat.deliverRetireExports(vrefs);
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'deliver',
        params: {
          delivery: ['retireExports', vrefs],
          crankNumber: mockKernelStore.getCrankNumber(),
        },
      });
    });
  });

  describe('deliverRetireImports', () => {
    it('calls sendVatCommand with the correct method and params', async () => {
      const { vat } = await makeVat();
      sendVatCommandMock.mockReset();
      const mockResult: VatDeliveryResult = [[[], []], null];
      sendVatCommandMock.mockResolvedValueOnce(mockResult);
      const vrefs: VRef[] = ['kp123' as VRef, 'kp456' as VRef];
      await vat.deliverRetireImports(vrefs);
      expect(sendVatCommandMock).toHaveBeenCalledTimes(1);
      expect(sendVatCommandMock).toHaveBeenCalledWith({
        method: 'deliver',
        params: {
          delivery: ['retireImports', vrefs],
          crankNumber: mockKernelStore.getCrankNumber(),
        },
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
        params: {
          delivery: ['bringOutYourDead'],
          crankNumber: mockKernelStore.getCrankNumber(),
        },
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

    it.each([
      [
        'a state entry over the size limit',
        [
          [
            [
              ['small', 'value'],
              ['big', 'x'.repeat(MAX_VAT_MESSAGE_LENGTH)],
            ],
            [],
          ],
          null,
        ],
        `Vat v0 wrote a state entry over ${MAX_VAT_MESSAGE_LENGTH} characters`,
      ],
      [
        'a delivery error over 10,000 characters',
        [[[['small', 'value']], []], 'x'.repeat(10_005)],
        `${'x'.repeat(10_000)}… (5 more characters)`,
      ],
    ])(
      'terminates a vat whose delivery reply has %s, writing none of its state',
      async (_what, reply, reason) => {
        const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
        mockKernelStore = makeKernelStore(kdb);
        const { vat, stream } = await makeVat();
        const delivering = vat.deliverMessage(asERef('o+0'), {
          methargs: { body: '#["hello",[]]', slots: [] },
          result: null,
        });
        await delay(10);

        await stream.receiveInput({
          id: 'v0:1',
          result: reply,
          jsonrpc: '2.0',
        });

        expect({
          crank: await delivering,
          state: kdb.makeVatStore('v0').getKVData(),
        }).toStrictEqual({
          crank: {
            didDelivery: 'v0',
            abort: true,
            terminate: {
              vatId: 'v0',
              reject: true,
              info: makeFatalKernelError('INTERNAL_ERROR', reason),
            },
          },
          state: [],
        });
      },
    );

    it('refuses a vat whose initVat reply has a state entry over the size limit, writing none of it', async () => {
      sendVatCommandMock.mockRestore();
      const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
      kdb.makeVatStore('v0').updateKVData([['kept', 'old']], []);
      const holder: {
        stream?: TestDuplexStream<JsonRpcMessage, JsonRpcMessage>;
      } = {};
      const vatStream = await TestDuplexStream.make<
        JsonRpcMessage,
        JsonRpcMessage
      >(
        () => {
          setTimeout(() => {
            holder.stream
              ?.receiveInput({
                jsonrpc: '2.0',
                id: 'v0:1',
                result: [
                  [[['big', 'x'.repeat(MAX_VAT_MESSAGE_LENGTH)]], ['kept']],
                  null,
                  'sha256:00',
                ],
              })
              .catch(() => undefined);
          }, 0);
        },
        { validateInput: isJsonRpcMessage },
      );
      holder.stream = vatStream;

      const making = VatHandle.make({
        kernelQueue: null as unknown as KernelQueue,
        kernelStore: makeKernelStore(kdb),
        vatId: asVatId('v0'),
        vatConfig: { sourceSpec: 'not-really-there.js' },
        vatStream,
        onStreamFailure: () => undefined,
      });

      await expect(making).rejects.toThrow(
        `Failed to initialize vat v0: Vat v0 wrote a state entry over ${MAX_VAT_MESSAGE_LENGTH} characters`,
      );
      expect(kdb.makeVatStore('v0').getKVData()).toStrictEqual([
        ['kept', 'old'],
      ]);
    });

    it('terminates a vat whose worker answers a delivery with an error', async () => {
      const { vat, stream } = await makeVat();
      const delivering = vat.deliverMessage(asERef('o+0'), {
        methargs: { body: '#["hello",[]]', slots: [] },
        result: null,
      });
      await delay(10);

      await stream.receiveInput({
        id: 'v0:1',
        error: { code: -32603, message: 'worker blew up' },
        jsonrpc: '2.0',
      });

      expect(await delivering).toStrictEqual({
        didDelivery: 'v0',
        abort: true,
        terminate: {
          vatId: 'v0',
          reject: true,
          info: {
            body: expect.stringContaining('worker blew up'),
            slots: [],
          },
        },
      });
    });

    it('takes a syscall as late unless a delivery is waiting for its answer', async () => {
      sendVatCommandMock.mockRestore();
      const inDelivery = vi
        .spyOn(VatSyscall.prototype, 'handleSyscall')
        .mockReturnValue(['ok', null]);
      const late = vi
        .spyOn(VatSyscall.prototype, 'handleLateSyscall')
        .mockReturnValue(undefined);
      const stream = await TestDuplexStream.make<
        JsonRpcMessage,
        JsonRpcMessage
      >(() => undefined, { validateInput: isJsonRpcMessage });
      const syscall = async (kpid: string): Promise<void> => {
        await stream.receiveInput({
          jsonrpc: '2.0',
          method: 'syscall',
          params: ['subscribe', kpid],
        });
        await delay(10);
      };
      const answer = async (id: string, result: Json): Promise<void> =>
        await stream.receiveInput({ id, result, jsonrpc: '2.0' });

      const making = VatHandle.make({
        kernelQueue: null as unknown as KernelQueue,
        kernelStore: mockKernelStore,
        vatId: asVatId('v0'),
        vatConfig: { sourceSpec: 'not-really-there.js' },
        vatStream: stream,
        onStreamFailure: () => undefined,
      });
      await delay(10);
      await syscall('during initVat');
      await answer('v0:1', [[[], []], null, 'sha256:00']);
      const vat = await making;
      const idlePing = vat.ping();
      await delay(10);
      await answer('v0:2', 'pong');
      await idlePing;
      await syscall('after initVat and a ping');

      const delivering = vat.deliverBringOutYourDead();
      const pinging = vat.ping();
      await delay(10);
      await answer('v0:4', 'pong');
      await pinging;
      await syscall('during deliver, after a ping');
      await answer('v0:3', [[[], []], null]);
      await delivering;
      await syscall('after deliver');

      expect({
        inDelivery: inDelivery.mock.calls.map(([vso]) => vso[1]),
        late: late.mock.calls.map(([vso]) => vso[1]),
      }).toStrictEqual({
        inDelivery: ['during initVat', 'during deliver, after a ping'],
        late: ['after initVat and a ping', 'after deliver'],
      });
    });

    it('still rejects a ping the worker answers with an error', async () => {
      const { vat, stream } = await makeVat();
      const pinging = vat.ping();
      pinging.catch(() => undefined);
      await delay(10);

      await stream.receiveInput({
        id: 'v0:1',
        error: { code: -32603, message: 'worker blew up' },
        jsonrpc: '2.0',
      });

      await expect(pinging).rejects.toMatchObject({
        message: 'worker blew up',
      });
    });
  });

  describe('terminate', () => {
    it('terminates the vat and rejects unresolved messages', async () => {
      const { vat, stream } = await makeVat();
      // terminate will remove the vat from the subcluster
      // so we need to add the vat to a subcluster
      mockKernelStore.addSubcluster({ bootstrap: 'test', vats: {} });
      mockKernelStore.addSubclusterVat(
        asSubclusterId('s1'),
        'test',
        asVatId('v0'),
      );

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

    it.each([
      ['for a restart', false],
      ['for good', true],
    ])(
      'drops a late syscall still waiting when its worker is let go %s',
      async (_why, terminating) => {
        const applied = vi.spyOn(VatSyscall.prototype, 'handleSyscall');
        const enqueueInbox = vi
          .fn<KernelQueue['enqueueInbox']>()
          .mockResolvedValue(undefined);
        mockKernelStore.setVatConfig(asVatId('v0'), { sourceSpec: 'test.js' });
        mockKernelStore.initEndpoint(asVatId('v0'));
        const { vat, stream } = await makeVat({
          kernelQueue: { enqueueInbox } as unknown as KernelQueue,
        });
        await stream.receiveInput({
          jsonrpc: '2.0',
          method: 'syscall',
          params: ['subscribe', 'p-1'],
        });
        await delay(10);

        await vat.terminate(terminating);

        expect(await enqueueInbox.mock.lastCall?.[1]()).toStrictEqual({
          value: undefined,
        });
        expect(applied).not.toHaveBeenCalled();
      },
    );

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
        vatId: asVatId('v0'),
        vatConfig: { sourceSpec: 'not-really-there.js' },
        // `end` never settles until released, so a rejection that arrives
        // before then is one that did not wait for the channel to close.
        vatStream: {
          drain: inner.drain.bind(inner),
          write: inner.write.bind(inner),
          end: async () => stalling,
        } as unknown as typeof inner,
        onStreamFailure: () => undefined,
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
      // oxlint-disable-next-line promise/catch-or-return
      vat
        .sendVatCommand({ method: 'ping' as const, params: [] })
        .then(settled, settled);

      await vat.terminate(false);
      await delay(10);

      expect(settled).not.toHaveBeenCalled();
    });
  });
});
