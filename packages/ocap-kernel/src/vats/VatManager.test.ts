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
      markVatAsTerminated: vi.fn(),
      getRootObject: vi.fn().mockReturnValue('ko1'),
      pinObject: vi.fn(),
      unpinObject: vi.fn(),
      scheduleReap: vi.fn(),
      nextTerminatedVatCleanup: vi.fn().mockReturnValue(false),
      collectGarbage: vi.fn(),
    } as unknown as Mocked<KernelStore>;

    mockKernelQueue = {
      waitForCrank: vi.fn().mockResolvedValue(undefined),
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
