import { delay } from '@metamask/kernel-utils';
import { describe, it, expect, vi } from 'vitest';

import type { Kernel } from './Kernel.ts';
import { makeKernelStore } from './store/index.ts';
import type { KRef } from './types.ts';
import { asVatId } from '../test/branded.ts';
import { explosion, setUpRealKernel, watch } from '../test/real-kernel.ts';
import type { RealKernel } from '../test/real-kernel.ts';

describe('a control operation on a real kernel', () => {
  it.each(['clearStorage', 'reset', 'terminateAllVats'] as const)(
    'runs %s ahead of the crank queued behind the one it waited for, and keeps what it wrote',
    async (method) => {
      const harness = await setUpRealKernel();
      await harness.stall();
      const settlement = watch(harness.kernel[method]());
      harness.kernel
        .queueMessage(harness.doomedRoot, 'stall', [])
        .catch(() => undefined);
      await delay(0);
      harness.release({ didDelivery: harness.waiterId });
      await vi.waitFor(() =>
        expect(
          settlement() !== 'pending' || harness.received.includes('v2:stall'),
        ).toBe(true),
      );
      const secondDelivered = harness.received.includes('v2:stall');
      if (secondDelivered) {
        // Reached only if the operation ran inside this crank: killing the
        // crank then shows its write lost.
        harness.release(explosion(harness.doomedId));
      }
      await vi.waitFor(() => expect(settlement()).not.toBe('pending'));

      expect({
        secondDelivered,
        settled: settlement(),
        persisted: makeKernelStore(harness.kernelDatabase).getVatIDs(),
      }).toStrictEqual({
        secondDelivered: false,
        settled: 'fulfilled',
        persisted: [],
      });
    },
  );

  it('terminateAllVats waits out the crank in flight, then the run loop runs on', async () => {
    const harness = await setUpRealKernel();
    await harness.stall();
    const terminating = harness.kernel.terminateAllVats();
    await delay(0);
    const terminatedDuringCrank = [...harness.terminated];

    harness.release({ didDelivery: harness.waiterId });
    await terminating;
    const { doomed } = await harness.launch();
    const answer = await harness.kernel.queueMessage(
      doomed as KRef,
      'answer',
      [],
    );

    expect({
      terminatedDuringCrank,
      terminated: harness.terminated,
      answer: answer.body,
      runLoop: (await harness.kernel.getStatus()).runLoop.state,
    }).toStrictEqual({
      terminatedDuringCrank: [],
      terminated: ['v2', 'v1'],
      answer: '#"answer"',
      runLoop: 'running',
    });
  });

  it.each([
    {
      request: 'message',
      make: async (kernel: Kernel, root: KRef): Promise<unknown> =>
        kernel.queueMessage(root, 'late', []),
    },
    {
      request: 'termination',
      make: async (kernel: Kernel): Promise<unknown> =>
        kernel.terminateVat(asVatId('v1')),
    },
  ])(
    'abandons a $request asked for while the reset awaits a worker',
    async ({ make }) => {
      const harness = await setUpRealKernel();
      let late: (() => string) | undefined;
      harness.onTerminate(() => {
        late ??= watch(make(harness.kernel, harness.waiterRoot));
      });

      await harness.kernel.reset();
      harness.onTerminate(() => undefined);
      await delay(0);
      const lateSettlement = late?.();
      await harness.launch();
      await vi.waitFor(async () =>
        expect((await harness.kernel.getStatus()).vats).toHaveLength(2),
      );
      const status = await harness.kernel.getStatus();

      expect({
        late: lateSettlement,
        vats: status.vats.map(({ id }) => id),
        runLoop: status.runLoop.state,
      }).toStrictEqual({
        late: 'Kernel was reset; queued work was abandoned',
        vats: ['v1', 'v2'],
        runLoop: 'running',
      });
    },
  );

  it.each([
    {
      method: 'clearStorage' as const,
      fail: ({ kernelDatabase }: RealKernel): void => {
        const clear = kernelDatabase.clear.bind(kernelDatabase);
        vi.spyOn(kernelDatabase, 'clear').mockImplementationOnce(() => {
          clear();
          throw new Error('SQLITE_FULL');
        });
      },
    },
    ...(['reset', 'terminateAllVats'] as const).map((method) => ({
      method,
      // Armed once the first vat is retired, so its retirement is what the
      // rollback has to undo.
      fail: ({ kernelDatabase, onTerminate }: RealKernel): void => {
        onTerminate(() => {
          onTerminate(() => undefined);
          vi.spyOn(
            kernelDatabase.kernelKVStore,
            'delete',
          ).mockImplementationOnce(() => {
            throw new Error('SQLITE_FULL');
          });
        });
      },
    })),
  ])(
    'rolls back what $method wrote when it fails partway, and kills the run loop',
    async ({ method, fail }) => {
      const harness = await setUpRealKernel();
      fail(harness);

      const settled = watch(harness.kernel[method]());
      await vi.waitFor(() =>
        expect(harness.onRunLoopFailure).toHaveBeenCalled(),
      );

      expect({
        settled: settled(),
        runLoop: (await harness.kernel.getStatus()).runLoop.state,
        reported: harness.onRunLoopFailure.mock.calls.map(
          ([failure]) => (failure as Error).message,
        ),
        persisted: makeKernelStore(harness.kernelDatabase).getVatIDs(),
      }).toStrictEqual({
        settled: 'SQLITE_FULL',
        runLoop: 'failed',
        reported: ['SQLITE_FULL'],
        persisted: ['v1', 'v2'],
      });
    },
  );

  it.each(['clearStorage', 'reset', 'terminateAllVats'] as const)(
    '%s is refused once the run loop has died, leaving the store as it was',
    async (method) => {
      const harness = await setUpRealKernel();
      await harness.stall();
      await harness.explode();

      await expect(harness.kernel[method]()).rejects.toThrow(
        `Kernel run loop died; cannot ${method}`,
      );
      expect({
        terminated: harness.terminated,
        persisted: makeKernelStore(harness.kernelDatabase).getVatIDs(),
      }).toStrictEqual({ terminated: [], persisted: ['v1', 'v2'] });
    },
  );
});

