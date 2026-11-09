import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { TestDuplexStream } from '@ocap/repo-tools/test-utils/streams';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, onTestFinished, vi } from 'vitest';

import { Kernel } from './Kernel.ts';
import { kser } from './liveslots/kernel-marshal.ts';
import type { PlatformServices } from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { VatSyscall } from './vats/VatSyscall.ts';
import { asVatId } from '../test/branded.ts';
import { setUpRealKernel, watch } from '../test/real-kernel.ts';

// Whole cranks: a store fault stops the kernel and rolls its crank back.

const DEAD_RESULT =
  'Kernel run loop died; this message result will never be delivered';
const DEAD_WORK = 'Kernel run loop died before this work was done';

/**
 * Fail the kernel's writes that `matches` picks, as a full disk does.
 *
 * @param kernelDatabase - The kernel's database.
 * @param matches - Which writes fail.
 * @returns The error they fail with.
 */
function failWrites(
  kernelDatabase: KernelDatabase,
  matches: (key: string, value: string) => boolean,
): Error {
  const fault = new Error('database or disk is full');
  const { kernelKVStore } = kernelDatabase;
  const set = kernelKVStore.set.bind(kernelKVStore);
  vi.spyOn(kernelKVStore, 'set').mockImplementation((key, value) => {
    if (matches(key, value)) {
      throw fault;
    }
    set(key, value);
  });
  return fault;
}

function runQueueLength(kernelDatabase: KernelDatabase): number {
  const { get } = kernelDatabase.kernelKVStore;
  return Number(get('queue.run.head')) - Number(get('queue.run.tail'));
}

async function waitForDeath(kernel: {
  getStatus: () => Promise<{ runLoop: { state: string } }>;
}): Promise<void> {
  await vi.waitFor(async () =>
    expect((await kernel.getStatus()).runLoop.state).toBe('failed'),
  );
  // Flushes the callers' settlements; not a timeout.
  await delay(0);
}

