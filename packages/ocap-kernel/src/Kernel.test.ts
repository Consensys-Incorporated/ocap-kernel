import { makePromiseKit } from '@endo/promise-kit';
import { VatNotFoundError } from '@metamask/kernel-errors';
import type { KernelDatabase } from '@metamask/kernel-store';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { delay, waitUntilQuiescent } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import type { Mocked, MockInstance } from 'vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Kernel } from './Kernel.ts';
import { kser } from './liveslots/kernel-marshal.ts';
import type {
  VatConfig,
  OnRunLoopFailure,
  PlatformServices,
  ClusterConfig,
  CrankResult,
  EndpointId,
  RunLoopItem,
  RunQueueItem,
  SubclusterId,
} from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { asKRef, asSubclusterId, asVatId } from '../test/branded.ts';
import { KernelServiceManager } from './KernelServiceManager.ts';
import { makeMapKernelDatabase } from '../test/storage.ts';

const mocks = vi.hoisted(() => {
  class KernelQueue {
    static lastInstance: KernelQueue;

    enqueueMessage = vi
      .fn()
      .mockResolvedValue({ body: '{"result":"ok"}', slots: [] });

    #runLoopFailure: Error | undefined;

    #rejectRunLoop: ((error: Error) => void) | undefined;

    /**
     * The router's dispatch, so queued work can be carried out as a crank
     * would carry it out.
     */
    #deliver: ((item: RunLoopItem) => Promise<unknown>) | undefined;

    #endRunLoop: (() => void) | undefined;

    #running = false;

    #stopped = false;

    // Like the real run loop, this settles only when the kernel dies or
    // `endRunLoop` ends it, and `getRunLoopStatus` reports which.
    run = vi.fn(
      async (
        deliver: (item: RunLoopItem) => Promise<unknown>,
        _options?: { isOffline?: (endpointId: EndpointId) => boolean },
      ) => {
        this.#deliver = deliver;
        this.#running = true;
        return new Promise<void>((resolve, reject) => {
          this.#rejectRunLoop = reject;
          this.#endRunLoop = resolve;
        });
      },
    );

    recheckGCActions = vi.fn();

    /**
     * Fail the run loop, in the order the real `KernelQueue.run` does: the
     * status flips before the rejection is observable. Does not reproduce
     * `#failRunLoop`'s rejection of in-flight subscriptions.
     *
     * @param error - The error that killed the run loop.
     */
    killRunLoop(error: Error): void {
      this.#runLoopFailure = error;
      this.#running = false;
      this.#rejectRunLoop?.(error);
      for (const reject of this.#runLoopDeathWaiters) {
        reject(error);
      }
      this.#runLoopDeathWaiters.clear();
    }

    getRunLoopStatus = vi.fn(() => {
      if (this.#runLoopFailure) {
        return {
          state: 'failed',
          error: this.#runLoopFailure.message,
          detail: `{"message":"${this.#runLoopFailure.message}"}`,
        };
      }
      if (this.#stopped) {
        return { state: 'stopped' };
      }
      return { state: this.#running ? 'running' : 'idle' };
    });

    // Delivered at once through the router, standing in for the operation's
    // crank; a throw kills the run loop, as it would there.
    enqueueControl = vi.fn(async (operation: string) => {
      if (this.#runLoopFailure) {
        throw new Error(`Kernel run loop died; cannot ${operation}`);
      }
      if (this.#stopped) {
        throw new Error(`Kernel run loop is stopped; cannot ${operation}`);
      }
      try {
        await this.#deliver?.({ type: 'control', operation } as RunLoopItem);
      } catch (error) {
        this.killRunLoop(error as Error);
        throw error;
      }
    });

    // Ends a running loop at once, standing in for the real one ending
    // between cranks.
    endRunLoop = vi.fn(async () => {
      if (this.#running) {
        this.#running = false;
        this.#stopped = true;
        this.#endRunLoop?.();
      }
    });

    discardArrivals = vi.fn();

    abandonSubscriptions = vi.fn();

    // A stand-in for the run loop: the item is delivered through the router,
    // on a later turn, exactly as a crank would deliver it.
    enqueueRestartVat = vi.fn((vatId: string) => {
      this.#deliverLater({ type: 'restartVat', vatId } as RunQueueItem);
    });

    discardHeldRequests = vi.fn();

    enqueueTerminateVat = vi.fn((vatId: string, reason?: unknown) => {
      this.#deliverLater({
        type: 'terminateVat',
        vatId,
        ...(reason ? { reason } : {}),
      } as RunQueueItem);
    });

    /**
     * @param item - The queued item to hand to the router on a later turn.
     */
    #deliverLater(item: RunQueueItem): void {
      queueMicrotask(() => {
        this.#runCrank(item).catch((error: unknown) => {
          throw error;
        });
      });
    }

    /**
     * Deliver an item and run what follows its commit, as a crank does. No
     * test here aborts one.
     *
     * @param item - The item to deliver.
     */
    async #runCrank(item: RunQueueItem): Promise<void> {
      const crankResult = (await this.#deliver?.(item)) as
        | CrankResult
        | undefined;
      await crankResult?.afterCommit?.();
    }

    onRunLoopDeath = vi.fn((reject: (error: Error) => void) => {
      this.#runLoopDeathWaiters.add(reject);
      return () => {
        this.#runLoopDeathWaiters.delete(reject);
      };
    });

    readonly #runLoopDeathWaiters = new Set<(error: Error) => void>();

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

    writeOutsideCrank = vi.fn(async (write: () => unknown) => write());

    resolvePromises = vi.fn();
  }

  class RemoteManager {
    static lastInstance: RemoteManager;

    cleanup = vi.fn();

    isRemoteCommsInitialized = vi.fn().mockReturnValue(false);

    isIdentityInitialized = vi.fn().mockReturnValue(false);

    setMessageHandler = vi.fn();

    applyIncarnationChange = vi.fn().mockReturnValue({});

    releaseRestartHolds = vi.fn();

    initIdentity = vi.fn().mockResolvedValue(undefined);

    initRemoteComms = vi.fn().mockResolvedValue(undefined);

    hasRemote = vi.fn().mockReturnValue(false);

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
          terminate: vi.fn().mockResolvedValue(undefined),
          expectClose: vi.fn(),
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

    it('registers the kernel services it is given before the run loop starts', async () => {
      const register = vi.spyOn(
        KernelServiceManager.prototype,
        'registerKernelServiceObject',
      );
      const service = { chat: vi.fn() };
      const db = makeMapKernelDatabase();

      await Kernel.make(mockPlatformServices, db, {
        kernelServices: [{ name: 'languageModelService', service }],
      });

      const call = register.mock.calls.findIndex(
        ([name]) => name === 'languageModelService',
      );
      expect(call).not.toBe(-1);
      expect(register.mock.invocationCallOrder[call]).toBeLessThan(
        mocks.KernelQueue.lastInstance.run.mock.invocationCallOrder[0] ?? 0,
      );
      expect(
        db.kernelKVStore.get('kernelService.languageModelService'),
      ).toBeDefined();
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
      const result = await kernel.queueMessage(asKRef('ko1'), 'hello', []);
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
      await expect(
        kernel.queueMessage(asKRef('ko1'), 'hello', []),
      ).rejects.toThrow('vat rejection message');
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
      await expect(
        kernel.queueMessage(asKRef('ko1'), 'hello', []),
      ).rejects.toThrow('internal kernel error');
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
      const subclusterId = firstSubcluster?.id as SubclusterId;
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
      await expect(
        kernel.terminateSubcluster('non-existent' as SubclusterId),
      ).rejects.toThrow('Subcluster does not exist.');
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
      const subclusterId = firstSubcluster?.id as SubclusterId;
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
      expect(kernel.getSubcluster(asSubclusterId('s999'))).toBeUndefined();
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
      const subclusterId = firstSubcluster?.id as SubclusterId;
      expect(subclusterId).toBeDefined();
      expect(kernel.isVatInSubcluster(asVatId('v1'), subclusterId)).toBe(true);
      // Use valid subcluster ID format (s + number) that doesn't match
      expect(
        kernel.isVatInSubcluster(asVatId('v1'), asSubclusterId('s999')),
      ).toBe(false);
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
      const subclusterId = firstSubcluster?.id as SubclusterId;
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
    it.each([
      { method: 'clearStorage', message: 'Kernel storage was cleared' },
      { method: 'reset', message: 'Kernel was reset' },
      { method: 'stop', message: 'Kernel was stopped' },
    ] as const)(
      'rejects a queued termination on $method',
      async ({ method, message }) => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          mockKernelDatabase,
        );
        await kernel.launchSubcluster(makeSingleVatClusterConfig());
        mocks.KernelQueue.lastInstance.enqueueTerminateVat.mockImplementationOnce(
          () => undefined,
        );

        const terminating = kernel.terminateVat(asVatId('v1'));
        await kernel[method]();

        await expect(terminating).rejects.toThrow(message);
      },
    );

    it('asks the run loop to terminate the vat', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());

      await kernel.terminateVat(asVatId('v1'));

      expect(
        mocks.KernelQueue.lastInstance.enqueueTerminateVat,
      ).toHaveBeenCalledWith('v1', undefined);
    });

    it('deletes a vat from the kernel without errors when the vat exists', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
      await kernel.terminateVat(asVatId('v1'));
      expect(vatHandles[0]?.terminate).toHaveBeenCalledOnce();
      expect(terminateWorkerMock).toHaveBeenCalledOnce();
      expect(kernel.getVatIds()).toStrictEqual([]);
    });

    it('throws an error when deleting a vat that does not exist in the kernel', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const nonExistentVatId = asVatId('v9');
      await expect(async () =>
        kernel.terminateVat(nonExistentVatId),
      ).rejects.toThrow(VatNotFoundError);
      expect(vatHandles).toHaveLength(0);
    });

    it('terminates a vat whose channel will not close', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      vatHandles[0]?.terminate.mockRejectedValueOnce('Test error');

      await kernel.terminateVat(asVatId('v1'));

      expect(kernel.getVatIds()).toStrictEqual([]);
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

      await kernel.stop();

      // Verify vats are not terminated
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
      expect(vatHandles).toHaveLength(1);
      expect(vatHandles[0]?.terminate).not.toHaveBeenCalled();

      // Verify stop sequence
      expect(queueInstance.endRunLoop).toHaveBeenCalledOnce();
      expect(stopRemoteCommsMock).toHaveBeenCalledOnce();
      expect(remoteManagerInstance.cleanup).toHaveBeenCalledOnce();
      expect(workerTerminateAllMock).toHaveBeenCalledOnce();
    });

    it('tells each vat its channel is closing only once the run loop has ended', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      const { endRunLoop } = mocks.KernelQueue.lastInstance;
      const end = endRunLoop.getMockImplementation();
      const loopEnds = makePromiseKit<void>();
      endRunLoop.mockImplementationOnce(async () => {
        await loopEnds.promise;
        return end?.();
      });

      const stopping = kernel.stop();
      await delay(0);
      const closingEarly = vatHandles[0]?.expectClose.mock.calls.length;
      loopEnds.resolve();
      await stopping;

      expect({
        closingEarly,
        closing: vatHandles[0]?.expectClose.mock.calls.length,
      }).toStrictEqual({ closingEarly: 0, closing: 1 });
    });

    it('tells each vat its channel is closing before stopping remote comms', async () => {
      const stopRemoteCommsMock = vi
        .spyOn(mockPlatformServices, 'stopRemoteComms')
        .mockResolvedValue(undefined);
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());

      await kernel.stop();

      const [expectClose] =
        vatHandles[0]?.expectClose.mock.invocationCallOrder ?? [];
      const [stopRemoteComms] = stopRemoteCommsMock.mock.invocationCallOrder;
      expect(expectClose).toBeLessThan(stopRemoteComms as number);
    });

    it('tears nothing down until the run loop has ended', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const { endRunLoop } = mocks.KernelQueue.lastInstance;
      const end = endRunLoop.getMockImplementation();
      const loopEnds = makePromiseKit<void>();
      endRunLoop.mockImplementationOnce(async () => {
        await loopEnds.promise;
        return end?.();
      });
      const closeSpy = vi.spyOn(mockKernelDatabase, 'close');

      const stopping = kernel.stop();
      await delay(0);
      const closedEarly = closeSpy.mock.calls.length;
      loopEnds.resolve();
      await stopping;

      expect({
        closedEarly,
        closed: closeSpy.mock.calls.length,
      }).toStrictEqual({ closedEarly: 0, closed: 1 });
    });

    it('tears down the rest even when stopping remote comms fails', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      vi.spyOn(mockPlatformServices, 'stopRemoteComms').mockRejectedValueOnce(
        new Error('transport stuck'),
      );
      const terminateAllSpy = vi.spyOn(mockPlatformServices, 'terminateAll');
      const closeSpy = vi.spyOn(mockKernelDatabase, 'close');

      await expect(kernel.stop()).rejects.toThrow('transport stuck');
      expect({
        cleanup: mocks.RemoteManager.lastInstance.cleanup.mock.calls.length,
        terminateAll: terminateAllSpy.mock.calls.length,
        close: closeSpy.mock.calls.length,
      }).toStrictEqual({ cleanup: 1, terminateAll: 1, close: 1 });
    });

    it('tears down even when the run loop dies before it ends', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      const queueInstance = mocks.KernelQueue.lastInstance;
      queueInstance.endRunLoop.mockImplementationOnce(async () => {
        queueInstance.killRunLoop(new Error('died first'));
      });
      const terminateAllSpy = vi.spyOn(mockPlatformServices, 'terminateAll');
      const closeSpy = vi.spyOn(mockKernelDatabase, 'close');

      await kernel.stop();

      expect({
        closing: vatHandles[0]?.expectClose.mock.calls.length,
        terminateAll: terminateAllSpy.mock.calls.length,
        close: closeSpy.mock.calls.length,
      }).toStrictEqual({ closing: 1, terminateAll: 1, close: 1 });
    });

    it('rejects what still waits once the run loop has ended', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const { endRunLoop, discardArrivals, abandonSubscriptions } =
        mocks.KernelQueue.lastInstance;

      await kernel.stop();

      expect(discardArrivals).toHaveBeenCalledOnce();
      expect(abandonSubscriptions).toHaveBeenCalledExactlyOnceWith(
        new Error(
          'Kernel was stopped before this message was answered; one still queued is delivered on its next start',
        ),
      );
      const endedAt = endRunLoop.mock.invocationCallOrder[0] as number;
      expect(endedAt).toBeLessThan(
        discardArrivals.mock.invocationCallOrder[0] as number,
      );
      expect(endedAt).toBeLessThan(
        abandonSubscriptions.mock.invocationCallOrder[0] as number,
      );
    });

    it('settles a second stop with the first', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const closeSpy = vi.spyOn(mockKernelDatabase, 'close');

      await Promise.all([kernel.stop(), kernel.stop()]);
      await kernel.stop();

      expect({
        ends: mocks.KernelQueue.lastInstance.endRunLoop.mock.calls.length,
        closes: closeSpy.mock.calls.length,
      }).toStrictEqual({ ends: 1, closes: 1 });
    });

    it('settles a stop after a failed one with the same failure', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const terminateAllSpy = vi
        .spyOn(mockPlatformServices, 'terminateAll')
        .mockRejectedValueOnce(new Error('worker would not die'));

      await expect(kernel.stop()).rejects.toThrow('worker would not die');
      await expect(kernel.stop()).rejects.toThrow('worker would not die');
      expect(terminateAllSpy).toHaveBeenCalledOnce();
    });

    it('runs every teardown step, and reports each one that fails', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const transport = new Error('transport stuck');
      const cleanup = new Error('cleanup failed');
      const worker = new Error('worker would not die');
      vi.spyOn(mockPlatformServices, 'stopRemoteComms').mockRejectedValueOnce(
        transport,
      );
      mocks.RemoteManager.lastInstance.cleanup.mockImplementationOnce(() => {
        throw cleanup;
      });
      vi.spyOn(mockPlatformServices, 'terminateAll').mockRejectedValueOnce(
        worker,
      );
      const closeSpy = vi.spyOn(mockKernelDatabase, 'close');

      const failure = await kernel.stop().catch((error: unknown) => error);

      expect({
        failure: failure instanceof AggregateError,
        message: (failure as AggregateError).message,
        errors: (failure as AggregateError).errors,
        closes: closeSpy.mock.calls.length,
      }).toStrictEqual({
        failure: true,
        message:
          'Kernel stop failed in stopRemoteComms, remote cleanup, terminateAll',
        errors: [transport, cleanup, worker],
        closes: 1,
      });
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

    it('releases everything even if the timestamp cannot be written', async () => {
      const stopRemoteCommsMock = vi
        .spyOn(mockPlatformServices, 'stopRemoteComms')
        .mockResolvedValue(undefined);
      const workerTerminateAllMock = vi
        .spyOn(mockPlatformServices, 'terminateAll')
        .mockResolvedValue(undefined);
      const closeSpy = vi.spyOn(mockKernelDatabase, 'close');
      const logger = new Logger('test');
      const logErrorSpy = vi.spyOn(logger, 'error');
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
        { logger },
      );
      const refusal = new Error('refusing further writes on this connection');
      vi.spyOn(mockKernelDatabase.kernelKVStore, 'set').mockImplementation(
        () => {
          throw refusal;
        },
      );

      await kernel.stop();

      expect(stopRemoteCommsMock).toHaveBeenCalledOnce();
      expect(workerTerminateAllMock).toHaveBeenCalledOnce();
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(logErrorSpy).toHaveBeenCalledWith(
        'could not record last active time',
        refusal,
      );
    });
  });

  describe('control operations', () => {
    it.each(['clearStorage', 'reset', 'terminateAllVats'] as const)(
      'hands %s to the run loop',
      async (method) => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          makeMapKernelDatabase(),
        );

        await kernel[method]();

        expect(
          mocks.KernelQueue.lastInstance.enqueueControl,
        ).toHaveBeenCalledExactlyOnceWith(method);
      },
    );

    it.each([
      {
        method: 'clearStorage',
        abandoned: 'Kernel storage was cleared; queued work was abandoned',
      },
      {
        method: 'reset',
        abandoned: 'Kernel was reset; queued work was abandoned',
      },
    ] as const)(
      'abandons the queued and held work on $method, then releases the restart holds',
      async ({ method, abandoned }) => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          makeMapKernelDatabase(),
        );
        const { discardArrivals, abandonSubscriptions, discardHeldRequests } =
          mocks.KernelQueue.lastInstance;
        const { releaseRestartHolds } = mocks.RemoteManager.lastInstance;

        await kernel[method]();

        expect(discardArrivals).toHaveBeenCalledOnce();
        expect(abandonSubscriptions).toHaveBeenCalledExactlyOnceWith(
          new Error(abandoned),
        );
        expect(discardHeldRequests).toHaveBeenCalledExactlyOnceWith(
          new Error(abandoned),
        );
        expect(
          discardArrivals.mock.invocationCallOrder[0] as number,
        ).toBeLessThan(
          releaseRestartHolds.mock.invocationCallOrder[0] as number,
        );
      },
    );

    it.each([
      {
        method: 'clearStorage',
        fail: () =>
          vi.spyOn(mockKernelDatabase, 'clear').mockImplementationOnce(() => {
            throw new Error('test error');
          }),
      },
      {
        method: 'reset',
        fail: () =>
          vi.spyOn(mockKernelDatabase, 'clear').mockImplementationOnce(() => {
            throw new Error('test error');
          }),
      },
      {
        method: 'terminateAllVats',
        fail: () =>
          vi
            .spyOn(mockKernelDatabase.kernelKVStore, 'set')
            .mockImplementation(() => {
              throw new Error('test error');
            }),
      },
    ] as const)(
      'kills the run loop when $method fails partway',
      async ({ method, fail }) => {
        const onRunLoopFailure = vi.fn();
        const kernel = await Kernel.make(
          mockPlatformServices,
          mockKernelDatabase,
          { onRunLoopFailure },
        );
        await kernel.launchSubcluster(makeSingleVatClusterConfig());
        fail();

        await expect(kernel[method]()).rejects.toThrow('test error');
        await delay(0);

        expect({
          state: mocks.KernelQueue.lastInstance.getRunLoopStatus().state,
          reported: onRunLoopFailure.mock.calls[0]?.[0]?.message,
        }).toStrictEqual({ state: 'failed', reported: 'test error' });
      },
    );

    it('refuses one once the run loop has died, leaving the store as it was', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      mocks.KernelQueue.lastInstance.killRunLoop(new Error('died earlier'));
      const clearSpy = vi.spyOn(mockKernelDatabase, 'clear');

      await expect(kernel.reset()).rejects.toThrow(
        'Kernel run loop died; cannot reset',
      );
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('refuses one once the kernel has stopped', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.stop();

      await expect(kernel.clearStorage()).rejects.toThrow(
        'Kernel run loop is stopped; cannot clearStorage',
      );
    });
  });

  describe('restartVat()', () => {
    it('restarts a vat', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());

      const returnedHandle = await kernel.restartVat(asVatId('v1'));

      expect(
        mocks.KernelQueue.lastInstance.enqueueRestartVat,
      ).toHaveBeenCalledWith('v1');
      expect(vatHandles[0]?.terminate).toHaveBeenCalledOnce();
      expect(terminateWorkerMock).toHaveBeenCalledOnce();
      expect(launchWorkerMock).toHaveBeenCalledTimes(2);
      expect(kernel.getVatIds()).toStrictEqual(['v1']);
      expect(returnedHandle).toBe(vatHandles[1]);
    });

    it('rejects its caller when the run loop dies first', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      const queue = mocks.KernelQueue.lastInstance;
      queue.enqueueRestartVat.mockImplementationOnce(() => undefined);

      const restarting = kernel.restartVat(asVatId('v1'));
      queue.killRunLoop(new Error('run loop boom'));

      await expect(restarting).rejects.toThrow('run loop boom');
    });

    it.each([
      { method: 'clearStorage', message: 'Kernel storage was cleared' },
      { method: 'reset', message: 'Kernel was reset' },
      { method: 'stop', message: 'Kernel was stopped' },
    ] as const)(
      'rejects a queued restart on $method',
      async ({ method, message }) => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          mockKernelDatabase,
        );
        await kernel.launchSubcluster(makeSingleVatClusterConfig());
        mocks.KernelQueue.lastInstance.enqueueRestartVat.mockImplementationOnce(
          () => undefined,
        );

        const restarting = kernel.restartVat(asVatId('v1'));
        await kernel[method]();

        await expect(restarting).rejects.toThrow(message);
      },
    );

    it('throws error when restarting non-existent vat', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await expect(kernel.restartVat(asVatId('v999'))).rejects.toThrow(
        VatNotFoundError,
      );
      expect(vatHandles).toHaveLength(0);
      expect(launchWorkerMock).not.toHaveBeenCalled();
      expect(
        mocks.KernelQueue.lastInstance.enqueueRestartVat,
      ).not.toHaveBeenCalled();
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
      const result = await kernel.pingVat(asVatId('v1'));
      expect(vatHandles[0]?.ping).toHaveBeenCalledTimes(1);
      expect(result).toBe('pong');
    });

    it('throws an error when pinging a vat that does not exist in the kernel', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      const nonExistentVatId = asVatId('v9');
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
      await expect(async () => kernel.pingVat(asVatId('v1'))).rejects.toThrow(
        pingError,
      );
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

    it('closes the IO listeners of every subcluster', async () => {
      const listener = {
        accept: vi.fn(async () => null),
        close: vi.fn(async () => undefined),
      };
      const kernel = await Kernel.make(
        mockPlatformServices,
        makeMapKernelDatabase(),
        { ioListenerFactory: async () => listener },
      );
      await kernel.launchSubcluster({
        ...makeSingleVatClusterConfig(),
        io: { repl: { type: 'console' } },
      });

      await kernel.reset();

      expect(listener.close).toHaveBeenCalledOnce();
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

    it('kills the run loop if resetting the kernel state fails', async () => {
      const mockDb = makeMapKernelDatabase();
      const kernel = await Kernel.make(mockPlatformServices, mockDb);
      await kernel.launchSubcluster(makeSingleVatClusterConfig());

      vi.spyOn(mockDb, 'clear').mockImplementationOnce(() => {
        throw new Error('test error');
      });
      await expect(kernel.reset()).rejects.toThrow('test error');
      expect((await kernel.getStatus()).runLoop.state).toBe('failed');
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
            onRejected?.(handlerError) as PromiseLike<never>,
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
      expect(kernel.isRevoked(asKRef('ko1'))).toBe(false);
      kernel.revoke(asKRef('ko1'));
      expect(kernel.isRevoked(asKRef('ko1'))).toBe(true);
    });

    it('throws when revoking a promise', async () => {
      const kernel = await Kernel.make(
        mockPlatformServices,
        mockKernelDatabase,
      );
      await kernel.launchSubcluster(makeSingleVatClusterConfig());
      expect(() => kernel.revoke(asKRef('kp1'))).toThrow(Error);
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
      expect(kernel.pinVatRoot(asVatId('v1'))).toBe('ko4');
      // Pinning non-existent vat should throw
      expect(() => kernel.pinVatRoot(asVatId('v2'))).toThrow(VatNotFoundError);
      // Unpinning existing vat root should succeed
      expect(() => kernel.unpinVatRoot(asVatId('v1'))).not.toThrow();
      // Unpinning non-existent vat should throw
      expect(() => kernel.unpinVatRoot(asVatId('v3'))).toThrow(
        VatNotFoundError,
      );
    });
  });

  describe('remote communications', () => {
    it('hands a peer incarnation change to the remote manager', async () => {
      await Kernel.make(mockPlatformServices, mockKernelDatabase);
      const deliver = mocks.KernelQueue.lastInstance.run.mock.calls[0]?.[0];
      const change = {
        type: 'peerIncarnation',
        peerId: 'peer-1',
        incarnation: 'incarnation-B',
        restart: true,
      } as const;

      expect(await deliver?.(change)).toStrictEqual({});
      expect(
        mocks.RemoteManager.lastInstance.applyIncarnationChange,
      ).toHaveBeenCalledWith(change);
    });

    it('holds GC actions back for a remote with no handle', async () => {
      await Kernel.make(mockPlatformServices, mockKernelDatabase);
      mocks.RemoteManager.lastInstance.hasRemote.mockImplementation(
        (remoteId: string) => remoteId === 'r2',
      );
      const isOffline =
        mocks.KernelQueue.lastInstance.run.mock.calls[0]?.[1]?.isOffline;

      expect(
        (['r1', 'r2', 'v1'] as EndpointId[]).map((endpointId) =>
          isOffline?.(endpointId),
        ),
      ).toStrictEqual([true, false, false]);
    });

    describe('initRemoteComms()', () => {
      it('wakes the run loop for GC actions once the remotes are up', async () => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          mockKernelDatabase,
        );
        let remotesUp = false;
        mocks.RemoteManager.lastInstance.initRemoteComms.mockImplementationOnce(
          async () => {
            await Promise.resolve();
            remotesUp = true;
          },
        );
        const remotesUpAtRecheck: boolean[] = [];
        mocks.KernelQueue.lastInstance.recheckGCActions.mockImplementationOnce(
          () => remotesUpAtRecheck.push(remotesUp),
        );

        await kernel.initRemoteComms();

        expect(remotesUpAtRecheck).toStrictEqual([true]);
      });

      it('wakes the run loop even when restoring the remotes fails', async () => {
        const kernel = await Kernel.make(
          mockPlatformServices,
          mockKernelDatabase,
        );
        mocks.RemoteManager.lastInstance.initRemoteComms.mockRejectedValueOnce(
          new Error('restore failed'),
        );

        await expect(kernel.initRemoteComms()).rejects.toThrow(
          'restore failed',
        );
        expect(
          mocks.KernelQueue.lastInstance.recheckGCActions,
        ).toHaveBeenCalledOnce();
      });
    });

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
