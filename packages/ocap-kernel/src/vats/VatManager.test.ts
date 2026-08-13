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
import type { VatId, VatConfig, PlatformServices } from '../types.ts';
import { VatHandle } from './VatHandle.ts';
import { VatManager } from './VatManager.ts';

/**
 * Let the pending microtasks run, so an operation under test gets as far as its
 * first real await.
 *
 * @returns A promise that resolves once the microtask queue has drained.
 */
const drainMicrotasks = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

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
      // Resolved rather than bare, so callers that chain off it — rather than
      // awaiting — behave as they would against the real async method.
      terminate: vi.fn().mockResolvedValue(undefined),
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
      // A restart is the run loop's work, so stand in for it reaching the
      // request on its next crank. Nothing is expected to come back out:
      // `performVatRestart` reports a failure through the waiter `restartVat`
      // registered, precisely so that it never takes the crank down. The catch
      // is here so that a regression on that shows up as a failing assertion
      // rather than an unhandled rejection.
      enqueueRestartVat: vi.fn((vatId: VatId) => {
        vatManager.performVatRestart(vatId).catch(() => undefined);
      }),
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
      // The worker is already running by this point, so it has to be stopped,
      // and the vat marked so the terminated-vat cleanup reclaims what the
      // partial launch wrote.
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
      // `stopVat` unpins the root it was launched with, which is the first
      // thing in the teardown that can fail.
      mockKernelStore.unpinObject.mockImplementationOnce(() => {
        throw new Error('worker will not die');
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

    it('waits out the crank in flight before recording the vat as in flux', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      let finishCrank!: () => void;
      (
        mockKernelQueue.waitForCrank as unknown as MockInstance
      ).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishCrank = resolve;
        }),
      );

      const terminated = vatManager.terminateVat('v1');
      await drainMicrotasks();

      // Recording first and waiting after would deadlock, and this is the
      // assertion that catches it: a crank already running reaches its endpoint
      // lookup here, and would find a record whose teardown is waiting for that
      // same crank to end. Reverse the order in `#trackFlux` and this hangs.
      expect(await vatManager.provideVat('v1')).toBe(vatHandles[0]);

      finishCrank();
      await terminated;

      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });
  });

  describe('recording a vat as dead', () => {
    /**
     * The four writes that make up a vat's death, as the store saw them.
     *
     * @returns How many times each was made.
     */
    const recorded = (): {
      rejectedItsPromises: number;
      unpinnedItsRoot: number;
      deletedItsRecords: number;
      marked: number;
    } => {
      const callsTo = (mock: unknown): number =>
        (mock as MockInstance).mock.calls.length;
      return {
        rejectedItsPromises: callsTo(mockKernelQueue.resolvePromises),
        unpinnedItsRoot: callsTo(mockKernelStore.unpinObject),
        deletedItsRecords: callsTo(mockKernelStore.deleteVat),
        marked: callsTo(mockKernelStore.markVatAsTerminated),
      };
    };

    it('records all of it even when the worker refuses to go', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      (
        mockKernelStore.getPromisesByDecider as unknown as MockInstance
      ).mockReturnValueOnce(['kp1']);
      (
        vatHandles[0]?.terminate as unknown as MockInstance
      ).mockRejectedValueOnce(new Error('stream would not close'));

      await expect(vatManager.terminateVat('v1')).rejects.toThrow(
        'stream would not close',
      );

      // A partial record is the state nothing recovers from: marked terminated
      // while `vatConfig` survives reads as *active* again as soon as cleanup
      // drops the mark, and the router kills the run loop over the
      // disagreement. All four land, or the failure above is the lesser bug.
      expect(recorded()).toStrictEqual({
        rejectedItsPromises: 1,
        unpinnedItsRoot: 1,
        deletedItsRecords: 1,
        marked: 1,
      });
      expect(vatManager.hasVat('v1')).toBe(false);
    });

    it('records it for a vat the store still lists but the kernel has lost', async () => {
      // What `terminateSubcluster` hands us: it iterates the store's own vat
      // list, which can name a vat whose handle is already gone.
      (mockKernelStore.isVatActive as unknown as MockInstance) = vi
        .fn()
        .mockReturnValue(true);

      await vatManager.terminateVat('v1');

      expect(mockKernelStore.deleteVat).toHaveBeenCalledWith('v1');
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });

    it('refuses a vat neither the kernel nor the store knows about', async () => {
      (mockKernelStore.isVatActive as unknown as MockInstance) = vi
        .fn()
        .mockReturnValue(false);

      await expect(vatManager.terminateVat('v9')).rejects.toThrow(
        VatNotFoundError,
      );
      expect(mockKernelStore.markVatAsTerminated).not.toHaveBeenCalled();
    });

    /**
     * Report a fatal stream failure for a vat, as its handle's drain catch does.
     *
     * @param vat - The handle reporting it.
     */
    const failStream = (vat: VatHandle): void => {
      const { onCriticalFailure } = makeVatHandleMock.mock
        .calls[0]?.[0] as unknown as {
        onCriticalFailure: (error: Error, failed: VatHandle) => void;
      };
      onCriticalFailure(new Error('read error'), vat);
    };

    it('records it when a vat`s stream fails under it', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      failStream(vatHandles[0] as VatHandle);

      // Left on the books, the handle stays resolvable, so the next delivery
      // goes to a worker that cannot answer and the crank never completes —
      // the RPC client has no timeout.
      expect(vatManager.hasVat('v1')).toBe(false);
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });

    it('rejects the delivery in flight when a vat`s stream fails under it', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      failStream(vatHandles[0] as VatHandle);

      // Recording the death only helps the *next* delivery. The one that was in
      // flight when the worker died is still parked on an RPC client with no
      // timeout, so its crank never completes — the same hang, one delivery
      // earlier. `terminate` is what rejects it, and the worker has to go too.
      await vi.waitFor(() => {
        expect(vatHandles[0]?.terminate).toHaveBeenCalled();
        expect(mockPlatformServices.terminate).toHaveBeenCalledWith(
          'v1',
          expect.any(Error),
        );
      });
    });

    it('rejects it without waiting for the worker to die', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      (
        mockPlatformServices.terminate as unknown as MockInstance
      ).mockReturnValueOnce(new Promise(() => undefined));

      failStream(vatHandles[0] as VatHandle);

      // A worker that will not go must not be what keeps the delivery parked.
      await vi.waitFor(() => {
        expect(vatHandles[0]?.terminate).toHaveBeenCalledWith(
          true,
          expect.any(Error),
        );
      });
    });

    it('records it when the stream fails before the handle is returned', async () => {
      // The failure can land while `VatHandle.make` is still initializing the
      // vat, when the manager has no handle of its own to tear down with — and
      // the pending `initVat` that nothing else will settle is exactly what is
      // owed a rejection.
      makeVatHandleMock.mockImplementationOnce(
        async ({ vatId, vatConfig, onCriticalFailure }) => {
          const handle = createMockVatHandle(vatId, vatConfig);
          onCriticalFailure(new Error('read error'), handle);
          return handle;
        },
      );

      await expect(
        vatManager.runVat('v1', createMockVatConfig()),
      ).rejects.toThrow('read error');

      expect(vatHandles[0]?.terminate).toHaveBeenCalledWith(
        true,
        expect.any(Error),
      );
      // On the books, this handle would be one the store already calls dead.
      expect(vatManager.hasVat('v1')).toBe(false);
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
    });

    it('records none of it for a restart', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      await vatManager.stopVat('v1', false);

      // The same vat, and the same root, are coming back.
      expect(recorded()).toStrictEqual({
        rejectedItsPromises: 0,
        unpinnedItsRoot: 0,
        deletedItsRecords: 0,
        marked: 0,
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
      await expect(vatManager.restartVat('v1')).rejects.toThrow(
        VatNotFoundError,
      );
    });

    it('marks a vat terminated when its relaunch fails', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      makeVatHandleMock.mockRejectedValueOnce(new Error('worker died'));

      await expect(vatManager.restartVat('v1')).rejects.toThrow('worker died');

      // Nothing else reclaims a vat with no worker that the store still counts
      // among the living.
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      await expect(vatManager.provideVat('v1')).rejects.toThrow(
        VatNotFoundError,
      );
    });

    it('releases the root pin when its relaunch fails', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      makeVatHandleMock.mockRejectedValueOnce(new Error('worker died'));

      await expect(vatManager.restartVat('v1')).rejects.toThrow('worker died');

      // The restart's `stopVat` was told the vat was coming back, so it kept the
      // pin, and vat cleanup does not release pins. Without this the root's
      // refcount is held for the life of the kernel.
      expect(mockKernelStore.unpinObject).toHaveBeenCalledWith('ko1');
    });

    // The crank has to commit for those records to survive. Thrown instead, the
    // run loop's catch rolls the crank back — unmarking the vat, re-pinning its
    // root, and returning this very request to the run queue, so the next
    // process start dequeues it and fails the same way, forever.
    it('reports a failed relaunch without taking the crank down', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      makeVatHandleMock.mockRejectedValueOnce(new Error('worker died'));
      const restarted = vatManager.restartVat('v1');

      await expect(restarted).rejects.toThrow('worker died');
      // The caller heard about it; the crank did not.
      expect(await vatManager.performVatRestart('v1')).toBeUndefined();
    });

    it('rejects the promises a vat was deciding when its relaunch fails', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      (
        mockKernelStore.getPromisesByDecider as unknown as MockInstance
      ).mockReturnValue(['kp1']);
      makeVatHandleMock.mockRejectedValueOnce(new Error('worker died'));

      await expect(vatManager.restartVat('v1')).rejects.toThrow('worker died');

      // Nothing else will ever decide them: the incarnation that owed them is
      // gone and cleanup only tears the c-list down.
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('v1', [
        ['kp1', true, expect.objectContaining({ body: expect.any(String) })],
      ]);
    });

    // Both are exposed as RPCs, and `terminateVat` does not go through the run
    // queue, so it lands in the window between the request and the crank.
    it('drops a queued restart for a vat that was terminated first', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      (
        mockKernelQueue.enqueueRestartVat as unknown as MockInstance
      ).mockImplementation(() => undefined);
      const restarted = vatManager.restartVat('v1');

      await vatManager.terminateVat('v1');

      // The caller is told, rather than left waiting on a request nothing will
      // carry out.
      await expect(restarted).rejects.toThrow(VatDeletedError);
      // And the request itself goes quietly when the run loop reaches it. A
      // throw here is a dead kernel: `#restartVatWorker` does not catch.
      expect(await vatManager.performVatRestart('v1')).toBeUndefined();
    });

    it('does not strand a waiter when the request cannot be queued', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      (
        mockKernelQueue.enqueueRestartVat as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw new Error('run loop died');
      });

      await expect(vatManager.restartVat('v1')).rejects.toThrow(
        'run loop died',
      );

      // Left registered, the next request would reject it as superseded — and
      // nobody ever awaited it, so that rejection goes unhandled.
      (
        mockKernelQueue.enqueueRestartVat as unknown as MockInstance
      ).mockImplementation(() => undefined);
      const second = vatManager.restartVat('v1');
      await vatManager.performVatRestart('v1');
      expect(await second).toBe(vatHandles[1]);
    });

    it('leaves the vat in place until the run loop takes the request', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      const originalHandle = vatHandles[0];
      // Queue the request without standing in for the run loop.
      (
        mockKernelQueue.enqueueRestartVat as unknown as MockInstance
      ).mockImplementation(() => undefined);

      const restarted = vatManager.restartVat('v1');
      await drainMicrotasks();

      // The vat is only ever out of reach inside the crank that carries the
      // request out, where no other crank can see it.
      expect(vatManager.getVat('v1')).toBe(originalHandle);
      expect(originalHandle?.terminate).not.toHaveBeenCalled();

      await vatManager.performVatRestart('v1');

      expect(await restarted).toBe(vatHandles[1]);
    });

    it('supersedes a caller waiting on an earlier request for the same vat', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      (
        mockKernelQueue.enqueueRestartVat as unknown as MockInstance
      ).mockImplementation(() => undefined);

      const first = vatManager.restartVat('v1');
      const second = vatManager.restartVat('v1');

      // One waiter per vat, so the earlier caller is told rather than left
      // waiting on a restart the later one will consume.
      await expect(first).rejects.toThrow('superseded');
      await vatManager.performVatRestart('v1');
      expect(await second).toBe(vatHandles[1]);
    });
  });

  describe('provideVat', () => {
    it('returns the running handle when the vat is not in flux', async () => {
      await vatManager.runVat('v1', createMockVatConfig());

      expect(await vatManager.provideVat('v1')).toBe(vatHandles[0]);
    });

    it('throws if vat not found', async () => {
      await expect(vatManager.provideVat('v1')).rejects.toThrow(
        VatNotFoundError,
      );
    });

    it('reports a vat gone only once its termination has been recorded', async () => {
      await vatManager.runVat('v1', createMockVatConfig());
      let finishStop!: () => void;
      (vatHandles[0]?.terminate as unknown as MockInstance).mockImplementation(
        async () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
      );

      const terminated = vatManager.terminateVat('v1');
      await drainMicrotasks();
      const provided = vatManager.provideVat('v1');

      finishStop();

      await expect(provided).rejects.toThrow(VatNotFoundError);
      // The store agrees by the time a waiter is told, so a caller acting on
      // "gone" — releasing the kernel's side of a GC action, say — is acting on
      // a vat the store also calls terminated.
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalledWith('v1');
      await terminated;
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
