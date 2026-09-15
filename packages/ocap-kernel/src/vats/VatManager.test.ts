import type { CapData } from '@endo/marshal';
import {
  VatAlreadyExistsError,
  VatDeletedError,
  VatNotFoundError,
} from '@metamask/kernel-errors';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import type { Mocked, MockInstance } from 'vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { KernelQueue } from '../KernelQueue.ts';
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
   * Fire the fatal-error callback the manager gave a vat's handle, as its
   * stream's drain does when the channel breaks.
   *
   * @param index - Which handle, in creation order.
   * @param error - What broke.
   */
  function givenTheChannelBreaks(index: number, error: Error): void {
    const { onCriticalFailure } = makeVatHandleMock.mock.calls[index]?.[0] as {
      onCriticalFailure: (error: Error, vat: VatHandle) => void;
    };
    onCriticalFailure(error, vatHandles[index] as VatHandle);
  }

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
        // No `catch`: the run loop has none either, and a rejection there
        // rolls the crank back and kills it.
        queueMicrotask(() => {
          vatManager.performVatRestart(vatId).catch((error: unknown) => {
            // The run loop has no catch: a rejection there rolls the crank
            // back and kills it, so surfacing it here is the point.
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

    it('starts the rest when one vat will not start', async () => {
      mockKernelStore.getAllVatRecords.mockReturnValue(
        (function* () {
          yield { vatID: 'v1' as VatId, vatConfig: createMockVatConfig('a') };
          yield { vatID: 'v2' as VatId, vatConfig: createMockVatConfig('b') };
        })(),
      );
      mockPlatformServices.launch.mockRejectedValueOnce(
        new Error('ENOENT: no such file or directory'),
      );

      await vatManager.initializeAllVats();

      // One vat whose bundle has moved must cost the kernel that vat, not its
      // whole startup.
      expect(vatManager.getVatIds()).toStrictEqual(['v2']);
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

    it('still marks the vat terminated when the cleanup itself fails', async () => {
      const config = createMockVatConfig();
      const cause = new Error('setVatConfig threw');
      mockKernelStore.setVatConfig.mockImplementationOnce(() => {
        throw cause;
      });
      // `stopVat` stops short of the mark when a write before it throws, which
      // is what makes the assertion below about this catch rather than it.
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
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });
  });

  describe('a vat whose channel breaks', () => {
    it('takes the handle off the books at once', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      givenTheChannelBreaks(0, new Error('stream read error'));

      // A router that goes on resolving it hands the next delivery to a worker
      // that cannot answer, and the RPC client has no timeout.
      expect(vatManager.hasVat('v1')).toBe(false);
    });

    it('rejects its pending commands and stops its worker', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      const error = new Error('stream read error');

      givenTheChannelBreaks(0, error);
      await vi.waitFor(() =>
        expect(vatHandles[0]?.terminate).toHaveBeenCalled(),
      );

      expect(vatHandles[0]?.terminate).toHaveBeenCalledWith(true, error);
      expect(mockPlatformServices.terminate).toHaveBeenCalledWith('v1', error);
    });

    it('asks the run loop to record the death', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      givenTheChannelBreaks(0, new Error('stream read error'));
      await vi.waitFor(() =>
        expect(mockKernelQueue.enqueueTerminateVat).toHaveBeenCalled(),
      );

      // In a crank of its own, rather than in whichever one the stream happened
      // to break during, where an unrelated abort would roll it back.
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });

    it('records the death directly when the run loop cannot', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(() => {
        throw new Error('Kernel run loop died; cannot terminate a vat');
      });

      givenTheChannelBreaks(0, new Error('stream read error'));
      await vi.waitFor(() =>
        expect(mockKernelStore.deleteVat).toHaveBeenCalledWith('v1'),
      );

      // `deleteVat` and not just the mark: the store would otherwise keep the
      // `vatConfig` row the next boot relaunches from.
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });

    it('ignores a failure from a handle that has been replaced', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      const supersededHandle = vatHandles[0] as VatHandle;
      await vatManager.restartVat('v1');
      mockKernelStore.markVatAsTerminated.mockClear();

      givenTheChannelBreaks(0, new Error('stream read error'));

      // The old worker's stream breaks as it is killed, and ending the vat then
      // would end the incarnation that replaced it.
      expect(vatManager.getVat('v1')).not.toBe(supersededHandle);
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
        'deleteVat',
        'markVatAsTerminated',
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
      mockKernelStore.deleteVat.mockImplementationOnce(() => {
        throw new Error('deleteVat failed');
      });

      await expect(vatManager.stopVat('v1', true)).rejects.toThrow(
        'deleteVat failed',
      );

      // Marking it would make the deferred cleanup delete the decider
      // promises' c-list entries believing they were rejected. Unmarked, the
      // vat is simply not retired yet and the step can be tried again.
      expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
      expect(mockPlatformServices.terminate).toHaveBeenCalled();
      expect(vatManager.hasVat('v1')).toBe(false);
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

    it('records nothing a second time', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelStore.isVatTerminated.mockReturnValue(true);

      await vatManager.stopVat('v1', true);

      // `deleteVat` fails on a vat whose subcluster mapping the first call
      // removed, and a second unpin would spend a pin this vat no longer holds.
      expect(mockKernelStore.deleteVat).not.toHaveBeenCalled();
      expect(mockKernelStore.unpinObject).not.toHaveBeenCalled();
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

      // The crank that reaches the restart will find nothing to restart, so
      // its caller is told now rather than left waiting on it.
      await expect(restarting).rejects.toThrow(VatDeletedError);
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

        // A termination is an instruction rather than a request: an item that
        // outlived its caller is one `initializeAllVats` has just undone.
        await vatManager.performVatTermination('v1');

        expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      });

      it('answers a caller whose vat something else already killed', async () => {
        await vatManager.runVat('v1', createMockVatConfig());
        mockKernelQueue.enqueueTerminateVat.mockImplementationOnce(
          () => undefined,
        );
        const terminating = vatManager.terminateVat('v1');
        // The in-crank termination path, or `terminateAllVats`, gets there
        // first — which is exactly what this caller asked for.
        await vatManager.stopVat('v1', true);
        mockKernelStore.isVatActive.mockReturnValue(false);

        await vatManager.performVatTermination('v1');

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

        // The run loop has no catch: a rejection there rolls the crank back,
        // undoing whatever of the death did get written.
        expect(await vatManager.performVatTermination('v1')).toBeUndefined();
        await expect(terminating).rejects.toThrow('deleteVat failed');
      });
    });

    describe('a vat that is persisted but not running', () => {
      /**
       * Leave the vat gone from the running map with its record, its own store
       * and its root pin all still in place — what a restart that got as far as
       * stopping the old worker leaves behind.
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

        // The cleanup the mark schedules walks keys prefixed `${vatId}.`, which
        // never matches `vatConfig.${vatId}`; a record left behind restores the
        // vat at the next boot whose code is reachable.
        expect(mockKernelStore.deleteVat).toHaveBeenCalledWith('v1');
      });

      it('rejects the promises it was deciding', async () => {
        mockKernelStore.getPromisesByDecider.mockReturnValue(['kp1']);
        await givenAVatBetweenWorkers();

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

    it('accepts a request for a vat between workers', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.stopVat('v1', false);

      await vatManager.restartVat('v1');

      // No handle on the books, but the store still lists the vat, so this is a
      // request for one that is coming back.
      expect(vatManager.hasVat('v1')).toBe(true);
    });

    it('gives two callers waiting on one vat the same restart', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      const [first, second] = await Promise.all([
        vatManager.restartVat('v1'),
        vatManager.restartVat('v1'),
      ]);

      // Both queue an item, but the first crank settles the whole list, so the
      // second finds nothing to do: one fresh worker answers both.
      expect(mockKernelQueue.enqueueRestartVat).toHaveBeenCalledTimes(2);
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(2);
      expect(first).toBe(second);
    });

    it('restarts the same vat twice in a row', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      const first = await vatManager.restartVat('v1');
      const second = await vatManager.restartVat('v1');

      // The crank has to give the waiter list up, or the second request finds a
      // stale entry and is answered by nothing.
      expect(first).not.toBe(second);
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(3);
    });

    it('rejects its caller rather than the waiter when the queue refuses', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      // The shape this guards against: a run loop already dead rejects the
      // waiter the moment it is registered, and the refused enqueue then leaves
      // by the throw, so nothing ever awaits that rejected promise.
      mockKernelQueue.onRunLoopDeath.mockImplementationOnce(
        (reject: (error: Error) => void) => {
          reject(new Error('run loop died'));
          return () => undefined;
        },
      );
      mockKernelQueue.enqueueRestartVat.mockImplementationOnce(() => {
        throw new Error('Kernel run loop died; cannot restart a vat');
      });

      await expect(vatManager.restartVat('v1')).rejects.toThrow(
        'cannot restart a vat',
      );
      await new Promise((resolve) => setImmediate(resolve));
      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('rejects its caller when the run loop dies', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      const death = new Error('run loop died');
      mockKernelQueue.enqueueRestartVat.mockImplementationOnce(() => undefined);
      mockKernelQueue.onRunLoopDeath.mockImplementationOnce(
        (reject: (error: Error) => void) => {
          queueMicrotask(() => reject(death));
          return () => undefined;
        },
      );

      // A restart has no kernel promise behind it, so nothing else would ever
      // settle this caller.
      await expect(vatManager.restartVat('v1')).rejects.toThrow(
        'run loop died',
      );
    });
  });

  describe('performVatRestart', () => {
    it('drops a request nobody is waiting for', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      await vatManager.performVatRestart('v1');

      // The item outlived the process that queued it, and
      // `initializeAllVats` has already launched a fresh worker.
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(1);
    });

    it('drops an item left over from a restart that is already done', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      await vatManager.restartVat('v1');
      const launches = mockPlatformServices.launch.mock.calls.length;

      // Two callers queue two items and the first crank answers both, so the
      // second must find the list given up and nothing left to do.
      await vatManager.performVatRestart('v1');

      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(launches);
    });

    it('rejects its caller when the vat went away first', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelQueue.enqueueRestartVat.mockImplementationOnce(
        (vatId: VatId) => {
          queueMicrotask(() => {
            // `terminateVat` does not go through the run queue, so it can land
            // between the request and the crank that would carry it out.
            mockKernelStore.isVatActive.mockReturnValue(false);
            vatManager
              .stopVat(vatId, true)
              .then(async () => vatManager.performVatRestart(vatId))
              .catch(() => undefined);
          });
        },
      );

      await expect(vatManager.restartVat('v1')).rejects.toThrow(
        VatNotFoundError,
      );
    });

    it('relaunches even when the old worker will not shut down cleanly', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      vatHandles[0]?.terminate.mockRejectedValueOnce(
        new Error('stream will not end'),
      );

      await vatManager.restartVat('v1');

      // The handle is off the books and the worker killed either way, so an
      // untidy shutdown must not cost the vat its new incarnation.
      expect(mockPlatformServices.launch).toHaveBeenCalledTimes(2);
      expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
    });

    it('settles without rejecting when the relaunch fails', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockKernelQueue.enqueueRestartVat.mockImplementationOnce(() => undefined);
      const restarting = vatManager.restartVat('v1');
      mockPlatformServices.launch.mockRejectedValueOnce(
        new Error('ENOENT: no such file or directory'),
      );

      // The run loop has no catch: a rejection here rolls the crank back,
      // undoing the retirement and restoring the request.
      expect(await vatManager.performVatRestart('v1')).toBeUndefined();
      await expect(restarting).rejects.toThrow('ENOENT');
    });

    it('retires a vat whose relaunch fails, without throwing', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockPlatformServices.launch.mockRejectedValueOnce(
        new Error('ENOENT: no such file or directory'),
      );

      await expect(vatManager.restartVat('v1')).rejects.toThrow('ENOENT');

      // Throwing would have the run loop roll the crank back, undoing the
      // records below and restoring the request, so every later start would
      // replay the same failing restart.
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      expect(mockKernelStore.deleteVat).toHaveBeenCalledWith('v1');
      expect(vatManager.hasVat('v1')).toBe(false);
    });

    it('kills the worker a failed relaunch left behind', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      makeVatHandleMock.mockRejectedValueOnce(new Error('handshake timed out'));

      await expect(vatManager.restartVat('v1')).rejects.toThrow(
        'handshake timed out',
      );

      // The relaunch spawned a worker and recorded no handle for it, so the
      // retirement is the only thing that can stop it.
      expect(mockPlatformServices.terminate).toHaveBeenLastCalledWith(
        'v1',
        expect.any(VatDeletedError),
      );
    });

    it('answers its caller even when the retirement fails', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      mockPlatformServices.launch.mockRejectedValueOnce(
        new Error('ENOENT: no such file or directory'),
      );
      mockKernelStore.deleteVat.mockImplementationOnce(() => {
        throw new Error('deleteVat failed');
      });

      // The relaunch failure, not the retirement failure, is what the caller
      // asked about.
      await expect(vatManager.restartVat('v1')).rejects.toThrow('ENOENT');
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

      // Part of tearing the kernel down: `reset` has to work on a kernel whose
      // run loop has died, and a queued request never would be.
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
