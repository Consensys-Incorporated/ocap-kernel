import { VatNotFoundError } from '@metamask/kernel-errors';
import type { KernelDatabase } from '@metamask/kernel-store';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import type { Mocked, MockInstance } from 'vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Kernel } from './Kernel.ts';
import { kser } from './liveslots/kernel-marshal.ts';
import type {
  VatId,
  VatConfig,
  OnRunLoopFailure,
  PlatformServices,
  ClusterConfig,
} from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { makeMapKernelDatabase } from '../test/storage.ts';

const mocks = vi.hoisted(() => {
  class KernelQueue {
    static lastInstance: KernelQueue;

    enqueueMessage = vi
      .fn()
      .mockResolvedValue({ body: '{"result":"ok"}', slots: [] });

    #runLoopFailure: Error | undefined;

    #rejectRunLoop: ((error: Error) => void) | undefined;

    // Like the real run loop, this settles only if the kernel dies.
    run = vi.fn(
      async () =>
        new Promise<never>((_resolve, reject) => {
          this.#rejectRunLoop = reject;
        }),
    );

    /**
     * Fail the run loop, in the order the real `KernelQueue.run` does: the
     * status flips before the rejection is observable. Does not reproduce
     * `#failRunLoop`'s rejection of in-flight subscriptions.
     *
     * @param error - The error that killed the run loop.
     */
    killRunLoop(error: Error): void {
      this.#runLoopFailure = error;
      this.#rejectRunLoop?.(error);
    }

    getRunLoopStatus = vi.fn(() =>
      this.#runLoopFailure
        ? {
            state: 'failed',
            error: this.#runLoopFailure.message,
            detail: `{"message":"${this.#runLoopFailure.message}"}`,
          }
        : { state: 'running' },
    );

    assertRunLoopAlive = vi.fn((what: string) => {
      if (this.#runLoopFailure) {
        throw new Error(`Kernel run loop died; cannot ${what}`, {
          cause: this.#runLoopFailure,
        });
      }
    });

    stop = vi.fn();

    constructor() {
      (this.constructor as typeof KernelQueue).lastInstance = this;
    }

    waitForCrank = vi.fn().mockResolvedValue(undefined);

    resolvePromises = vi.fn();
  }

  class RemoteManager {
    static lastInstance: RemoteManager;

    cleanup = vi.fn();

    isRemoteCommsInitialized = vi.fn().mockReturnValue(false);

    isIdentityInitialized = vi.fn().mockReturnValue(false);

    setMessageHandler = vi.fn();

    initIdentity = vi.fn().mockResolvedValue(undefined);

    initRemoteComms = vi.fn().mockResolvedValue(undefined);

    closeConnection = vi.fn().mockResolvedValue(undefined);

    reconnectPeer = vi.fn().mockResolvedValue(undefined);

    registerLocationHints = vi.fn().mockResolvedValue(undefined);

    getPeerId = vi.fn().mockReturnValue('mock-peer-id');

    constructor() {
      (this.constructor as typeof RemoteManager).lastInstance = this;
    }
  }

  return { KernelQueue, RemoteManager };
});

vi.mock('./KernelQueue.ts', () => {
  return { KernelQueue: mocks.KernelQueue };
});

vi.mock('./remotes/kernel/RemoteManager.ts', () => {
  return { RemoteManager: mocks.RemoteManager };
});

const makeMockVatConfig = (): VatConfig => ({
  sourceSpec: 'not-really-there.js',
});

const makeSingleVatClusterConfig = (): ClusterConfig => ({
  bootstrap: 'testVat',
  vats: {
    testVat: makeMockVatConfig(),
  },
});

const makeMockClusterConfig = (): ClusterConfig => ({
  bootstrap: 'alice',
  vats: {
    alice: {
      bundleSpec: 'http://localhost:3000/sample-vat.bundle',
      parameters: {
        name: 'Alice',
      },
    },
  },
});

