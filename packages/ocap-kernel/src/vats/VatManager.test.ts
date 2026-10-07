import type { CapData } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import {
  VatAlreadyExistsError,
  VatDeletedError,
  VatNotFoundError,
} from '@metamask/kernel-errors';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import { delay } from '@ocap/repo-tools/test-utils';
import type { Mocked, MockInstance } from 'vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { KernelQueue } from '../KernelQueue.ts';
import { makeFatalKernelError } from '../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../store/index.ts';
import type { KRef, VatId, VatConfig, PlatformServices } from '../types.ts';
import { VatHandle } from './VatHandle.ts';
import { VatManager } from './VatManager.ts';

describe('VatManager', () => {
  let mockPlatformServices: Mocked<PlatformServices>;
  let mockKernelStore: Mocked<KernelStore>;
  let mockKernelQueue: Mocked<KernelQueue>;
  let mockLogger: Logger;
  let vatManager: VatManager;
  let makeVatHandleMock: MockInstance;
  let vatHandles: Mocked<VatHandle>[];

  const createMockVatConfig = (name = 'test'): VatConfig => ({
    sourceSpec: `${name}.js`,
  });

  const createMockVatHandle = (
    vatId: VatId,
    config: VatConfig,
  ): Mocked<VatHandle> => {
    const handle = {
      vatId,
      config,
      terminate: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ pong: true }),
    } as unknown as Mocked<VatHandle>;
    vatHandles.push(handle);
    return handle;
  };

  /**
   * Carry out a queued restart as the run loop would: retire the vat if the
   * crank says to, otherwise run what follows its commit.
   *
   * @param vatId - The vat to restart.
   */
  const runRestartCrank = async (vatId: VatId): Promise<void> => {
    const crankResult = await vatManager.performVatRestart(vatId);
    if (crankResult?.terminate) {
      await vatManager.stopVat(vatId, true, crankResult.terminate.info);
    } else if (!crankResult?.abort) {
      await crankResult?.afterCommit?.();
    }
  };

  /**
   * Leave the next restart request on the queue, for the test to carry out by
   * hand.
   */
  const leaveRequestQueued = (): void => {
    mockKernelQueue.enqueueRestartVat.mockImplementationOnce(() => undefined);
  };

  beforeEach(() => {
    vatHandles = [];

    mockPlatformServices = {
      launch: vi.fn().mockResolvedValue({
        end: vi.fn().mockResolvedValue(undefined),
      } as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>),
      terminate: vi.fn().mockResolvedValue(undefined),
      terminateAll: vi.fn().mockResolvedValue(undefined),
    } as unknown as Mocked<PlatformServices>;

    mockKernelStore = {
      getNextVatId: vi
        .fn()
        .mockReturnValueOnce('v1')
        .mockReturnValueOnce('v2')
        .mockReturnValueOnce('v3'),
      initEndpoint: vi.fn(),
      exportFromEndpoint: vi.fn().mockReturnValue('ko1'),
      setVatConfig: vi.fn(),
      addSubclusterVat: vi.fn(),
      getAllVatRecords: vi.fn().mockReturnValue(
        (function* () {
          // Empty generator
        })(),
      ),
      getVatSubcluster: vi.fn().mockReturnValue('s1'),
      getVatConfig: vi.fn(() => ({ sourceSpec: 'test.js' })),
      isVatActive: vi.fn().mockReturnValue(true),
      isVatTerminated: vi.fn().mockReturnValue(false),
      markVatAsTerminated: vi.fn(),
      deleteVat: vi.fn(),
      getPromisesByDecider: vi.fn().mockReturnValue([]),
      getRootObject: vi.fn().mockReturnValue('ko1'),
      pinObject: vi.fn(),
      unpinObject: vi.fn(),
      scheduleReap: vi.fn(),
      nextTerminatedVatCleanup: vi.fn().mockReturnValue(false),
      collectGarbage: vi.fn(),
    } as unknown as Mocked<KernelStore>;

    mockKernelQueue = {
      waitForCrank: vi.fn().mockResolvedValue(undefined),
      resolvePromises: vi.fn(),
      // Stands in for the run loop taking the item in a crank of its own.
      enqueueRestartVat: vi.fn((vatId: VatId) => {
        queueMicrotask(() => {
          runRestartCrank(vatId).catch((error: unknown) => {
            // Rethrown, as the run loop rethrows what kills it.
            throw error;
          });
        });
      }),
      enqueueTerminateVat: vi.fn((vatId: VatId, reason?: CapData<KRef>) => {
        queueMicrotask(() => {
          vatManager
            .performVatTermination(vatId, reason)
            .catch((error: unknown) => {
              throw error;
            });
        });
      }),
      onRunLoopDeath: vi.fn(() => () => undefined),
      assertRunLoopAlive: vi.fn(),
      discardHeldRequests: vi.fn(),
    } as unknown as Mocked<KernelQueue>;

    mockLogger = new Logger('test');

    makeVatHandleMock = vi
      .spyOn(VatHandle, 'make')
      .mockImplementation(async ({ vatId, vatConfig }) => {
        return createMockVatHandle(vatId, vatConfig);
      });

    vatManager = new VatManager({
      platformServices: mockPlatformServices,
      kernelStore: mockKernelStore,
      kernelQueue: mockKernelQueue,
      logger: mockLogger,
    });
  });

  describe('constructor', () => {
    it('initializes with provided options', () => {
      expect(vatManager).toBeDefined();
      expect(vatManager.getVatIds()).toStrictEqual([]);
    });

    it('uses default logger if not provided', () => {
      const manager = new VatManager({
        platformServices: mockPlatformServices,
        kernelStore: mockKernelStore,
        kernelQueue: mockKernelQueue,
      });
      expect(manager).toBeDefined();
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    'refuses a relaunch timeout of %s ms',
    (vatRelaunchTimeoutMs) => {
      expect(
        () =>
          new VatManager({
            platformServices: mockPlatformServices,
            kernelStore: mockKernelStore,
            kernelQueue: mockKernelQueue,
            vatRelaunchTimeoutMs,
          }),
      ).toThrow(RangeError);
    },
  );

  describe('initializeAllVats', () => {
    it('initializes all vats from storage', async () => {
      const vatRecords = [
        { vatID: 'v1' as VatId, vatConfig: createMockVatConfig('vat1') },
        { vatID: 'v2' as VatId, vatConfig: createMockVatConfig('vat2') },
      ];

      function* mockGenerator() {
        yield* vatRecords;
      }
      mockKernelStore.getAllVatRecords.mockReturnValue(mockGenerator());

      await vatManager.initializeAllVats();

      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(2);
      expect(makeVatHandleMock).toHaveBeenCalledTimes(2);
      expect(vatManager.getVatIds()).toStrictEqual(['v1', 'v2']);
    });

    it('handles empty vat records', async () => {
      mockKernelStore.getAllVatRecords.mockReturnValue(
        (function* () {
          // Empty generator
        })(),
      );
      await vatManager.initializeAllVats();

      expect(mockPlatformServices.launch).not.toHaveBeenCalled();
      expect(vatManager.getVatIds()).toStrictEqual([]);
    });
  });

  describe('launchVat', () => {
    it('launches a new vat without subcluster', async () => {
      const config = createMockVatConfig();
      const kref = await vatManager.launchVat(config, 'test');

      expect(mockKernelStore.getNextVatId).toHaveBeenCalledOnce();
      expect(mockPlatformServices.launch).toHaveBeenCalledWith('v1', config);
      expect(mockKernelStore.initEndpoint).toHaveBeenCalledWith('v1');
      expect(mockKernelStore.exportFromEndpoint).toHaveBeenCalled();
      expect(mockKernelStore.setVatConfig).toHaveBeenCalledWith('v1', config);
      expect(mockKernelStore.addSubclusterVat).not.toHaveBeenCalled();
      expect(kref).toBe('ko1');
    });

    it('pins the root for the vat lifetime', async () => {
      // A root is addressable while its vat lives whether or not anyone
      // imports it, so without this GC retires it as the last importer lets go.
      await vatManager.launchVat(createMockVatConfig(), 'test');

      expect(mockKernelStore.pinObject).toHaveBeenCalledWith('ko1');
    });

    it('launches a new vat with subcluster', async () => {
      const config = createMockVatConfig();
      const kref = await vatManager.launchVat(config, 'test', 's1');

      expect(mockKernelStore.addSubclusterVat).toHaveBeenCalledWith(
        's1',
        'test',
        'v1',
      );
      expect(kref).toBe('ko1');
    });

    it('stops the worker when the handle never comes back', async () => {
      makeVatHandleMock.mockRejectedValueOnce(new Error('handshake timed out'));

      await expect(
        vatManager.launchVat(createMockVatConfig(), 'bob', 's1'),
      ).rejects.toThrow('Failed to launch vat v1 (bob)');

      expect(mockPlatformServices.terminate).toHaveBeenCalledWith('v1');
    });

    it('stops no worker when there was never one to stop', async () => {
      mockPlatformServices.launch.mockRejectedValueOnce(
        new Error('worker file not found'),
      );

      await expect(
        vatManager.launchVat(createMockVatConfig(), 'bob', 's1'),
      ).rejects.toThrow('Failed to launch vat v1 (bob)');

      // Both runtimes throw for an unknown worker, burying the launch failure.
      expect(mockPlatformServices.terminate).not.toHaveBeenCalled();
    });

    it('attributes a launch failure to the vat by id and config name', async () => {
      const config = createMockVatConfig();
      const cause = new Error(
        'Failed to initialize vat v1: buildRootObject threw',
      );
      makeVatHandleMock.mockRejectedValueOnce(cause);

      await expect(vatManager.launchVat(config, 'bob', 's1')).rejects.toThrow(
        'Failed to launch vat v1 (bob)',
      );

      // Downstream setup is skipped once the launch fails.
      expect(mockKernelStore.initEndpoint).not.toHaveBeenCalled();
      expect(mockKernelStore.setVatConfig).not.toHaveBeenCalled();
    });

    it('preserves the original error as the cause of a launch failure', async () => {
      const config = createMockVatConfig();
      const cause = new Error('buildRootObject threw');
      makeVatHandleMock.mockRejectedValueOnce(cause);

      const error = await vatManager
        .launchVat(config, 'bob', 's1')
        .catch((reason: unknown) => reason);

      expect((error as Error).cause).toBe(cause);
    });

    it('tears the worker down when kernel-side registration fails', async () => {
      const config = createMockVatConfig();
      const cause = new Error('initEndpoint threw');
      mockKernelStore.initEndpoint.mockImplementationOnce(() => {
        throw cause;
      });

      const error = await vatManager
        .launchVat(config, 'bob', 's1')
        .catch((reason: unknown) => reason);

      expect((error as Error).message).toBe('Failed to launch vat v1 (bob)');
      expect((error as Error).cause).toBe(cause);
      expect(mockPlatformServices.terminate).toHaveBeenCalledWith(
        'v1',
        expect.any(Error),
      );
      expect(vatHandles[0]?.terminate).toHaveBeenCalled();
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      expect(vatManager.hasVat('v1')).toBe(false);
    });

    it('reports the launch failure when the cleanup itself fails', async () => {
      const config = createMockVatConfig();
      const cause = new Error('setVatConfig threw');
      mockKernelStore.setVatConfig.mockImplementationOnce(() => {
        throw cause;
      });
      mockKernelStore.deleteVat.mockImplementationOnce(() => {
        throw new Error('deleteVat failed');
      });

      const error = await vatManager
        .launchVat(config, 'bob', 's1')
        .catch((reason: unknown) => reason);

      expect((error as Error).message).toBe(
        'Failed to launch vat v1 (bob) (cleanup also failed)',
      );
      expect((error as Error).cause).toBe(cause);
    });

    it('leaves the vat unmarked when the cleanup stops short of the mark', async () => {
      const config = createMockVatConfig();
      mockKernelStore.setVatConfig.mockImplementationOnce(() => {
        throw new Error('setVatConfig threw');
      });
      mockKernelStore.unpinObject.mockImplementationOnce(() => {
        throw new Error('unpin failed');
      });

      await expect(vatManager.launchVat(config, 'bob', 's1')).rejects.toThrow(
        'Failed to launch vat v1 (bob) (cleanup also failed)',
      );

      expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
    });
  });

  describe('runVat', () => {
    it('runs a new vat successfully', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      expect(mockPlatformServices.launch).toHaveBeenCalledWith('v1', config);
      expect(makeVatHandleMock).toHaveBeenCalledOnce();
      expect(vatManager.hasVat('v1')).toBe(true);
    });

    it('throws if vat already exists', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      await expect(vatManager.runVat('v1', config)).rejects.toThrow(
        VatAlreadyExistsError,
      );
    });

    describe('a vat whose channel fails', () => {
      const reportStreamFailure = (error: Error, launch = 0): void => {
        const { onStreamFailure } = makeVatHandleMock.mock.calls[
          launch
        ]?.[0] as {
          onStreamFailure: (error: Error) => void;
        };
        onStreamFailure(error);
      };

      it('is retired', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        mockKernelStore.getPromisesByDecider.mockReturnValueOnce(['kp1']);
        const cause = new Error('channel failed');

        reportStreamFailure(cause);
        await delay(10);

        expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('v1', [
          [
            'kp1',
            true,
            expect.objectContaining({
              body: expect.stringContaining('channel failed'),
            }),
          ],
        ]);
        expect(mockKernelStore.deleteVat).toHaveBeenCalledWith('v1');
        expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
        expect(mockPlatformServices.terminate).toHaveBeenCalledWith(
          'v1',
          cause,
        );
        expect(vatHandles[0]?.terminate).toHaveBeenCalledWith(true, cause);
        expect(vatManager.hasVat('v1')).toBe(false);
      });

      it('waits for the open crank before writing the death down', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        let releaseCrank = (): void => undefined;
        mockKernelQueue.waitForCrank.mockReturnValueOnce(
          new Promise<void>((resolve) => {
            releaseCrank = resolve;
          }),
        );

        reportStreamFailure(new Error('channel failed'));
        await delay(10);
        const writesDuringTheCrank =
          mockKernelStore.deleteVat.mock.calls.length;
        releaseCrank();
        await delay(10);

        expect(writesDuringTheCrank).toBe(0);
        expect(mockKernelStore.deleteVat).toHaveBeenCalledWith('v1');
      });

      it('is left alone when the kernel has already stopped it', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        await vatManager.stopVat('v1', true);
        const storeWrites = (): object => ({
          deleteVat: mockKernelStore.deleteVat.mock.calls.length,
          markVatAsTerminated:
            mockKernelStore.markVatAsTerminated.mock.calls.length,
          unpinObject: mockKernelStore.unpinObject.mock.calls.length,
        });
        const before = storeWrites();

        reportStreamFailure(new Error('channel failed'));
        await delay(10);

        expect(storeWrites()).toStrictEqual(before);
      });

      it('is left alone when a restart has replaced its handle', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        await vatManager.restartVat('v1');
        const deletesBefore = mockKernelStore.deleteVat.mock.calls.length;

        // The first launch's handle, reporting after the restart replaced it.
        reportStreamFailure(new Error('channel failed'));
        await delay(10);

        expect(mockKernelStore.deleteVat).toHaveBeenCalledTimes(deletesBefore);
        expect(vatManager.hasVat('v1')).toBe(true);
      });

      it('logs a retirement that fails', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        const logError = vi.spyOn(mockLogger, 'error').mockReturnValue();
        mockKernelStore.deleteVat.mockImplementationOnce(() => {
          throw new Error('deleteVat failed');
        });

        reportStreamFailure(new Error('channel failed'));
        await delay(10);

        expect(logError).toHaveBeenCalledWith(
          expect.stringContaining('terminate it to try again'),
          expect.objectContaining({ message: 'deleteVat failed' }),
        );
      });
    });
  });

  describe('stopVat', () => {
    it('stops a vat for restart', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      await vatManager.stopVat('v1', false);

      expect(mockPlatformServices.terminate).toHaveBeenCalledWith(
        'v1',
        undefined,
      );
      expect(vatHandles[0]?.terminate).toHaveBeenCalledWith(false, undefined);
      expect(vatManager.hasVat('v1')).toBe(false);
    });

    it('keeps the root pin across a restart', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      await vatManager.stopVat('v1', false);

      // The same root comes back, so releasing the pin would let GC retire it
      // in the window where the vat has no handle.
      expect(mockKernelStore.unpinObject).not.toHaveBeenCalled();
    });

    it('releases the root pin on termination', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      await vatManager.stopVat('v1', true);

      expect(mockKernelStore.unpinObject).toHaveBeenCalledWith('ko1');
    });

    it('records the whole death before touching the worker', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelStore.getPromisesByDecider.mockReturnValueOnce(['kp1']);
      const order: string[] = [];
      for (const [name, mock] of [
        ['resolvePromises', mockKernelQueue.resolvePromises],
        ['unpinObject', mockKernelStore.unpinObject],
        ['deleteVat', mockKernelStore.deleteVat],
        ['markVatAsTerminated', mockKernelStore.markVatAsTerminated],
      ] as const) {
        mock.mockImplementation((() => {
          order.push(name);
        }) as never);
      }
      mockPlatformServices.terminate.mockImplementation(async () => {
        order.push('terminateWorker');
      });

      await vatManager.stopVat('v1', true);

      expect(order).toStrictEqual([
        'resolvePromises',
        'unpinObject',
        'markVatAsTerminated',
        'deleteVat',
        'terminateWorker',
      ]);
    });

    it('records the death with no yield point in it', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelStore.getPromisesByDecider.mockReturnValueOnce(['kp1']);

      const stopping = vatManager.stopVat('v1', true);
      // Read before awaiting, to pin that no write follows a yield point.
      const writesBeforeTheFirstAwait = {
        resolvePromises: mockKernelQueue.resolvePromises.mock.calls.length,
        unpinObject: mockKernelStore.unpinObject.mock.calls.length,
        deleteVat: mockKernelStore.deleteVat.mock.calls.length,
        markVatAsTerminated:
          mockKernelStore.markVatAsTerminated.mock.calls.length,
      };
      await stopping;

      expect(writesBeforeTheFirstAwait).toStrictEqual({
        resolvePromises: 1,
        unpinObject: 1,
        deleteVat: 1,
        markVatAsTerminated: 1,
      });
    });

    it('leaves the vat unmarked when an earlier write throws', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelStore.unpinObject.mockImplementationOnce(() => {
        throw new Error('unpin failed');
      });

      await expect(vatManager.stopVat('v1', true)).rejects.toThrow(
        'unpin failed',
      );

      expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
      expect(mockPlatformServices.terminate).toHaveBeenCalled();
      expect(vatManager.hasVat('v1')).toBe(false);
    });

    it('marks the vat before the write that makes it unfindable', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelStore.deleteVat.mockImplementationOnce(() => {
        throw new Error('deleteVat failed');
      });

      await expect(vatManager.stopVat('v1', true)).rejects.toThrow(
        'deleteVat failed',
      );

      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });

    it('finishes a retirement its first attempt stopped part-way', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelStore.getPromisesByDecider.mockReturnValue(['kp1']);
      mockKernelStore.deleteVat.mockImplementationOnce(() => {
        throw new Error('deleteVat failed');
      });
      await expect(vatManager.stopVat('v1', true)).rejects.toThrow(
        'deleteVat failed',
      );
      mockKernelStore.isVatTerminated.mockReturnValue(true);

      await vatManager.stopVat('v1', true);

      expect(mockKernelStore.deleteVat).toHaveBeenCalledTimes(2);
      expect(mockKernelStore.unpinObject).toHaveBeenCalledTimes(1);
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledTimes(1);
    });

    it('reports the store failure rather than the channel failure', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelStore.deleteVat.mockImplementationOnce(() => {
        throw new Error('deleteVat failed');
      });
      vatHandles[0]?.terminate.mockRejectedValueOnce(
        new Error('stream will not end'),
      );

      await expect(vatManager.stopVat('v1', true)).rejects.toThrow(
        'deleteVat failed',
      );
    });

    it('keeps the records across a restart', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      await vatManager.stopVat('v1', false);

      expect(mockKernelStore.deleteVat).not.toHaveBeenCalled();
      expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
    });

    it('does not wait for the channel to close', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      vatHandles[0]?.terminate.mockReturnValueOnce(
        new Promise(() => undefined),
      );

      await vatManager.stopVat('v1', true);

      expect(mockKernelStore.deleteVat).toHaveBeenCalledWith('v1');
    });

    it('logs a channel that will not close', async () => {
      const logError = vi.spyOn(mockLogger, 'error');
      await vatManager.runVat('v1', createMockVatConfig());
      const failure = new Error('stream will not end');
      vatHandles[0]?.terminate.mockRejectedValueOnce(failure);

      await vatManager.stopVat('v1', true);
      await delay();

      expect(logError).toHaveBeenCalledWith(
        'Channel to vat v1 would not close:',
        failure,
      );
    });

    it('forgets the vat when unpinning the root throws', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelStore.unpinObject.mockImplementationOnce(() => {
        throw new Error('unpin failed');
      });

      await expect(vatManager.stopVat('v1', true)).rejects.toThrow(
        'unpin failed',
      );

      expect(vatManager.hasVat('v1')).toBe(false);
      expect(vatManager.getVatIds()).toStrictEqual([]);
    });

    it('stops a vat for termination with reason', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);
      const reason = { body: 'Test termination', slots: [] };

      await vatManager.stopVat('v1', true, reason);

      expect(mockPlatformServices.terminate).toHaveBeenCalledWith(
        'v1',
        expect.objectContaining({
          message: 'Vat termination: Test termination',
        }),
      );
      expect(vatHandles[0]?.terminate).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          message: 'Vat termination: Test termination',
        }),
      );
    });

    it('stops a vat for termination without reason', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      await vatManager.stopVat('v1', true);

      expect(mockPlatformServices.terminate).toHaveBeenCalledWith(
        'v1',
        expect.any(VatDeletedError),
      );
      expect(vatHandles[0]?.terminate).toHaveBeenCalledWith(
        true,
        expect.any(VatDeletedError),
      );
    });

    it('throws if vat not found', async () => {
      await expect(vatManager.stopVat('v1', false)).rejects.toThrow(
        VatNotFoundError,
      );
    });

    it('terminates a vat whose worker will not stop', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockPlatformServices.terminate.mockRejectedValueOnce(
        new Error('Platform error'),
      );

      await vatManager.stopVat('v1', true);

      expect(vatHandles[0]?.terminate).toHaveBeenCalled();
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });

    it('stops a restarting vat whose worker will not stop', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockPlatformServices.terminate.mockRejectedValueOnce(
        new Error('Platform error'),
      );

      await vatManager.stopVat('v1', false);

      expect(vatHandles[0]?.terminate).toHaveBeenCalled();
      expect(vatManager.hasVat('v1')).toBe(false);
    });
  });

  describe('terminateVat', () => {
    it('terminates a vat successfully', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      await vatManager.terminateVat('v1');

      expect(mockKernelQueue.enqueueTerminateVat).toHaveBeenCalledWith(
        'v1',
        undefined,
      );
      expect(mockPlatformServices.terminate).toHaveBeenCalled();
      expect(vatHandles[0]?.terminate).toHaveBeenCalled();
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      expect(vatManager.hasVat('v1')).toBe(false);
    });

    it('terminates a vat with reason', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);
      const reason = { body: 'Custom reason', slots: [] };

      await vatManager.terminateVat('v1', reason);

      expect(mockPlatformServices.terminate).toHaveBeenCalledWith(
        'v1',
        expect.objectContaining({ message: 'Vat termination: Custom reason' }),
      );
    });

    it('supersedes a restart still queued for the same vat', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelQueue.enqueueRestartVat.mockImplementationOnce(() => undefined);
      const restarting = vatManager.restartVat('v1');

      await vatManager.terminateVat('v1');

      await expect(restarting).rejects.toThrow(VatDeletedError);
    });

    it('rejects a superseded restart with the run loop death that drops its termination', async () => {
      const deathHandlers: ((error: Error) => void)[] = [];
      mockKernelQueue.onRunLoopDeath.mockImplementation((reject) => {
        deathHandlers.push(reject);
        return () => undefined;
      });
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelQueue.enqueueRestartVat.mockImplementationOnce(() => undefined);
      const restarting = vatManager.restartVat('v1');
      // Held during a crank that then kills the run loop, so never written.
      mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
        () => undefined,
      );
      const terminating = vatManager.terminateVat('v1');
      await delay();

      const death = new Error('Kernel run loop died');
      for (const reject of deathHandlers) {
        reject(death);
      }

      await expect(restarting).rejects.toBe(death);
      await expect(terminating).rejects.toBe(death);
    });

    it('leaves a queued restart in place when the termination is refused', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelQueue.enqueueRestartVat.mockImplementationOnce(() => undefined);
      const restarting = vatManager.restartVat('v1');
      mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(() => {
        throw new Error('run loop is dead');
      });

      await expect(vatManager.terminateVat('v1')).rejects.toThrow(
        'run loop is dead',
      );

      const crankResult = await vatManager.performVatRestart('v1');
      await crankResult?.afterCommit?.();
      expect(await restarting).toBe(vatHandles[1]);
    });

    it('answers a restart asked for while the termination is pending with its death', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      leaveRequestQueued();
      const overtaken = vatManager.restartVat('v1');
      mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
        () => undefined,
      );
      const terminating = vatManager.terminateVat('v1');
      const later = vatManager.restartVat('v1');

      expect(await vatManager.performVatRestart('v1')).toBeUndefined();
      await vatManager.performVatTermination('v1');

      await expect(overtaken).rejects.toThrow(VatDeletedError);
      await expect(later).rejects.toThrow(VatDeletedError);
      expect(await terminating).toBeUndefined();
      expect(mockKernelQueue.enqueueRestartVat).toHaveBeenCalledOnce();
      expect(mockPlatformServices.launch).toHaveBeenCalledOnce();
    });

    it('queues restarts again once its termination is abandoned', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
        () => undefined,
      );
      const terminating = vatManager.terminateVat('v1');
      vatManager.abandonQueuedWork(new Error('Kernel was reset'));
      await expect(terminating).rejects.toThrow('Kernel was reset');

      expect(await vatManager.restartVat('v1')).toBe(vatHandles[1]);
    });

    it('throws for a vat that is neither running nor persisted', async () => {
      mockKernelStore.isVatActive.mockReturnValue(false);

      await expect(vatManager.terminateVat('v9')).rejects.toThrow(
        VatNotFoundError,
      );
      expect(mockKernelQueue.enqueueTerminateVat).not.toHaveBeenCalled();
    });

    describe('performVatTermination', () => {
      it('carries out a request nobody is waiting for', async () => {
        await vatManager.runVat('v1', createMockVatConfig());

        expect(await vatManager.performVatTermination('v1')).toStrictEqual({
          irrevocable: true,
        });

        expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      });

      it('tells an overtaken restart its vat is gone when something else killed it first', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        leaveRequestQueued();
        const restarting = vatManager.restartVat('v1');
        mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
          () => undefined,
        );
        const terminating = vatManager.terminateVat('v1');
        await vatManager.stopVat('v1', true);
        mockKernelStore.isVatActive.mockReturnValue(false);

        expect(await vatManager.performVatTermination('v1')).toBeUndefined();

        await expect(restarting).rejects.toThrow(VatDeletedError);
        expect(await terminating).toBeUndefined();
      });

      it('answers a caller whose vat something else already killed', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
          () => undefined,
        );
        const terminating = vatManager.terminateVat('v1');
        await vatManager.stopVat('v1', true);
        mockKernelStore.isVatActive.mockReturnValue(false);

        expect(await vatManager.performVatTermination('v1')).toBeUndefined();

        expect(await terminating).toBeUndefined();
      });

      it('answers its caller when the run loop dies after the crank took the request', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
          () => undefined,
        );
        let killRunLoop = (_error: Error): void => undefined;
        mockKernelQueue.onRunLoopDeath.mockImplementationOnce(
          (reject: (error: Error) => void) => {
            killRunLoop = reject;
            return () => undefined;
          },
        );
        const terminating = vatManager.terminateVat('v1');
        let endCrank = (): void => undefined;
        mockKernelQueue.waitForCrank.mockReturnValue(
          new Promise<void>((resolve) => {
            endCrank = resolve;
          }),
        );

        await vatManager.performVatTermination('v1');
        killRunLoop(new Error('run loop died'));
        endCrank();

        expect(await terminating).toBeUndefined();
      });

      it('settles without rejecting when the teardown fails', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
          () => undefined,
        );
        const terminating = vatManager.terminateVat('v1');
        mockKernelStore.deleteVat.mockImplementationOnce(() => {
          throw new Error('deleteVat failed');
        });

        expect(await vatManager.performVatTermination('v1')).toStrictEqual({
          irrevocable: true,
        });
        await expect(terminating).rejects.toThrow(
          expect.objectContaining({
            message: 'Termination of vat v1 failed',
            cause: expect.objectContaining({ message: 'deleteVat failed' }),
          }),
        );
      });

      it('holds a restart asked for during a failing teardown for the termination', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
          () => undefined,
        );
        const terminating = vatManager.terminateVat('v1');
        mockKernelStore.deleteVat.mockImplementationOnce(() => {
          throw new Error('deleteVat failed');
        });
        let restarting: Promise<VatHandle> | undefined;
        mockPlatformServices.terminate.mockImplementationOnce(async () => {
          restarting = vatManager.restartVat('v1');
        });

        await vatManager.performVatTermination('v1');

        await expect(restarting).rejects.toThrow(
          'Restart of vat v1 was overtaken by a termination that failed',
        );
        await expect(terminating).rejects.toThrow(
          'Termination of vat v1 failed',
        );
        expect(mockKernelQueue.enqueueRestartVat).not.toHaveBeenCalled();
      });

      it('tells an overtaken restart it was not carried out when the teardown fails', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        leaveRequestQueued();
        const restarting = vatManager.restartVat('v1');
        mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
          () => undefined,
        );
        const terminating = vatManager.terminateVat('v1');
        mockKernelStore.deleteVat.mockImplementationOnce(() => {
          throw new Error('deleteVat failed');
        });

        await vatManager.performVatTermination('v1');

        await expect(restarting).rejects.toThrow(
          'Restart of vat v1 was overtaken by a termination that failed',
        );
        await expect(terminating).rejects.toThrow(
          'Termination of vat v1 failed',
        );
      });
    });

    describe('a vat that is persisted but not running', () => {
      /**
       * Leave the vat persisted but not running, as a restart that has stopped
       * the old worker does.
       */
      async function givenAVatBetweenWorkers(): Promise<void> {
        await vatManager.runVat('v1', createMockVatConfig());
        await vatManager.stopVat('v1', false);
        expect(vatManager.hasVat('v1')).toBe(false);
      }

      it('can be terminated', async () => {
        await givenAVatBetweenWorkers();

        await vatManager.terminateVat('v1');

        expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      });

      it('discards its persisted record', async () => {
        await givenAVatBetweenWorkers();

        await vatManager.terminateVat('v1');

        expect(mockKernelStore.deleteVat).toHaveBeenCalledWith('v1');
      });

      it('rejects the promises it was deciding', async () => {
        mockKernelStore.getPromisesByDecider.mockReturnValue(['kp1']);
        await givenAVatBetweenWorkers();

        await vatManager.terminateVat('v1', {
          body: 'Custom reason',
          slots: [],
        });

        expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('v1', [
          [
            'kp1',
            true,
            expect.objectContaining({
              body: expect.stringContaining('Custom reason'),
            }),
          ],
        ]);
      });

      it('releases the pin its root was launched with', async () => {
        await givenAVatBetweenWorkers();

        await vatManager.terminateVat('v1');

        expect(mockKernelStore.unpinObject).toHaveBeenCalledWith('ko1');
      });
    });
  });

  describe('restartVat', () => {
    it('restarts a vat successfully', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);
      const originalHandle = vatHandles[0];

      const result = await vatManager.restartVat('v1');

      expect(mockKernelQueue.enqueueRestartVat).toHaveBeenCalledWith('v1');
      expect(originalHandle?.terminate).toHaveBeenCalledWith(false, undefined);
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(2);
      expect(makeVatHandleMock).toHaveBeenCalledTimes(2);
      expect(result).not.toBe(originalHandle);
      expect(result).toBe(vatHandles[1]);
      expect(vatManager.hasVat('v1')).toBe(true);
    });

    it('throws if vat not found', async () => {
      mockKernelStore.isVatActive.mockReturnValue(false);

      await expect(vatManager.restartVat('v1')).rejects.toThrow(
        VatNotFoundError,
      );
      expect(mockKernelQueue.enqueueRestartVat).not.toHaveBeenCalled();
    });

    it('relaunches a vat between workers from its stored config', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.stopVat('v1', false);
      const storedConfig = createMockVatConfig('stored');
      mockKernelStore.getVatConfig.mockReturnValue(storedConfig);

      await vatManager.restartVat('v1');

      expect(mockPlatformServices.launch).toHaveBeenLastCalledWith(
        'v1',
        storedConfig,
      );
      expect(vatManager.hasVat('v1')).toBe(true);
    });

    it('relaunches a running vat with its own config', async () => {
      const config = createMockVatConfig('running');
      await vatManager.runVat('v1', config);

      await vatManager.restartVat('v1');

      expect(mockPlatformServices.launch).toHaveBeenLastCalledWith(
        'v1',
        config,
      );
      expect(mockKernelStore.getVatConfig).not.toHaveBeenCalled();
    });

    it('gives two callers waiting on one vat the same restart', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      const [first, second] = await Promise.all([
        vatManager.restartVat('v1'),
        vatManager.restartVat('v1'),
      ]);

      expect(mockKernelQueue.enqueueRestartVat).toHaveBeenCalledTimes(2);
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(2);
      expect(first).toBe(second);
    });

    it('restarts the same vat twice in a row', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      const first = await vatManager.restartVat('v1');
      const second = await vatManager.restartVat('v1');

      expect(first).not.toBe(second);
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(3);
    });

    it('rejects its caller rather than the waiter when the queue refuses', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      const unhandled = vi.fn();
      mockKernelQueue.onRunLoopDeath.mockImplementationOnce(
        (reject: (error: Error) => void) => {
          reject(new Error('run loop died'));
          return () => undefined;
        },
      );
      mockKernelQueue.enqueueRestartVat.mockImplementationOnce(() => {
        throw new Error('Kernel run loop died; cannot restart a vat');
      });

      process.on('unhandledRejection', unhandled);
      try {
        await expect(vatManager.restartVat('v1')).rejects.toThrow(
          'cannot restart a vat',
        );
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off('unhandledRejection', unhandled);
      }
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('rejects its caller when the run loop dies', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      const death = new Error('run loop died');
      leaveRequestQueued();
      mockKernelQueue.onRunLoopDeath.mockImplementationOnce(
        (reject: (error: Error) => void) => {
          queueMicrotask(() => reject(death));
          return () => undefined;
        },
      );

      await expect(vatManager.restartVat('v1')).rejects.toThrow(
        'run loop died',
      );
    });
  });

  describe('performVatRestart', () => {
    it('drops a request nobody is waiting for', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      await vatManager.performVatRestart('v1');

      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(1);
    });

    it('drops an item left over from a restart that is already done', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.restartVat('v1');
      const launches = mockPlatformServices.launch.mock.calls.length;

      await vatManager.performVatRestart('v1');

      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(launches);
    });

    it('drops a request for a vat gone before its crank, rather than throwing', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      leaveRequestQueued();
      const restarting = vatManager.restartVat('v1');
      await vatManager.stopVat('v1', true);
      mockKernelStore.isVatActive.mockReturnValue(false);

      const crankResult = await vatManager.performVatRestart('v1');
      expect(crankResult).toStrictEqual({ afterCommit: expect.any(Function) });
      await crankResult?.afterCommit?.();

      await expect(restarting).rejects.toThrow(VatDeletedError);
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(1);
    });

    it('relaunches even when the old channel will not close', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      vatHandles[0]?.terminate.mockRejectedValueOnce(
        new Error('stream will not end'),
      );

      await vatManager.restartVat('v1');

      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(2);
      expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
    });

    it('relaunches even when the old worker will not stop', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockPlatformServices.terminate.mockRejectedValueOnce(
        new Error('worker.terminate failed'),
      );

      await vatManager.restartVat('v1');

      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(2);
      expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
    });

    it('answers its caller only once the crank commits', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      leaveRequestQueued();
      const answered = vi.fn();
      const restarting = vatManager.restartVat('v1').then(answered);

      const crankResult = await vatManager.performVatRestart('v1');
      await new Promise((resolve) => setImmediate(resolve));
      // A crank that fails after the relaunch never runs this, and the run
      // loop's death rejects the caller instead.
      expect(answered).not.toHaveBeenCalled();
      await crankResult?.afterCommit?.();
      await restarting;

      expect(answered).toHaveBeenCalledWith(vatHandles[1]);
    });

    it('answers its caller with the vat it restarted', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      leaveRequestQueued();
      const restarting = vatManager.restartVat('v1');

      const crankResult = await vatManager.performVatRestart('v1');
      // The next crank, a second restart, takes the handle away before this
      // caller wakes.
      await vatManager.stopVat('v1', false);
      await crankResult?.afterCommit?.();

      expect(await restarting).toBe(vatHandles[1]);
    });

    it('aborts the crank and terminates the vat when the relaunch fails', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      leaveRequestQueued();
      const restarting = vatManager.restartVat('v1');
      const launchError = new Error('ENOENT: no such file or directory');
      mockPlatformServices.launch.mockRejectedValueOnce(launchError);
      const message =
        'Vat v1 was terminated after its restart failed: ENOENT: no such file or directory';

      // Not a rejection: the run loop's catch would roll the crank back and
      // die.
      expect(await vatManager.performVatRestart('v1')).toStrictEqual({
        abort: true,
        terminate: {
          vatId: 'v1',
          reject: true,
          info: makeFatalKernelError('INTERNAL_ERROR', message),
        },
      });
      await expect(restarting).rejects.toThrow(
        expect.objectContaining({ message, cause: launchError }),
      );
    });

    it('relaunches even when the old channel never finishes closing', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      vatHandles[0]?.terminate.mockReturnValueOnce(
        new Promise<void>(() => undefined),
      );

      await vatManager.restartVat('v1');

      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(2);
    });

    describe('with a new worker that is not ready in time', () => {
      const timeoutMessage =
        'Vat v1 was terminated after its restart failed: Vat v1 did not start within 1 ms';

      beforeEach(() => {
        vatManager = new VatManager({
          platformServices: mockPlatformServices,
          kernelStore: mockKernelStore,
          kernelQueue: mockKernelQueue,
          logger: mockLogger,
          vatRelaunchTimeoutMs: 1,
        });
      });

      /**
       * Restart `v1` by hand and let the relaunch time out.
       *
       * @returns The caller's promise and the crank's result.
       */
      const restartPastTheTimeout = async (): Promise<{
        restarting: Promise<VatHandle>;
        crankResult: Awaited<ReturnType<VatManager['performVatRestart']>>;
      }> => {
        leaveRequestQueued();
        const restarting = vatManager.restartVat('v1');
        restarting.catch(() => undefined);
        const crankResult = await vatManager.performVatRestart('v1');
        return { restarting, crankResult };
      };

      it.each([
        {
          stage: 'launch',
          hang: (): void => {
            mockPlatformServices.launch.mockReturnValueOnce(
              new Promise(() => undefined),
            );
          },
        },
        {
          stage: 'handshake',
          hang: (): void => {
            makeVatHandleMock.mockReturnValueOnce(new Promise(() => undefined));
          },
        },
      ])('terminates the vat when the $stage hangs', async ({ hang }) => {
        await vatManager.runVat('v1', createMockVatConfig());
        hang();

        const { restarting, crankResult } = await restartPastTheTimeout();

        expect(crankResult).toStrictEqual({
          abort: true,
          terminate: {
            vatId: 'v1',
            reject: true,
            info: makeFatalKernelError('INTERNAL_ERROR', timeoutMessage),
          },
        });
        expect(mockPlatformServices.terminate).toHaveBeenLastCalledWith('v1');
        await expect(restarting).rejects.toThrow(timeoutMessage);
      });

      it('does not wait for the platform to stop the worker', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        makeVatHandleMock.mockReturnValueOnce(new Promise(() => undefined));
        mockPlatformServices.terminate
          .mockResolvedValueOnce(undefined)
          .mockReturnValueOnce(new Promise(() => undefined));

        const { restarting, crankResult } = await restartPastTheTimeout();

        expect(crankResult).toMatchObject({ abort: true });
        await expect(restarting).rejects.toThrow(timeoutMessage);
      });

      it('does not register a handle whose handshake finishes late', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        const { promise: handshake, resolve: finishHandshake } =
          makePromiseKit<VatHandle>();
        makeVatHandleMock.mockReturnValueOnce(handshake);

        await restartPastTheTimeout();
        const lateHandle = createMockVatHandle('v1', createMockVatConfig());
        finishHandshake(lateHandle);
        await delay();

        expect(vatManager.hasVat('v1')).toBe(false);
        expect(lateHandle.terminate).toHaveBeenCalledWith(true);
      });

      it('closes the channel of a handshake still under way', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        const channel = {
          end: vi.fn().mockResolvedValue(undefined),
        } as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>;
        mockPlatformServices.launch.mockResolvedValueOnce(channel);
        makeVatHandleMock.mockReturnValueOnce(new Promise(() => undefined));

        await restartPastTheTimeout();

        expect(channel.end).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'Vat v1 did not start within 1 ms',
          }),
        );
      });

      it('stops a worker whose launch finishes late', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        const { promise: launched, resolve: finishLaunch } =
          makePromiseKit<DuplexStream<JsonRpcMessage, JsonRpcMessage>>();
        mockPlatformServices.launch.mockReturnValueOnce(launched);

        await restartPastTheTimeout();
        mockPlatformServices.terminate.mockClear();
        finishLaunch({
          end: vi.fn().mockResolvedValue(undefined),
        } as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>);
        await delay();

        expect(mockPlatformServices.terminate).toHaveBeenCalledExactlyOnceWith(
          'v1',
        );
        expect(makeVatHandleMock).toHaveBeenCalledOnce();
        expect(vatManager.hasVat('v1')).toBe(false);
      });
    });

    it('answers a failed restart only once the crank ends', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      leaveRequestQueued();
      const rejected = vi.fn();
      const restarting = vatManager.restartVat('v1').catch(rejected);
      const { promise: crankEnded, resolve: endCrank } = makePromiseKit<void>();
      mockKernelQueue.waitForCrank.mockReturnValueOnce(crankEnded);
      mockPlatformServices.launch.mockRejectedValueOnce(new Error('ENOENT'));

      await vatManager.performVatRestart('v1');
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejected).not.toHaveBeenCalled();
      endCrank();
      await restarting;

      expect(rejected).toHaveBeenCalledOnce();
    });

    it('stops the worker a failed handshake left behind', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      leaveRequestQueued();
      const restarting = vatManager.restartVat('v1');
      makeVatHandleMock.mockRejectedValueOnce(new Error('handshake timed out'));

      await vatManager.performVatRestart('v1');

      // The old worker's stop, then the new one's.
      expect(mockPlatformServices.terminate.mock.calls).toStrictEqual([
        ['v1', undefined],
        ['v1'],
      ]);
      await expect(restarting).rejects.toThrow('handshake timed out');
    });
  });

  describe('abandonQueuedWork', () => {
    it('rejects every caller waiting on queued work', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.runVat('v2', createMockVatConfig());
      await vatManager.runVat('v3', createMockVatConfig());
      leaveRequestQueued();
      leaveRequestQueued();
      leaveRequestQueued();
      mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
        () => undefined,
      );
      const waiting = [
        vatManager.restartVat('v1'),
        vatManager.restartVat('v2'),
        // Overtaken by the termination after it.
        vatManager.restartVat('v3'),
        vatManager.terminateVat('v3'),
      ];
      const reset = new Error('Kernel was reset');

      vatManager.abandonQueuedWork(reset);

      for (const caller of waiting) {
        await expect(caller).rejects.toBe(reset);
      }
      // Their items find nobody to answer.
      expect(await vatManager.performVatRestart('v1')).toBeUndefined();
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(3);
    });

    it('discards requests held for the open crank', () => {
      vatManager.abandonQueuedWork(new Error('Kernel was reset'));

      expect(mockKernelQueue.discardHeldRequests).toHaveBeenCalledOnce();
    });
  });

  describe('pingVat', () => {
    it('pings a vat successfully', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      const result = await vatManager.pingVat('v1');

      expect(vatHandles[0]?.ping).toHaveBeenCalled();
      expect(result).toStrictEqual({ pong: true });
    });

    it('throws if vat not found', async () => {
      await expect(vatManager.pingVat('v1')).rejects.toThrow(VatNotFoundError);
    });
  });

  describe('getVat', () => {
    it('returns vat handle if exists', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      const vat = vatManager.getVat('v1');

      expect(vat).toBe(vatHandles[0]);
    });

    it('throws if vat not found', () => {
      expect(() => vatManager.getVat('v1')).toThrow(VatNotFoundError);
    });
  });

  describe('hasVat', () => {
    it('returns true if vat exists', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      expect(vatManager.hasVat('v1')).toBe(true);
    });

    it('returns false if vat does not exist', () => {
      expect(vatManager.hasVat('v1')).toBe(false);
    });
  });

  describe('getVatIds', () => {
    it('returns empty array initially', () => {
      expect(vatManager.getVatIds()).toStrictEqual([]);
    });

    it('returns array of vat IDs', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.runVat('v2', createMockVatConfig());

      expect(vatManager.getVatIds()).toStrictEqual(['v1', 'v2']);
    });
  });

  describe('getVats', () => {
    it('returns empty array initially', () => {
      expect(vatManager.getVats()).toStrictEqual([]);
    });

    it('returns array of vat information', async () => {
      const config1 = createMockVatConfig('vat1');
      const config2 = createMockVatConfig('vat2');
      await vatManager.runVat('v1', config1);
      await vatManager.runVat('v2', config2);

      const vats = vatManager.getVats();

      expect(vats).toHaveLength(2);
      expect(vats[0]).toStrictEqual({
        id: 'v1',
        config: config1,
        subclusterId: 's1',
      });
      expect(vats[1]).toStrictEqual({
        id: 'v2',
        config: config2,
        subclusterId: 's1',
      });
    });
  });

  describe('releaseVatRootPin', () => {
    it('releases the pin on a vat root', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      vatManager.releaseVatRootPin('v1');

      expect(mockKernelStore.unpinObject).toHaveBeenCalledWith('ko1');
    });

    it('does nothing for a vat with no root', () => {
      // Teardown can outlive the kernel's knowledge of the vat, and there is
      // no pin to release in that case.
      mockKernelStore.getRootObject.mockReturnValue(undefined);

      expect(() => vatManager.releaseVatRootPin('v1')).not.toThrow();
      expect(mockKernelStore.unpinObject).not.toHaveBeenCalled();
    });
  });

  describe('pinVatRoot', () => {
    it('pins vat root successfully', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      const kref = vatManager.pinVatRoot('v1');

      expect(mockKernelStore.getRootObject).toHaveBeenCalledWith('v1');
      expect(mockKernelStore.pinObject).toHaveBeenCalledWith('ko1');
      expect(kref).toBe('ko1');
    });

    it('throws if vat not found', () => {
      mockKernelStore.getRootObject.mockReturnValue(undefined);
      expect(() => vatManager.pinVatRoot('v1')).toThrow(VatNotFoundError);
    });
  });

  describe('unpinVatRoot', () => {
    it('unpins vat root successfully', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);

      vatManager.unpinVatRoot('v1');

      expect(mockKernelStore.getRootObject).toHaveBeenCalledWith('v1');
      expect(mockKernelStore.unpinObject).toHaveBeenCalledWith('ko1');
    });

    it('throws if vat not found', () => {
      mockKernelStore.getRootObject.mockReturnValue(undefined);
      expect(() => vatManager.unpinVatRoot('v1')).toThrow(VatNotFoundError);
    });
  });

  describe('reapVats', () => {
    it('reaps all vats with default filter', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.runVat('v2', createMockVatConfig());

      vatManager.reapVats();

      expect(mockKernelStore.scheduleReap).toHaveBeenCalledWith('v1');
      expect(mockKernelStore.scheduleReap).toHaveBeenCalledWith('v2');
    });

    it('reaps vats matching filter', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.runVat('v2', createMockVatConfig());

      vatManager.reapVats((vatId) => vatId === 'v1');

      expect(mockKernelStore.scheduleReap).toHaveBeenCalledWith('v1');
      expect(mockKernelStore.scheduleReap).not.toHaveBeenCalledWith('v2');
    });

    it('does nothing with no vats', () => {
      vatManager.reapVats();

      expect(mockKernelStore.scheduleReap).not.toHaveBeenCalled();
    });
  });

  describe('terminateAllVats', () => {
    it('writes directly rather than queuing', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      await vatManager.terminateAllVats();

      expect(mockKernelQueue.enqueueTerminateVat).not.toHaveBeenCalled();
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });

    it('terminates all vats in reverse order', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.runVat('v2', createMockVatConfig());

      await vatManager.terminateAllVats();

      expect(mockKernelQueue.waitForCrank).toHaveBeenCalled();
      expect(vatHandles[1]?.terminate).toHaveBeenCalled();
      expect(vatHandles[0]?.terminate).toHaveBeenCalled();
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v2');
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      expect(mockKernelStore.collectGarbage).toHaveBeenCalledTimes(2);
      expect(vatManager.getVatIds()).toStrictEqual([]);
    });

    it('skips a vat something else retired while an earlier one stopped', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.runVat('v2', createMockVatConfig());
      mockPlatformServices.terminate.mockImplementationOnce(async () => {
        // A queued termination of v1 runs while v2's worker stops.
        await vatManager.stopVat('v1', true);
        mockKernelStore.isVatActive.mockReturnValue(false);
      });

      await vatManager.terminateAllVats();

      expect(mockKernelStore.markVatAsTerminated.mock.calls).toStrictEqual([
        ['v2'],
        ['v1'],
      ]);
      expect(vatManager.getVatIds()).toStrictEqual([]);
    });

    it('handles empty vat list', async () => {
      await vatManager.terminateAllVats();

      expect(mockKernelQueue.waitForCrank).toHaveBeenCalled();
      expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
    });
  });

  describe('collectGarbage', () => {
    it('collects garbage until cleanup is done', () => {
      mockKernelStore.nextTerminatedVatCleanup
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      vatManager.collectGarbage();

      expect(mockKernelStore.nextTerminatedVatCleanup).toHaveBeenCalledTimes(3);
      expect(mockKernelStore.collectGarbage).toHaveBeenCalledOnce();
    });

    it('collects garbage when no cleanup needed', () => {
      mockKernelStore.nextTerminatedVatCleanup.mockReturnValue(false);

      vatManager.collectGarbage();

      expect(mockKernelStore.nextTerminatedVatCleanup).toHaveBeenCalledOnce();
      expect(mockKernelStore.collectGarbage).toHaveBeenCalledOnce();
    });
  });
});