describe('stop on a real kernel', () => {
  it('tears down even when the run loop dies before it ends', async () => {
    const harness = await setUpRealKernel();
    await harness.stall();
    const stopping = watch(harness.kernel.stop());
    await delay(0);

    await harness.explode();
    await vi.waitFor(() => expect(stopping()).toBe('fulfilled'));

    const { platformServices } = harness;
    expect({
      stopRemoteComms: vi.mocked(platformServices.stopRemoteComms).mock.calls
        .length,
      terminateAll: vi.mocked(platformServices.terminateAll).mock.calls.length,
      closed: harness.close.mock.calls.length,
    }).toStrictEqual({ stopRemoteComms: 1, terminateAll: 1, closed: 1 });
  });

  it('runs a control operation asked for before it, then ends the run loop', async () => {
    const harness = await setUpRealKernel();
    harness.close.mockImplementation(() => undefined);
    await harness.stall();
    const reset = watch(harness.kernel.reset());
    const stopping = harness.kernel.stop();
    await delay(0);

    harness.release({ didDelivery: harness.waiterId });
    await stopping;

    expect({
      reset: reset(),
      runLoop: (await harness.kernel.getStatus()).runLoop.state,
      persisted: makeKernelStore(harness.kernelDatabase).getVatIDs(),
    }).toStrictEqual({ reset: 'fulfilled', runLoop: 'stopped', persisted: [] });
  });

  it.each([
    {
      loop: 'running',
      kill: async (): Promise<void> => undefined,
      refusal: 'Kernel run loop is stopping; cannot reset',
    },
    {
      loop: 'dead',
      kill: async ({ stall, explode }: RealKernel): Promise<void> => {
        await stall();
        await explode();
      },
      refusal: 'Kernel run loop died; cannot reset',
    },
  ])(
    'refuses a reset asked for once it has begun on a $loop kernel',
    async ({ kill, refusal }) => {
      const harness = await setUpRealKernel();
      harness.close.mockImplementation(() => undefined);
      await kill(harness);

      const stopping = harness.kernel.stop();
      const reset = watch(harness.kernel.reset());
      await stopping;

      expect({
        reset: reset(),
        terminated: harness.terminated,
        persisted: makeKernelStore(harness.kernelDatabase).getVatIDs(),
      }).toStrictEqual({
        reset: refusal,
        terminated: [],
        persisted: ['v1', 'v2'],
      });
    },
  );

  it.each(['clearStorage', 'reset', 'terminateAllVats'] as const)(
    'refuses %s once it has ended the run loop',
    async (method) => {
      const harness = await setUpRealKernel();
      harness.close.mockImplementation(() => undefined);
      await harness.kernel.stop();

      await expect(harness.kernel[method]()).rejects.toThrow(
        `Kernel run loop is stopped; cannot ${method}`,
      );
      expect(makeKernelStore(harness.kernelDatabase).getVatIDs()).toStrictEqual(
        ['v1', 'v2'],
      );
    },
  );

  it('records the last active time once the crank open at the stop has ended', async () => {
    const harness = await setUpRealKernel();
    harness.close.mockImplementation(() => undefined);
    await harness.stall();
    const before = Date.now();

    const stopping = harness.kernel.stop();
    await delay(0);
    harness.release({ didDelivery: harness.waiterId, abort: true });
    await stopping;

    expect(
      Number(harness.kernelDatabase.kernelKVStore.get('lastActiveTime') ?? 0),
    ).toBeGreaterThanOrEqual(before);
  });
});
