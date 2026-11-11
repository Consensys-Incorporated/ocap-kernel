import { makePromiseKit } from '@endo/promise-kit';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
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
  KRef,
  PlatformServices,
} from '../types.ts';

/**
 * Stand in for every vat's handle, since no real vat can hold a crank open: a
 * vat records the methods it is sent and answers each with `'ready'`, except
 * that it holds a `stall` until `release` is called. A `fails.js` vat fails to
 * launch.
 *
 * @returns The methods sent, a promise for a `stall` arriving, and the
 * release.
 */
function fakeVats() {
  const received: string[] = [];
  const stalled = makePromiseKit<void>();
  const released = makePromiseKit<void>();
  vi.spyOn(VatHandle, 'make').mockImplementation(
    async ({ vatId, vatConfig, kernelQueue, kernelStore }) => {
      const source = 'sourceSpec' in vatConfig ? vatConfig.sourceSpec : '';
      if (source === 'fails.js') {
        throw new Error('peer exploded');
      }
      const vatSyscall = new VatSyscall({ vatId, kernelQueue, kernelStore });
      const deliverMessage = async (
        _target: string,
        message: EndpointMessage,
      ): Promise<CrankResult> => {
        const [method] = JSON.parse(message.methargs.body.slice(1));
        received.push(method);
        if (method === 'stall') {
          stalled.resolve();
          await released.promise;
        }
        if (message.result) {
          vatSyscall.handleSyscall([
            'resolve',
            [[message.result, false, kser('ready')]],
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
  return {
    received,
    stalled: stalled.promise,
    release: released.resolve,
  };
}

describe('a subcluster with a peer vat that fails to launch', () => {
  it('is rolled back whole before its bootstrap, once the open crank ends', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const vats = fakeVats();
    const platformServices = {
      launch: vi.fn().mockResolvedValue({ end: async () => undefined }),
      terminate: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformServices;
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const kernel = await Kernel.make(platformServices, kernelDatabase, {
      logger: new Logger({ transports: [] }),
    });
    const { vatRootKrefs } = await kernel.launchSubcluster({
      bootstrap: 'staller',
      vats: { staller: { sourceSpec: 'staller.js' } },
    });
    // Asked for while a crank is open, so the launch waits for a crank of its
    // own.
    kernel
      .queueMessage(vatRootKrefs.staller as KRef, 'stall', [])
      .catch(() => undefined);
    await vats.stalled;
    const launching = kernel.launchSubcluster({
      bootstrap: 'boot',
      vats: {
        boot: { sourceSpec: 'boot.js' },
        peer: { sourceSpec: 'fails.js' },
      },
    });
    launching.catch(() => undefined);
    await delay(0);
    vats.release();

    await expect(launching).rejects.toThrow('(peer)');
    // The rollback gave the vat ids back.
    await kernel.launchSubcluster({
      bootstrap: 'again',
      vats: { again: { sourceSpec: 'again.js' } },
    });
    expect({
      received: vats.received,
      workersStopped: vi
        .mocked(platformServices.terminate)
        .mock.calls.map(([vatId]) => vatId),
      vats: kernel.getVatIds(),
      subclusters: makeKernelStore(kernelDatabase)
        .getSubclusters()
        .map(({ id, vats: members }) => [id, Object.keys(members)]),
    }).toStrictEqual({
      received: ['bootstrap', 'stall', 'bootstrap'],
      workersStopped: ['v3', 'v2'],
      vats: ['v1', 'v2'],
      subclusters: [
        ['s1', ['staller']],
        ['s2', ['again']],
      ],
    });
  });
});
