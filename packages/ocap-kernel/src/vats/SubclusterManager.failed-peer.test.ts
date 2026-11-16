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
 * launch; `slow.js` starts, and `fails-late.js` fails, once `releaseSlow` is
 * called.
 *
 * @returns The methods sent, a promise for a `stall` arriving, the releases,
 * and a way to break a started vat's channel.
 */
function fakeVats() {
  const received: string[] = [];
  const stalled = makePromiseKit<void>();
  const released = makePromiseKit<void>();
  const slow = makePromiseKit<void>();
  const channelFailures = new Map<string, (error: Error) => void>();
  vi.spyOn(VatHandle, 'make').mockImplementation(
    async ({ vatId, vatConfig, kernelQueue, kernelStore, onStreamFailure }) => {
      const source = 'sourceSpec' in vatConfig ? vatConfig.sourceSpec : '';
      if (source === 'slow.js' || source === 'fails-late.js') {
        await slow.promise;
      }
      if (source?.startsWith('fails')) {
        throw new Error('peer exploded');
      }
      channelFailures.set(vatId, onStreamFailure);
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
    releaseSlow: slow.resolve,
    breakChannel: (vatId: string) =>
      channelFailures.get(vatId)?.(new Error('worker crashed')),
  };
}

/**
 * Make a kernel on a real store over fake vats, whose platform records the
 * workers it is asked to stop.
 *
 * @returns The kernel, the vats, and a function that reads what the tests
 * check.
 */
async function makeKernel() {
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
  const state = () => ({
    received: vats.received,
    workersStopped: vi
      .mocked(platformServices.terminate)
      .mock.calls.map(([vatId]) => vatId),
    vats: kernel.getVatIds(),
    subclusters: makeKernelStore(kernelDatabase)
      .getSubclusters()
      .map(({ id, vats: members }) => [id, Object.keys(members)]),
  });
  return { kernel, vats, state };
}

describe('a subcluster with a peer vat that fails to launch', () => {
  it('is rolled back whole before its bootstrap, once the open crank ends', async () => {
    const { kernel, vats, state } = await makeKernel();
    const { vatRootKrefs } = await kernel.launchSubcluster({
      bootstrap: 'staller',
      vats: { staller: { sourceSpec: 'staller.js' } },
    });
    // Holds a crank open, so the launch below waits for one of its own.
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
    // The rollback keeps the ids it gave out.
    await kernel.launchSubcluster({
      bootstrap: 'again',
      vats: { again: { sourceSpec: 'again.js' } },
    });
    expect(state()).toStrictEqual({
      received: ['bootstrap', 'stall', 'bootstrap'],
      workersStopped: ['v3', 'v2'],
      vats: ['v1', 'v4'],
      subclusters: [
        ['s1', ['staller']],
        ['s3', ['again']],
      ],
    });
  });

  it('stops a vat still starting when its peer fails', async () => {
    const { kernel, vats, state } = await makeKernel();
    const launching = kernel.launchSubcluster({
      bootstrap: 'slow',
      vats: {
        slow: { sourceSpec: 'slow.js' },
        peer: { sourceSpec: 'fails.js' },
      },
    });
    launching.catch(() => undefined);
    await delay(10);
    vats.releaseSlow();

    await expect(launching).rejects.toThrow('(peer)');
    expect(state()).toStrictEqual({
      received: [],
      workersStopped: ['v2', 'v1'],
      vats: [],
      subclusters: [],
    });
  });

  it('gives none of its vat ids to a launch asked for during it, and stops a member that lost its channel', async () => {
    const { kernel, vats, state } = await makeKernel();
    const launching = kernel.launchSubcluster({
      bootstrap: 'lost',
      vats: {
        lost: { sourceSpec: 'lost.js' },
        peer: { sourceSpec: 'fails-late.js' },
      },
    });
    launching.catch(() => undefined);
    await delay(10);
    const next = kernel.launchSubcluster({
      bootstrap: 'next',
      vats: { next: { sourceSpec: 'next.js' } },
    });
    // Queues the lost vat's termination behind the next launch.
    vats.breakChannel('v1');
    vats.releaseSlow();

    await expect(launching).rejects.toThrow('(peer)');
    await next;
    await delay(10);
    expect(state()).toStrictEqual({
      received: ['bootstrap'],
      workersStopped: ['v2', 'v1'],
      vats: ['v3'],
      subclusters: [['s2', ['next']]],
    });
  });
});
