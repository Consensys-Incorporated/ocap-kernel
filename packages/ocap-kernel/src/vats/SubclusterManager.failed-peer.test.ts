import { makePromiseKit } from '@endo/promise-kit';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { describe, it, expect, vi } from 'vitest';

import { VatHandle } from './VatHandle.ts';
import { VatSyscall } from './VatSyscall.ts';
import { Kernel } from '../Kernel.ts';
import { kser } from '../liveslots/kernel-marshal.ts';
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
 * @returns The methods sent, a promise for a `stall` arriving, the release,
 * and hooks run as a source's vat launches.
 */
function fakeVats() {
  const received: string[] = [];
  const stalled = makePromiseKit<void>();
  const released = makePromiseKit<void>();
  const onLaunch = new Map<string, () => Promise<void>>();
  vi.spyOn(VatHandle, 'make').mockImplementation(
    async ({ vatId, vatConfig, kernelQueue, kernelStore }) => {
      const source = 'sourceSpec' in vatConfig ? vatConfig.sourceSpec : '';
      if (source === 'fails.js') {
        throw new Error('peer exploded');
      }
      await onLaunch.get(source)?.();
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
    onLaunch,
  };
}

describe('a subcluster with a peer vat that fails to launch', () => {
  it('is bootstrapped when a crank is open as it launches', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const vats = fakeVats();
    const platformServices = {
      launch: vi.fn().mockResolvedValue({ end: async () => undefined }),
      terminate: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformServices;
    const kernel = await Kernel.make(
      platformServices,
      await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
      { logger: new Logger({ transports: [] }) },
    );
    const { vatRootKrefs } = await kernel.launchSubcluster({
      bootstrap: 'staller',
      vats: { staller: { sourceSpec: 'staller.js' } },
    });
    // `launchSubcluster` waits out any open crank before it launches, so open
    // one as the boot vat launches, and keep it open until the launch has asked
    // for its bootstrap write.
    vats.onLaunch.set('boot.js', async () => {
      kernel
        .queueMessage(vatRootKrefs.staller as KRef, 'stall', [])
        .catch(() => undefined);
      await vats.stalled;
      delay(20)
        .then(vats.release)
        .catch(() => undefined);
    });

    await expect(
      kernel.launchSubcluster({
        bootstrap: 'boot',
        vats: {
          boot: { sourceSpec: 'boot.js' },
          peer: { sourceSpec: 'fails.js' },
        },
      }),
    ).rejects.toThrow('(peer)');
    expect(vats.received).toStrictEqual(['bootstrap', 'stall', 'bootstrap']);
  });
});