describe('a store fault', () => {
  it("in a syscall's write stops the kernel and leaves the vat as it was", async () => {
    const { kernel, kernelDatabase, doomedRoot, terminated } =
      await setUpRealKernel();
    const fault = failWrites(
      kernelDatabase,
      (key, value) => /^kp\d+\.state$/u.test(key) && value !== 'unresolved',
    );
    const settlement = watch(kernel.queueMessage(doomedRoot, 'answer', []));

    await waitForDeath(kernel);

    expect({
      runLoop: (await kernel.getStatus()).runLoop,
      settlement: settlement(),
      terminated,
      queued: runQueueLength(kernelDatabase),
    }).toStrictEqual({
      runLoop: {
        state: 'failed',
        error: 'Kernel panic: syscall resolve from vat v2 failed',
        detail: expect.stringContaining(fault.message),
      },
      settlement: DEAD_RESULT,
      terminated: [],
      queued: 1,
    });
  });

  it("writing a vat's state stops the kernel rather than fail the message", async () => {
    const { kernel, kernelDatabase, waiterRoot, terminated } =
      await setUpRealKernel();
    const fault = new Error('database or disk is full');
    vi.spyOn(kernelDatabase, 'makeVatStore').mockReturnValue({
      getKVData: () => [],
      updateKVData: () => {
        throw fault;
      },
    });
    const settlement = watch(kernel.queueMessage(waiterRoot, 'remember', []));

    await waitForDeath(kernel);

    expect({
      runLoop: (await kernel.getStatus()).runLoop,
      settlement: settlement(),
      terminated,
      queued: runQueueLength(kernelDatabase),
    }).toStrictEqual({
      runLoop: {
        state: 'failed',
        error: fault.message,
        detail: expect.any(String),
      },
      settlement: DEAD_RESULT,
      terminated: [],
      queued: 1,
    });
  });

  it('in a termination stops the kernel and leaves the termination queued', async () => {
    const { kernel, kernelDatabase, doomedId, terminated } =
      await setUpRealKernel();
    const fault = failWrites(
      kernelDatabase,
      (key) => key === 'vats.terminated',
    );
    const settlement = watch(kernel.terminateVat(doomedId));

    await waitForDeath(kernel);

    expect({
      runLoop: (await kernel.getStatus()).runLoop,
      settlement: settlement(),
      // Stopped before the failure is rethrown; the next start relaunches it.
      terminated,
      recorded: kernelDatabase.kernelKVStore.get('vats.terminated'),
      queued: runQueueLength(kernelDatabase),
    }).toStrictEqual({
      runLoop: {
        state: 'failed',
        error: fault.message,
        detail: expect.any(String),
      },
      settlement: DEAD_WORK,
      terminated: ['v2'],
      recorded: '[]',
      queued: 1,
    });
  });

  it.each([
    {
      other: 'starts',
      refusal: 'Kernel panicked; cannot start',
    },
    {
      other: 'fails to start',
      refusal: 'Kernel panicked; cannot retire a vat that would not start',
    },
  ])(
    'in a syscall while a vat starts at boot fails Kernel.make, writing nothing after it, when the other vat $other',
    async ({ other, refusal }) => {
      const dir = await mkdtemp(join(tmpdir(), 'panic-boot-'));
      onTestFinished(async () => rm(dir, { recursive: true, force: true }));
      const dbFilename = join(dir, 'store.db');
      const first = await setUpRealKernel({ dbFilename });
      await first.kernel.stop();
      vi.restoreAllMocks();

      const kernelDatabase = await makeSQLKernelDatabase({ dbFilename });
      failWrites(kernelDatabase, (key) => key.startsWith('v1.c.p+'));
      vi.spyOn(VatHandle, 'make').mockImplementation(
        async ({ vatId, vatConfig, kernelQueue, kernelStore }) => {
          if (vatId === 'v1') {
            // As its `initVat` sending a message, which a worker does not
            // wait on.
            new VatSyscall({ vatId, kernelQueue, kernelStore }).handleSyscall([
              'send',
              'o+0',
              { methargs: kser(['hello', []]), result: 'p+5' },
            ]);
          } else if (other === 'fails to start') {
            await delay(0);
            throw new Error('bundle not found');
          }
          return {
            vatId,
            config: vatConfig,
            terminate: async () => undefined,
            expectClose: () => undefined,
          } as unknown as VatHandle;
        },
      );
      const platformServices = {
        launch: vi.fn(async () =>
          TestDuplexStream.make<JsonRpcMessage, JsonRpcMessage>(
            () => undefined,
          ),
        ),
        terminate: vi.fn().mockResolvedValue(undefined),
        terminateAll: vi.fn().mockResolvedValue(undefined),
        stopRemoteComms: vi.fn().mockResolvedValue(undefined),
      } as unknown as PlatformServices;

      const failure = await Kernel.make(platformServices, kernelDatabase, {
        logger: new Logger({ transports: [] }),
      }).catch((error: Error) => error);

      expect({
        failure: (failure as Error).message,
        cause: ((failure as Error).cause as Error).message,
        workersStopped: vi.mocked(platformServices.terminateAll).mock.calls
          .length,
        terminated: kernelDatabase.kernelKVStore.get('vats.terminated'),
      }).toStrictEqual({
        failure: refusal,
        cause: 'Kernel panic: syscall send from vat v1 failed',
        workersStopped: 1,
        terminated: '[]',
      });
    },
  );

  it('in a syscall while a vat launches leaves that vat unrecorded', async () => {
    const { kernel, kernelDatabase, launch } = await setUpRealKernel();
    failWrites(kernelDatabase, (key) => key.startsWith('v1.c.p+'));
    const makeHandle = vi.mocked(VatHandle.make);
    const makeFakeHandle = makeHandle.getMockImplementation();
    if (!makeFakeHandle) {
      throw new Error('VatHandle.make is not faked');
    }
    makeHandle.mockImplementation(async (params) => {
      if (params.vatId === 'v3') {
        // As v1 making a syscall outside any delivery while v3 starts.
        new VatSyscall({
          vatId: asVatId('v1'),
          kernelQueue: params.kernelQueue,
          kernelStore: params.kernelStore,
        }).handleSyscall([
          'send',
          'o+0',
          { methargs: kser(['late', []]), result: 'p+5' },
        ]);
      }
      return makeFakeHandle(params);
    });

    const launching = launch();
    await expect(launching).rejects.toBeInstanceOf(Error);
    await waitForDeath(kernel);

    expect({
      runLoop: (await kernel.getStatus()).runLoop,
      recorded: kernelDatabase.kernelKVStore.get('vatConfig.v3'),
    }).toStrictEqual({
      runLoop: {
        state: 'failed',
        error: 'Kernel panic: syscall send from vat v1 failed',
        detail: expect.any(String),
      },
      recorded: undefined,
    });
  });
});
