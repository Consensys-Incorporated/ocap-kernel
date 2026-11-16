import type { CapData } from '@endo/marshal';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { Logger } from '@metamask/logger';
import { describe, it, expect, vi } from 'vitest';

import { VatHandle } from './VatHandle.ts';
import { VatSyscall } from './VatSyscall.ts';
import { Kernel } from '../Kernel.ts';
import { kser } from '../liveslots/kernel-marshal.ts';
import { makeKernelStore } from '../store/index.ts';
import type {
  CrankResult,
  EndpointMessage,
  PlatformServices,
} from '../types.ts';

/**
 * Launch a one-vat subcluster whose boot vat fulfils `bootstrap` with the
 * given CapData, and report how the launch ended and what the kernel still
 * holds afterwards.
 *
 * @param answer - What the boot vat resolves the bootstrap result to, in the
 * vat's own refs.
 * @returns The launch's outcome and the held results left behind.
 */
async function launchWithBootstrapAnswer(answer: CapData<string>) {
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(VatHandle, 'make').mockImplementation(
    async ({ vatId, vatConfig, kernelQueue, kernelStore }) => {
      const vatSyscall = new VatSyscall({ vatId, kernelQueue, kernelStore });
      const deliverMessage = async (
        _target: string,
        message: EndpointMessage,
      ): Promise<CrankResult> => {
        if (message.result) {
          vatSyscall.handleSyscall([
            'resolve',
            [[message.result, false, answer]],
          ]);
        }
        return { didDelivery: vatId };
      };
      return {
        vatId,
        config: vatConfig,
        deliverMessage,
        terminate: async () => undefined,
      } as unknown as VatHandle;
    },
  );
  const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernel = await Kernel.make(
    {
      launch: vi.fn().mockResolvedValue({ end: async () => undefined }),
      terminate: vi.fn().mockResolvedValue(undefined),
      terminateAll: vi.fn().mockResolvedValue(undefined),
      stopRemoteComms: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformServices,
    kdb,
    { logger: new Logger({ transports: [] }) },
  );
  const outcome = await kernel
    .launchSubcluster({
      bootstrap: 'boot',
      vats: { boot: { sourceSpec: 'boot.js' } },
    })
    .then(
      (result) => ({ threw: undefined, kpid: result.bootstrapResult?.kpid }),
      (error: Error) => ({ threw: error.message, kpid: undefined }),
    );
  const held = makeKernelStore(kdb).getHeldResults();
  await kernel.stop();
  return { ...outcome, held };
}

describe('repro: a bootstrap that fulfils with an Error (bugbot, #1285)', () => {
  it('leaves nothing held when the Error is one marshal produced', async () => {
    const answer = kser(new Error('boot refused')) as CapData<string>;

    expect({
      slots: answer.slots,
      ...(await launchWithBootstrapAnswer(answer)),
    }).toStrictEqual({
      slots: [],
      threw: 'boot refused',
      kpid: undefined,
      held: [],
    });
  });

  it('leaves the result held when the Error CapData names a slot', async () => {
    // Not something `kser` emits for an Error: a slot the body does not use,
    // as a vat worker that writes its own syscalls could send.
    const answer = {
      body: kser(new Error('boot refused')).body,
      slots: ['o+1'],
    };

    expect(await launchWithBootstrapAnswer(answer)).toStrictEqual({
      threw: 'boot refused',
      kpid: undefined,
      held: [expect.stringMatching(/^kp\d+$/u)],
    });
  });
});