describe('Kernel', () => {
  let mockPlatformServices: PlatformServices;
  let launchWorkerMock: MockInstance;
  let terminateWorkerMock: MockInstance;
  let makeVatHandleMock: MockInstance;
  let vatHandles: Mocked<VatHandle>[];
  let mockKernelDatabase: KernelDatabase;

  beforeEach(async () => {
    mockPlatformServices = {
      launch: async () =>
        ({}) as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>,
      terminate: async () => undefined,
      terminateAll: async () => undefined,
      stopRemoteComms: vi.fn(async () => undefined),
      resetAllBackoffs: vi.fn(async () => undefined),
      getListenAddresses: vi.fn(() => []),
    } as unknown as PlatformServices;

    launchWorkerMock = vi
      .spyOn(mockPlatformServices, 'launch')
      .mockResolvedValue({ end: vi.fn() } as unknown as DuplexStream<
        JsonRpcMessage,
        JsonRpcMessage
      >);
    terminateWorkerMock = vi
      .spyOn(mockPlatformServices, 'terminate')
      .mockResolvedValue(undefined);

    vatHandles = [];
    makeVatHandleMock = vi
      .spyOn(VatHandle, 'make')
      .mockImplementation(async ({ vatId, vatConfig }) => {
        const vatHandle = {
          vatId,
          config: vatConfig,
          init: vi.fn(),
          terminate: vi.fn(),
          handleMessage: vi.fn(),
          deliverMessage: vi.fn(),
          deliverNotify: vi.fn(),
          sendVatCommand: vi.fn(),
          ping: vi.fn(),
        } as unknown as VatHandle;
        vatHandles.push(vatHandle as Mocked<VatHandle>);
        return vatHandle;
      });

    mockKernelDatabase = makeMapKernelDatabase();
  });

  describe('constructor()', () => {
    it('initializes the kernel without errors', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      expect(kernel).toBeDefined();
    });

    it('honors resetStorage option and clears persistent state', async () => {
      const db = makeMapKernelDatabase();
      db.kernelKVStore.set('foo', 'bar');
      // Create with resetStorage should clear existing keys
      await Kernel.make(mockPlatformServices, db, {
        resetStorage: true,
      });
      expect(db.kernelKVStore.get('foo')).toBeUndefined();
    });
  });

  describe('init()', () => {
    it('initializes the kernel store', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
    });

    it('initializes and starts the kernel queue', async () => {
      await Kernel.make(mockPlatformServices, mockKernelDatabase);
      const queueInstance = mocks.KernelQueue.lastInstance;
      expect(queueInstance.run).toHaveBeenCalledTimes(1);
    });

    it('recovers vats from persistent storage on startup', async () => {
      const db = makeMapKernelDatabase();
      // Launch initial kernel and vat
      const kernel1 = await Kernel.make(mockPlatformServices, db);
      await kernel1.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel1.getVatIds()).toStrictEqual(['v1']);
      // Clear spies
      launchWorkerMock.mockClear();
      makeVatHandleMock.mockClear();

      // New kernel should recover existing vat immediately during make()
      const kernel2 = await Kernel.make(mockPlatformServices, db);

      // The vat should be recovered immediately
      expect(launchWorkerMock).toHaveBeenCalledOnce();
      expect(makeVatHandleMock).toHaveBeenCalledOnce();
      expect(kernel2.getVatIds()).toStrictEqual(['v1']);
    });
  });

  describe('queueMessage()', () => {
    it('enqueues a message and returns the result', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      const result = await kernel.queueMessage('ko1', 'hello', []);
      expect(result).toStrictEqual({ body: '{"result":"ok"}', slots: [] });
    });

    it('deserializes CapData rejections into Errors', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      mocks.KernelQueue.lastInstance.enqueueMessage.mockRejectedValueOnce(
        kser(new Error('vat rejection message')),
      );
      await expect(kernel.queueMessage('ko1', 'hello', [])).rejects.toThrow(
        'vat rejection message',
      );
    });

    it('propagates non-CapData rejections as-is', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const internalError = new Error('internal kernel error');
      mocks.KernelQueue.lastInstance.enqueueMessage.mockRejectedValueOnce(
        internalError,
      );
      await expect(kernel.queueMessage('ko1', 'hello', [])).rejects.toThrow(
        'internal kernel error',
      );
    });
  });

  describe('launchSubcluster()', () => {
    it('launches a subcluster according to config', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = makeMockClusterConfig();
      await kernel.launchSubcluster(config);
      expect(launchWorkerMock).toHaveBeenCalled();
      expect(makeVatHandleMock).toHaveBeenCalled();
      const status = await kernel.getStatus();
      expect(status.subclusters).toHaveLength(1);
      expect(status.subclusters[0]?.config).toStrictEqual(config);
    });

    it('throws an error for invalid configs', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      // @ts-expect-error Intentionally passing invalid config
      await expect(kernel.launchSubcluster({})).rejects.toThrow(
        'invalid cluster config',
      );
    });

    it('throws an error when bootstrap vat name is invalid', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const invalidConfig = {
        bootstrap: 'nonexistent',
        vats: {
          alice: {
            sourceSpec: 'test.js',
          },
        },
      };
      await expect(kernel.launchSubcluster(invalidConfig)).rejects.toThrow(
        'invalid bootstrap vat name',
      );
    });

    it('returns the bootstrap message result when bootstrap vat is specified', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = makeMockClusterConfig();
      const result = await kernel.launchSubcluster(config);
      expect(result).toStrictEqual({
        subclusterId: 's1',
        bootstrapResult: { body: '{"result":"ok"}', slots: [] },
        rootKref: expect.stringMatching(/^ko\d+$/u),
        vatRootKrefs: { alice: expect.stringMatching(/^ko\d+$/u) },
      });
    });
  });

  describe('terminateSubcluster()', () => {
    it('terminates all vats in a subcluster', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = {
        bootstrap: 'alice',
        vats: {
          alice: { sourceSpec: 'alice.js' },
          bob: { sourceSpec: 'bob.js' },
        },
      };
      await kernel.launchSubcluster(config);
      const { subclusters } = await kernel.getStatus();
      const [firstSubcluster] = subclusters;
      expect(firstSubcluster).toBeDefined();
      const subclusterId = firstSubcluster?.id as string;
      expect(subclusterId).toBeDefined();
      await kernel.terminateSubcluster(subclusterId);
      expect(terminateWorkerMock).toHaveBeenCalledTimes(2);
      expect(kernel.getVatIds()).toStrictEqual([]);
      expect(kernel.getSubcluster(subclusterId)).toBeUndefined();
    });

    it('throws when terminating non-existent subcluster', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await expect(kernel.terminateSubcluster('non-existent')).rejects.toThrow(
        'Subcluster does not exist.',
      );
    });
  });

  describe('getSubcluster()', () => {
    it('returns subcluster by id', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = makeMockClusterConfig();
      await kernel.launchSubcluster(config);
      const { subclusters } = await kernel.getStatus();
      const [firstSubcluster] = subclusters;
      expect(firstSubcluster).toBeDefined();
      const subclusterId = firstSubcluster?.id as string;
      expect(subclusterId).toBeDefined();
      const subcluster = kernel.getSubcluster(subclusterId);
      expect(subcluster).toBeDefined();
      expect(subcluster?.config).toStrictEqual(config);
    });

    it('returns undefined for non-existent subcluster', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      // Use valid subcluster ID format (s + number) that doesn't exist
      expect(kernel.getSubcluster('s999')).toBeUndefined();
    });
  });

  describe('isVatInSubcluster()', () => {
    it('correctly identifies vat membership in subcluster', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = makeMockClusterConfig();
      await kernel.launchSubcluster(config);
      const { subclusters } = await kernel.getStatus();
      const [firstSubcluster] = subclusters;
      expect(firstSubcluster).toBeDefined();
      const subclusterId = firstSubcluster?.id as string;
      expect(subclusterId).toBeDefined();
      expect(kernel.isVatInSubcluster('v1', subclusterId)).toBe(true);
      // Use valid subcluster ID format (s + number) that doesn't match
      expect(kernel.isVatInSubcluster('v1', 's999')).toBe(false);
    });
  });

  describe('getSubclusterVats()', () => {
    it('returns all vat IDs in a subcluster', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = {
        bootstrap: 'alice',
        vats: {
          alice: { sourceSpec: 'alice.js' },
          bob: { sourceSpec: 'bob.js' },
        },
      };
      await kernel.launchSubcluster(config);
      const { subclusters } = await kernel.getStatus();
      const [firstSubcluster] = subclusters;
      expect(firstSubcluster).toBeDefined();
      const subclusterId = firstSubcluster?.id as string;
      expect(subclusterId).toBeDefined();
      const vatIds = kernel.getSubclusterVats(subclusterId);
      expect(vatIds).toStrictEqual(['v1', 'v2']);
    });
  });

  describe('clearStorage()', () => {
    it('clears the kernel storage', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const clearSpy = vi.spyOn(mockKernelDatabase, 'clear');
      await kernel.clearStorage();
      expect(clearSpy).toHaveBeenCalledOnce();
    });
  });

  describe('getVats()', () => {
    it('returns an empty array when no vats are added', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      expect(kernel.getVats()).toStrictEqual([]);
    });

    it('returns vat information after adding vats', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = makeSingleVatClusterConfig();
      await kernel.launchSubcluster(config);
      const vats = kernel.getVats();
      expect(vats).toHaveLength(1);
      expect(vats).toStrictEqual([
        {
          id: 'v1',
          config: config.vats.testVat,
          subclusterId: 's1',
        },
      ]);
    });

    it('includes subcluster information for vats in subclusters', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = makeMockClusterConfig();
      await kernel.launchSubcluster(config);
      const { subclusters } = await kernel.getStatus();
      const [firstSubcluster] = subclusters;
      const subclusterId = firstSubcluster?.id;

      const vats = kernel.getVats();
      expect(vats).toHaveLength(1);
      expect(vats[0]?.subclusterId).toBe(subclusterId);
    });
  });

  describe('getVatIds()', () => {
    it('returns an empty array when no vats are added', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      expect(kernel.getVatIds()).toStrictEqual([]);
    });

    it('returns the vat IDs after adding a vat', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
    });

    it('returns multiple vat IDs after adding multiple vats', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel.getVatIds()).toStrictEqual(['v1', 'v2']);
    });
  });

  describe('getStatus()', () => {
    it('returns the current kernel status', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const status = await kernel.getStatus();
      expect(status).toStrictEqual({
        vats: [],
        subclusters: [],
        runLoop: { state: 'running' },
        remoteComms: {
          state: 'disconnected',
        },
      });
      // A healthy status must not race an in-flight crank.
      expect(
        mocks.KernelQueue.lastInstance.waitForCrank,
      ).toHaveBeenCalledOnce();
    });

    it('reports a run loop that dies while waiting for the crank', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const queue = mocks.KernelQueue.lastInstance;
      // An in-flight crank is exactly when the loop is most likely to die.
      queue.waitForCrank.mockImplementationOnce(async () => {
        queue.killRunLoop(new Error('died mid-crank'));
      });

      expect((await kernel.getStatus()).runLoop).toStrictEqual({
        state: 'failed',
        error: 'died mid-crank',
        detail: expect.stringContaining('died mid-crank'),
      });
    });

    it('reports the kernel as failed once the run loop dies', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect((await kernel.getStatus()).runLoop).toStrictEqual({
        state: 'running',
      });

      mocks.KernelQueue.lastInstance.killRunLoop(new Error('run loop boom'));
      await waitUntilQuiescent();

      const status = await kernel.getStatus();
      expect(status.runLoop).toStrictEqual({
        state: 'failed',
        error: 'run loop boom',
        detail: expect.stringContaining('run loop boom'),
      });
      // The vats are still in the store, but nothing is delivering to them.
      expect(status.vats).toHaveLength(1);
    });

    it('reports a failed run loop without waiting for the crank to finish', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const { waitForCrank } = mocks.KernelQueue.lastInstance;
      // A crank that never finishes, as when the run loop died mid-crank.
      waitForCrank.mockReturnValue(new Promise(() => undefined));
      mocks.KernelQueue.lastInstance.killRunLoop(new Error('run loop boom'));
      await waitUntilQuiescent();

      expect((await kernel.getStatus()).runLoop).toStrictEqual({
        state: 'failed',
        error: 'run loop boom',
        detail: expect.stringContaining('run loop boom'),
      });
    });

    it('includes vats and subclusters in status', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = makeMockClusterConfig();
      await kernel.launchSubcluster(config);
      const status = await kernel.getStatus();
      expect(status.vats).toHaveLength(1);
      expect(status.subclusters).toHaveLength(1);
      expect(status.subclusters[0]?.config).toStrictEqual(config);
      expect(status.remoteComms).toStrictEqual({
        state: 'disconnected',
      });
    });
  });

  describe('launchVat()', () => {
    it('adds a vat to the kernel without errors when no vat with the same ID exists', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(makeVatHandleMock).toHaveBeenCalledOnce();
      expect(launchWorkerMock).toHaveBeenCalled();
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
    });

    it('adds multiple vats to the kernel without errors when no vat with the same ID exists', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(makeVatHandleMock).toHaveBeenCalledTimes(2);
      expect(launchWorkerMock).toHaveBeenCalledTimes(2);
      expect(kernel.getVatIds()).toStrictEqual(['v1', 'v2']);
    });
  });

  describe('terminateVat()', () => {
    it('deletes a vat from the kernel without errors when the vat exists', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
      await kernel.terminateVat('v1');
      expect(vatHandles[0]?.terminate).toHaveBeenCalledOnce();
      expect(terminateWorkerMock).toHaveBeenCalledOnce();
      expect(kernel.getVatIds()).toStrictEqual([]);
    });

    it('throws an error when deleting a vat that does not exist in the kernel', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const nonExistentVatId: VatId = 'v9';
      await expect(async () =>
        kernel.terminateVat(nonExistentVatId),
      ).rejects.toThrow(VatNotFoundError);
      expect(vatHandles).toHaveLength(0);
    });

    it('throws an error when a vat terminate method throws', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      vatHandles[0]?.terminate.mockRejectedValueOnce('Test error');
      await expect(async () => kernel.terminateVat('v1')).rejects.toThrow(
        'Test error',
      );
    });
  });

  describe('terminateAllVats()', () => {
    it('deletes all vats from the kernel without errors', async () => {
      const workerTerminateMock = vi
        .spyOn(mockPlatformServices, 'terminate')
        .mockResolvedValue(undefined);
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel.getVatIds()).toStrictEqual(['v1', 'v2']);
      expect(vatHandles).toHaveLength(2);
      await kernel.terminateAllVats();
      expect(vatHandles[0]?.terminate).toHaveBeenCalledOnce();
      expect(vatHandles[1]?.terminate).toHaveBeenCalledOnce();
      expect(workerTerminateMock).toHaveBeenCalledTimes(2);
      expect(kernel.getVatIds()).toStrictEqual([]);
    });
  });

  describe('stop()', () => {
    it('gracefully stops the kernel without terminating vats', async () => {
      const workerTerminateAllMock = vi
        .spyOn(mockPlatformServices, 'terminateAll')
        .mockResolvedValue(undefined);
      const stopRemoteCommsMock = vi
        .spyOn(mockPlatformServices, 'stopRemoteComms')
        .mockResolvedValue(undefined);

      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const queueInstance = mocks.KernelQueue.lastInstance;
      const remoteManagerInstance = mocks.RemoteManager.lastInstance;
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel.getVatIds()).toStrictEqual(['v1']);

      // Clear any previous calls to waitForCrank from launchSubcluster
      queueInstance.waitForCrank.mockClear();

      await kernel.stop();

      // Verify vats are not terminated
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
      expect(vatHandles).toHaveLength(1);
      expect(vatHandles[0]?.terminate).not.toHaveBeenCalled();

      // Verify stop sequence
      expect(queueInstance.waitForCrank).toHaveBeenCalledOnce();
      expect(stopRemoteCommsMock).toHaveBeenCalledOnce();
      expect(remoteManagerInstance.cleanup).toHaveBeenCalledOnce();
      expect(workerTerminateAllMock).toHaveBeenCalledOnce();
    });

    it('waits for crank before stopping', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const queueInstance = mocks.KernelQueue.lastInstance;
      const waitForCrankSpy = vi.spyOn(queueInstance, 'waitForCrank');

      await kernel.stop();

      // Verify waitForCrank is called before other operations
      expect(waitForCrankSpy).toHaveBeenCalledOnce();
    });

    it('saves lastActiveTime to KV store', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );

      const before = Date.now();
      await kernel.stop();
      const after = Date.now();

      const stored = mockKernelDatabase.kernelKVStore.get('lastActiveTime');
      expect(stored).toBeDefined();
      const timestamp = Number(stored);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it('releases the vat workers even when the store refuses the timestamp', async () => {
      const workerTerminateAllMock = vi
        .spyOn(mockPlatformServices, 'terminateAll')
        .mockResolvedValue(undefined);
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      // What a driver holding a transaction it could not abort does to every
      // write, teardown's included.
      vi.spyOn(mockKernelDatabase.kernelKVStore, 'set').mockImplementation(
        () => {
          throw new Error('refusing further writes on this connection');
        },
      );

      await kernel.stop();

      expect(workerTerminateAllMock).toHaveBeenCalledOnce();
    });
  });

  describe('restartVat()', () => {
    it('preserves vat state across multiple restarts', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      await kernel.restartVat('v1');
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
      await kernel.restartVat('v1');
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
      expect(vatHandles).toHaveLength(3); // Three instances created
      expect(vatHandles[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(vatHandles[1]?.terminate).toHaveBeenCalledTimes(1);
      expect(vatHandles[2]?.terminate).not.toHaveBeenCalled();
      expect(launchWorkerMock).toHaveBeenCalledTimes(3); // initial + 2 restarts
      expect(launchWorkerMock).toHaveBeenLastCalledWith(
        'v1',
        makeMockVatConfig(),
      );
    });

    it('restarts a vat', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
      await kernel.restartVat('v1');
      expect(vatHandles[0]?.terminate).toHaveBeenCalledOnce();
      expect(terminateWorkerMock).toHaveBeenCalledOnce();
      expect(launchWorkerMock).toHaveBeenCalledTimes(2);
      expect(launchWorkerMock).toHaveBeenLastCalledWith(
        'v1',
        makeMockVatConfig(),
      );
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
      expect(makeVatHandleMock).toHaveBeenCalledTimes(2);
    });

    it('throws error when restarting non-existent vat', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await expect(kernel.restartVat('v999')).rejects.toThrow(VatNotFoundError);
      expect(vatHandles).toHaveLength(0);
      expect(launchWorkerMock).not.toHaveBeenCalled();
    });

    it('handles restart failure during termination', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      vatHandles[0]?.terminate.mockRejectedValueOnce(
        new Error('Termination failed'),
      );
      await expect(kernel.restartVat('v1')).rejects.toThrow(
        'Termination failed',
      );
      expect(launchWorkerMock).toHaveBeenCalledTimes(1);
    });

    it('handles restart failure during launch', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      launchWorkerMock.mockRejectedValueOnce(new Error('Launch failed'));
      await expect(kernel.restartVat('v1')).rejects.toThrow('Launch failed');
      expect(vatHandles[0]?.terminate).toHaveBeenCalledOnce();
      expect(kernel.getVatIds()).toStrictEqual([]);
    });

    it('returns the new vat handle', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      const originalHandle = vatHandles[0];
      const returnedHandle = await kernel.restartVat('v1');
      expect(returnedHandle).not.toBe(originalHandle);
      expect(returnedHandle).toBe(vatHandles[1]);
      expect(returnedHandle.vatId).toBe('v1');
    });
  });

  describe('pingVat()', () => {
    it('pings a vat without errors when the vat exists', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      vatHandles[0]?.ping.mockResolvedValueOnce('pong');
      const result = await kernel.pingVat('v1');
      expect(vatHandles[0]?.ping).toHaveBeenCalledTimes(1);
      expect(result).toBe('pong');
    });

    it('throws an error when pinging a vat that does not exist in the kernel', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const nonExistentVatId: VatId = 'v9';
      await expect(async () =>
        kernel.pingVat(nonExistentVatId),
      ).rejects.toThrow(VatNotFoundError);
    });

    it('propagates errors from the vat ping method', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      const pingError = new Error('Ping failed');
      vatHandles[0]?.ping.mockRejectedValueOnce(pingError);
      await expect(async () => kernel.pingVat('v1')).rejects.toThrow(pingError);
    });
  });

  describe('reset()', () => {
    it('terminates all vats and resets kernel state', async () => {
      const mockDb = makeMapKernelDatabase();
      const clearSpy = vi.spyOn(mockDb, 'clear');
      const kernel = await Kernel.make(mockPlatformServices, mockDb);
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      await kernel.reset();
      expect(clearSpy).toHaveBeenCalled();
      expect(kernel.getVatIds()).toHaveLength(0);
    });

    it('clears system subcluster roots', async () => {
      const mockDb = makeMapKernelDatabase();
      const kernel = await Kernel.make(mockPlatformServices, mockDb, {
        systemSubclusters: [
          {
            name: 'testSystemSubcluster',
            config: {
              bootstrap: 'testSystemSubcluster',
              vats: {
                testSystemSubcluster: {
                  sourceSpec: 'system-vat.js',
                },
              },
            },
          },
        ],
      });
      // Verify system subcluster bootstrap root was stored
      expect(
        kernel.getSystemSubclusterRoot('testSystemSubcluster'),
      ).toBeDefined();
      expect(kernel.getSystemSubclusterRoot('testSystemSubcluster')).toMatch(
        /^ko\d+$/u,
      );

      await kernel.reset();

      // Verify system subcluster roots are cleared
      expect(() =>
        kernel.getSystemSubclusterRoot('testSystemSubcluster'),
      ).toThrow('System subcluster "testSystemSubcluster" not found');
    });

    it('logs an error if resetting the kernel state fails', async () => {
      const mockDb = makeMapKernelDatabase();
      const logger = new Logger('test');
      const logErrorSpy = vi.spyOn(logger, 'error');
      const kernel = await Kernel.make(mockPlatformServices, mockDb, {
        logger,
      });
      await kernel.launchSubcluster(makeSingleVatClusterConfig());

      vi.spyOn(mockDb, 'clear').mockImplementationOnce(() => {
        throw new Error('test error');
      });
      await expect(kernel.reset()).rejects.toThrow('test error');
      expect(logErrorSpy).toHaveBeenCalledWith(
        'Error resetting kernel:',
        new Error('test error'),
      );
    });
  });

  describe('run loop failure', () => {
    it('logs and notifies the embedder when the run loop dies', async () => {
      const logger = new Logger('test');
      const logErrorSpy = vi.spyOn(logger, 'error');
      const onRunLoopFailure = vi.fn();
      await Kernel.make(mockPlatformServices, mockKernelDatabase, {
        logger,
        onRunLoopFailure,
      });
      const failure = new Error('run loop boom');

      mocks.KernelQueue.lastInstance.killRunLoop(failure);
      await waitUntilQuiescent();

      expect(logErrorSpy).toHaveBeenCalledWith(
        'Run loop died; the kernel can no longer process messages and must be restarted:',
        failure,
      );
      expect(onRunLoopFailure).toHaveBeenCalledWith(failure);
    });

    it('does not hand the kernel to the failure handler as its receiver', async () => {
      let gotAReceiver = true;
      await Kernel.make(mockPlatformServices, mockKernelDatabase, {
        onRunLoopFailure: function onRunLoopFailure(this: unknown): void {
          gotAReceiver = this !== undefined;
        },
      });

      mocks.KernelQueue.lastInstance.killRunLoop(new Error('run loop boom'));
      await waitUntilQuiescent();

      expect(gotAReceiver).toBe(false);
    });

    // `run` rejects with the same object its status reports, so re-wrapping here
    // would leave the embedder and `getStatus` describing two different errors.
    it('hands the embedder the error the run loop died with, unwrapped', async () => {
      const onRunLoopFailure = vi.fn();
      await Kernel.make(mockPlatformServices, mockKernelDatabase, {
        onRunLoopFailure,
      });
      const failure = new Error('run loop boom');

      mocks.KernelQueue.lastInstance.killRunLoop(failure);
      await waitUntilQuiescent();

      expect(onRunLoopFailure).toHaveBeenCalledOnce();
      expect(onRunLoopFailure.mock.calls[0]?.[0]).toBe(failure);
    });

    // The handler slot returns void, but TypeScript admits anything thenable
    // there, and an escaping rejection is what the containment exists to stop.
    it.each([
      {
        kind: 'an async handler',
        makeHandler: (handlerError: Error) => async (): Promise<never> => {
          throw handlerError;
        },
      },
      {
        kind: 'a non-native thenable',
        makeHandler: (handlerError: Error) => (): PromiseLike<void> => ({
          then: (_onFulfilled, onRejected) =>
            onRejected?.(handlerError) as PromiseLike<void>,
        }),
      },
    ])(
      'logs a failure handler that rejects, given $kind',
      async ({ makeHandler }) => {
        const logger = new Logger('test');
        const logErrorSpy = vi.spyOn(logger, 'error');
        const handlerError = new Error('handler boom');
        await Kernel.make(mockPlatformServices, mockKernelDatabase, {
          logger,
          onRunLoopFailure: makeHandler(
            handlerError,
          ) as unknown as OnRunLoopFailure,
        });

        mocks.KernelQueue.lastInstance.killRunLoop(new Error('run loop boom'));
        await waitUntilQuiescent();

        expect(logErrorSpy).toHaveBeenCalledWith(
          'Run loop failure handler rejected:',
          handlerError,
        );
      },
    );

    it('logs a failure handler that throws', async () => {
      const logger = new Logger('test');
      const logErrorSpy = vi.spyOn(logger, 'error');
      const handlerError = new Error('handler boom');
      await Kernel.make(mockPlatformServices, mockKernelDatabase, {
        logger,
        onRunLoopFailure: () => {
          throw handlerError;
        },
      });

      mocks.KernelQueue.lastInstance.killRunLoop(new Error('run loop boom'));
      await waitUntilQuiescent();

      expect(logErrorSpy).toHaveBeenCalledWith(
        'Run loop failure handler threw:',
        handlerError,
      );
    });
  });

  describe('system subcluster cleanup', () => {
    it('deletes orphaned system subclusters without starting their vats', async () => {
      const db = makeMapKernelDatabase();
      const systemSubclusterConfig = {
        name: 'testSystemSubcluster',
        config: {
          bootstrap: 'testSystemSubcluster',
          vats: {
            testSystemSubcluster: {
              sourceSpec: 'system-vat.js',
            },
          },
        },
      };

      // Create kernel with system subcluster
      const kernel1 = await Kernel.make(mockPlatformServices, db, {
        systemSubclusters: [systemSubclusterConfig],
      });
      expect(kernel1.getSubclusters()).toHaveLength(1);
      expect(kernel1.getVatIds()).toStrictEqual(['v1']);
      expect(
        kernel1.getSystemSubclusterRoot('testSystemSubcluster'),
      ).toBeDefined();

      // Stop kernel
      await kernel1.stop();

      // Clear spies to track what happens on restart
      launchWorkerMock.mockClear();
      makeVatHandleMock.mockClear();

      // Restart kernel WITHOUT the system subcluster config
      const kernel2 = await Kernel.make(mockPlatformServices, db, {
        systemSubclusters: [], // No system subclusters
      });

      // The orphaned system subcluster should have been deleted without starting vats
      expect(launchWorkerMock).not.toHaveBeenCalled();
      expect(makeVatHandleMock).not.toHaveBeenCalled();
      expect(kernel2.getSubclusters()).toHaveLength(0);
      expect(kernel2.getVatIds()).toStrictEqual([]);
      expect(() =>
        kernel2.getSystemSubclusterRoot('testSystemSubcluster'),
      ).toThrow('System subcluster "testSystemSubcluster" not found');
    });

    it('throws if persisted system subcluster has no bootstrap vat', async () => {
      const db = makeMapKernelDatabase();
      const systemSubclusterConfig = {
        name: 'testSystemSubcluster',
        config: {
          bootstrap: 'testSystemSubcluster',
          vats: {
            testSystemSubcluster: {
              sourceSpec: 'system-vat.js',
            },
          },
        },
      };

      // Create kernel with system subcluster
      const kernel1 = await Kernel.make(mockPlatformServices, db, {
        systemSubclusters: [systemSubclusterConfig],
      });
      await kernel1.stop();

      // Corrupt database: remove vats from the subcluster
      const subclustersJson = db.kernelKVStore.get('subclusters');
      const subclusters = JSON.parse(subclustersJson ?? '[]');
      subclusters[0].vats = {};
      db.kernelKVStore.set('subclusters', JSON.stringify(subclusters));

      // Restart kernel - should throw
      await expect(
        Kernel.make(mockPlatformServices, db, {
          systemSubclusters: [systemSubclusterConfig],
        }),
      ).rejects.toThrow('has no bootstrap vat - database may be corrupted');
    });

    it('throws if persisted system subcluster has no root object', async () => {
      const db = makeMapKernelDatabase();
      const systemSubclusterConfig = {
        name: 'testSystemSubcluster',
        config: {
          bootstrap: 'testSystemSubcluster',
          vats: {
            testSystemSubcluster: {
              sourceSpec: 'system-vat.js',
            },
          },
        },
      };

      // Create kernel with system subcluster
      const kernel1 = await Kernel.make(mockPlatformServices, db, {
        systemSubclusters: [systemSubclusterConfig],
      });
      await kernel1.stop();

      // Corrupt database: delete the root object entry for the vat
      // Root object is stored at: ${vatId}.c.o+0
      db.kernelKVStore.delete('v1.c.o+0');

      // Restart kernel - should throw
      await expect(
        Kernel.make(mockPlatformServices, db, {
          systemSubclusters: [systemSubclusterConfig],
        }),
      ).rejects.toThrow('has no root object - database may be corrupted');
    });
  });

  describe('revoke and isRevoked', () => {
    it('reflect when an object is revoked', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel.isRevoked('ko1')).toBe(false);
      kernel.revoke('ko1');
      expect(kernel.isRevoked('ko1')).toBe(true);
    });

    it('throws when revoking a promise', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(() => kernel.revoke('kp1')).toThrow(Error);
    });
  });

  describe('pinVatRoot and unpinVatRoot', () => {
    it('pins and unpins a vat root correctly', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const config = makeSingleVatClusterConfig();
      await kernel.launchSubcluster(config);
      // Pinning existing vat root should return the kref
      expect(kernel.pinVatRoot('v1')).toBe('ko4');
      // Pinning non-existent vat should throw
      expect(() => kernel.pinVatRoot('v2')).toThrow(VatNotFoundError);
      // Unpinning existing vat root should succeed
      expect(() => kernel.unpinVatRoot('v1')).not.toThrow();
      // Unpinning non-existent vat should throw
      expect(() => kernel.unpinVatRoot('v3')).toThrow(VatNotFoundError);
    });
  });

  describe('remote communications', () => {
    describe('closeConnection()', () => {
      it('closes connection via RemoteManager', async () => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          mockKernelDatabase,
        );
        const remoteManagerInstance = mocks.RemoteManager.lastInstance;
        await kernel.closeConnection('peer-123');
        expect(remoteManagerInstance.closeConnection).toHaveBeenCalledWith(
          'peer-123',
        );
      });
    });

    describe('reconnectPeer()', () => {
      it('reconnects peer via RemoteManager with hints', async () => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          mockKernelDatabase,
        );
        const remoteManagerInstance = mocks.RemoteManager.lastInstance;
        await kernel.reconnectPeer('peer-456', [
          '/dns4/relay.example/tcp/443/wss/p2p/relayPeer',
        ]);
        expect(remoteManagerInstance.reconnectPeer).toHaveBeenCalledWith(
          'peer-456',
          ['/dns4/relay.example/tcp/443/wss/p2p/relayPeer'],
        );
      });

      it('reconnects peer with empty hints when hints not provided', async () => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          mockKernelDatabase,
        );
        const remoteManagerInstance = mocks.RemoteManager.lastInstance;
        await kernel.reconnectPeer('peer-789');
        expect(remoteManagerInstance.reconnectPeer).toHaveBeenCalledWith(
          'peer-789',
          [],
        );
      });
    });

    describe('registerLocationHints()', () => {
      it('registers location hints via RemoteManager', async () => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          mockKernelDatabase,
        );
        const remoteManagerInstance = mocks.RemoteManager.lastInstance;
        await kernel.registerLocationHints('peer-123', [
          '/ip4/192.168.1.1/udp/4001/quic-v1/p2p/peer-123',
        ]);
        expect(
          remoteManagerInstance.registerLocationHints,
        ).toHaveBeenCalledWith('peer-123', [
          '/ip4/192.168.1.1/udp/4001/quic-v1/p2p/peer-123',
        ]);
      });
    });
  });
});
