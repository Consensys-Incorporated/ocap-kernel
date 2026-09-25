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
import type { KernelStore } from '../store/index.ts';
import type { VatId, VatConfig, PlatformServices } from '../types.ts';
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
      terminate: vi.fn(),
      ping: vi.fn().mockResolvedValue({ pong: true }),
    } as unknown as Mocked<VatHandle>;
    vatHandles.push(handle);
    return handle;
  };

  beforeEach(() => {
    vatHandles = [];

    mockPlatformServices = {
      launch: vi.fn().mockResolvedValue({
        end: vi.fn(),
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

      // The worker is spawned before anything that can fail here, and no handle
      // was recorded, so this is the only chance to stop it.
      expect(mockPlatformServices.terminate).toHaveBeenCalledWith('v1');
    });

    it('stops no worker when there was never one to stop', async () => {
      mockPlatformServices.launch.mockRejectedValueOnce(
        new Error('worker file not found'),
      );

      await expect(
        vatManager.launchVat(createMockVatConfig(), 'bob', 's1'),
      ).rejects.toThrow('Failed to launch vat v1 (bob)');

      // Both runtimes throw for a vat they have no worker for, so asking would
      // report a cleanup failure over the launch failure an operator is reading
      // the log to find.
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
      // The launch failure, not the cleanup failure, is what the caller needs.
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

      // Marking here would schedule the cleanup for a vat whose `deleteVat`
      // never ran, and the mark is dropped once that cleanup has swept: the
      // vat store and the subcluster row would be left with no way to reach
      // them again.
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
        // Written inside an open delivery savepoint, the whole death is undone
        // by a crank that goes on to abort, while the dropped handle is not.
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

        // The handle the first launch made, reporting after the handle that
        // replaced it is the one the manager keeps.
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
      // Read before awaiting: everything the store has to be told is written in
      // `stopVat`'s synchronous prefix, so a crank cannot land part-way through.
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

      // Marking it would make the deferred cleanup delete the decider
      // promises' c-list entries believing they were rejected. Unmarked, the
      // vat is simply not retired yet and the step can be tried again.
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

    it.each([
      {
        step: 'unpinning the root',
        arrange: () => {
          mockKernelStore.unpinObject.mockImplementationOnce(() => {
            throw new Error('unpin failed');
          });
        },
      },
      {
        step: 'terminating the handle',
        arrange: () => {
          vatHandles[0]?.terminate.mockRejectedValueOnce(
            new Error('terminate failed'),
          );
        },
      },
    ])('forgets the vat when $step throws', async ({ arrange }) => {
      await vatManager.runVat('v1', createMockVatConfig());
      arrange();

      await expect(vatManager.stopVat('v1', true)).rejects.toThrow('failed');

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

    it('continues even if platform terminate fails', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);
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

      expect(mockKernelQueue.waitForCrank).toHaveBeenCalled();
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

    describe('a vat that is persisted but not running', () => {
      /**
       * Leave the vat in the state a failed relaunch does: gone from the
       * running map, with its record, its own store and its root pin all still
       * in place.
       */
      async function givenAFailedRestart(): Promise<void> {
        await vatManager.runVat('v1', createMockVatConfig());
        mockPlatformServices.launch.mockRejectedValueOnce(
          new Error('ENOENT: no such file or directory'),
        );
        await expect(vatManager.restartVat('v1')).rejects.toThrow('ENOENT');
        expect(vatManager.hasVat('v1')).toBe(false);
      }

      it('can be terminated', async () => {
        await givenAFailedRestart();

        await vatManager.terminateVat('v1');

        expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      });

      it('discards its persisted record', async () => {
        await givenAFailedRestart();

        await vatManager.terminateVat('v1');

        // The cleanup the mark schedules walks keys prefixed `${vatId}.`, which
        // never matches `vatConfig.${vatId}`; a record left behind restores the
        // vat at the next boot whose code is reachable.
        expect(mockKernelStore.deleteVat).toHaveBeenCalledWith('v1');
      });

      it('rejects the promises it was deciding', async () => {
        mockKernelStore.getPromisesByDecider.mockReturnValue(['kp1']);
        await givenAFailedRestart();

        await vatManager.terminateVat('v1', {
          body: 'Custom reason',
          slots: [],
        });

        // `cleanupTerminatedVat` deletes these promises' c-list entries and
        // drops the decider's refcount on the understanding that its caller
        // rejected them first. A promise left unresolved with a decider that no
        // longer exists hangs its waiters for good.
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
        await givenAFailedRestart();

        await vatManager.terminateVat('v1');

        expect(mockKernelStore.unpinObject).toHaveBeenCalledWith('ko1');
      });

      it('throws for a vat that is neither running nor persisted', async () => {
        mockKernelStore.isVatActive.mockReturnValue(false);

        await expect(vatManager.terminateVat('v9')).rejects.toThrow(
          VatNotFoundError,
        );
        expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
      });
    });
  });

  describe('restartVat', () => {
    it('restarts a vat successfully', async () => {
      const config = createMockVatConfig();
      await vatManager.runVat('v1', config);
      const originalHandle = vatHandles[0];

      const result = await vatManager.restartVat('v1');

      expect(mockKernelQueue.waitForCrank).toHaveBeenCalled();
      expect(originalHandle?.terminate).toHaveBeenCalledWith(false, undefined);
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(2);
      expect(makeVatHandleMock).toHaveBeenCalledTimes(2);
      expect(result).not.toBe(originalHandle);
      expect(result).toBe(vatHandles[1]);
      expect(vatManager.hasVat('v1')).toBe(true);
    });

    it('throws if vat not found', async () => {
      await expect(vatManager.restartVat('v1')).rejects.toThrow(
        VatNotFoundError,
      );
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
