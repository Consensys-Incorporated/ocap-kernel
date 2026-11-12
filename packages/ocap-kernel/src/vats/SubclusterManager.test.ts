import type { CapData } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import { SubclusterNotFoundError } from '@metamask/kernel-errors';
import { Logger } from '@metamask/logger';
import type { Mock, Mocked } from 'vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { KernelQueue } from '../KernelQueue.ts';
import { kser } from '../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  VatId,
  KRef,
  ClusterConfig,
  InboxOutcome,
  Subcluster,
  SubclusterId,
  SystemSubclusterConfig,
} from '../types.ts';
import { SubclusterManager } from './SubclusterManager.ts';
import type { VatManager } from './VatManager.ts';
import { asKRef, asSubclusterId, asVatId } from '../../test/branded.ts';

const s1 = asSubclusterId('s1');

describe('SubclusterManager', () => {
  let mockKernelStore: Mocked<KernelStore>;
  let mockKernelQueue: Mocked<KernelQueue>;
  let mockVatManager: Mocked<VatManager>;
  let mockGetKernelService: (
    name: string,
  ) => { kref: KRef; systemOnly: boolean } | undefined;
  let mockWriteMessage: Mock<KernelQueue['writeMessage']>;
  let subclusterManager: SubclusterManager;
  // Whether a vat has a handle until it is stopped, and the vats that have
  // been: what `hasVat` and `isVatActive` read.
  let vatsRunning: boolean;
  let retiredVats: Set<string>;
  /** How the inbox work the manager handed the kernel queue ended, in order. */
  let outcomes: InboxOutcome<unknown>[];
  /** Whether the kernel queue is running inbox work, as a crank would. */
  let inCrank: boolean;

  const createMockClusterConfig = (name = 'test'): ClusterConfig => ({
    bootstrap: `${name}Vat`,
    vats: {
      [`${name}Vat`]: {
        sourceSpec: `${name}.js`,
      },
    },
  });

  const makeMockIOManager = () => ({
    createChannels: vi.fn().mockResolvedValue(undefined),
    destroyChannels: vi.fn().mockResolvedValue(undefined),
  });

  const createMockSubcluster = (
    id: SubclusterId,
    config: ClusterConfig,
  ): Subcluster => ({
    id,
    config,
    vats: {
      [`${config.bootstrap}`]: asVatId('v1'),
      vat2: asVatId('v2'),
    },
  });

  beforeEach(() => {
    vatsRunning = false;
    retiredVats = new Set();
    outcomes = [];
    inCrank = false;
    mockKernelStore = {
      addSubcluster: vi.fn().mockReturnValue('s1'),
      getSubcluster: vi.fn(),
      getSubclusters: vi.fn().mockReturnValue([]),
      getSubclusterVats: vi.fn().mockReturnValue([]),
      isVatActive: vi.fn((vatId: string) => !retiredVats.has(vatId)),
      deleteSubcluster: vi.fn(),
      getVatSubcluster: vi.fn().mockReturnValue('s1'),
      getAllSystemSubclusterMappings: vi.fn().mockReturnValue(new Map()),
      deleteSystemSubclusterMapping: vi.fn(),
      setSystemSubclusterMapping: vi.fn(),
      getRootObject: vi.fn(),
      deleteVatConfig: vi.fn(),
      markVatAsTerminated: vi.fn(),
    } as unknown as Mocked<KernelStore>;

    mockWriteMessage = vi.fn<KernelQueue['writeMessage']>(() => ({
      answer: Promise.resolve({ body: '{"result":"ok"}', slots: [] }),
    }));
    mockKernelQueue = {
      writeMessage: mockWriteMessage,
      // Runs the work at once, as the queue does before its run loop starts,
      // and keeps its outcome, since nothing here can roll a crank back.
      enqueueInbox: vi.fn(async (_what: string, work: () => unknown) => {
        inCrank = true;
        let outcome: InboxOutcome<unknown>;
        try {
          outcome = (await work()) as InboxOutcome<unknown>;
        } finally {
          inCrank = false;
        }
        outcomes.push(outcome);
        if ('failure' in outcome) {
          throw outcome.failure;
        }
        return outcome.value;
      }),
    } as unknown as Mocked<KernelQueue>;

    mockVatManager = {
      launchVat: vi.fn().mockResolvedValue('ko1'),
      stopVat: vi.fn(async (vatId: string) => {
        retiredVats.add(vatId);
      }),
      collectGarbage: vi.fn(),
      terminateAllVats: vi.fn().mockResolvedValue(undefined),
      hasVat: vi.fn((vatId: string) => vatsRunning && !retiredVats.has(vatId)),
      releaseVatRootPin: vi.fn(),
    } as unknown as Mocked<VatManager>;

    mockGetKernelService = vi.fn().mockReturnValue(undefined) as unknown as (
      name: string,
    ) => { kref: KRef; systemOnly: boolean } | undefined;

    subclusterManager = new SubclusterManager({
      kernelStore: mockKernelStore,
      kernelQueue: mockKernelQueue,
      vatManager: mockVatManager,
      getKernelService: mockGetKernelService,
    });
  });

  /**
   * @returns A manager with an IO manager, and that IO manager.
   */
  const makeManagerWithIO = () => {
    const ioManager = makeMockIOManager();
    const manager = new SubclusterManager({
      kernelStore: mockKernelStore,
      kernelQueue: mockKernelQueue,
      vatManager: mockVatManager,
      getKernelService: mockGetKernelService,
      ioManager: ioManager as never,
    });
    return { manager, ioManager };
  };

  const ioConfig: ClusterConfig = {
    bootstrap: 'testVat',
    vats: { testVat: { sourceSpec: 'test.js' } },
    io: {
      repl: { type: 'socket', path: '/tmp/repl.sock' },
    },
  };

  describe('constructor', () => {
    it('initializes with provided options', () => {
      expect(subclusterManager).toBeDefined();
    });
  });

  describe('launchSubcluster', () => {
    it('launches a subcluster in a crank of its own', async () => {
      const config = createMockClusterConfig();
      let writtenInCrank: boolean | undefined;
      mockWriteMessage.mockImplementation(() => {
        writtenInCrank = inCrank;
        return {
          answer: Promise.resolve({ body: '{"result":"ok"}', slots: [] }),
        };
      });

      const result = await subclusterManager.launchSubcluster(config);

      expect(mockKernelQueue.enqueueInbox).toHaveBeenCalledExactlyOnceWith(
        'launch a subcluster',
        expect.any(Function),
      );
      expect(mockKernelStore.addSubcluster).toHaveBeenCalledWith(config);
      expect(mockVatManager.launchVat).toHaveBeenCalledWith(
        config.vats.testVat,
        'testVat',
        's1',
      );
      // The bootstrap message targets the real root KRef once all vats have
      // launched.
      expect(mockWriteMessage).toHaveBeenCalledWith('ko1', 'bootstrap', [
        { testVat: expect.anything() },
        {},
      ]);
      expect(writtenInCrank).toBe(true);
      expect(result).toStrictEqual({
        subclusterId: 's1',
        rootKref: 'ko1',
        bootstrapResult: { body: '{"result":"ok"}', slots: [] },
        vatRootKrefs: { testVat: 'ko1' },
      });
    });

    it('launches subcluster with multiple vats', async () => {
      const config: ClusterConfig = {
        bootstrap: 'alice',
        vats: {
          alice: { sourceSpec: 'alice.js' },
          bob: { sourceSpec: 'bob.js' },
        },
      };
      mockVatManager.launchVat
        .mockResolvedValueOnce('ko1' as KRef)
        .mockResolvedValueOnce('ko2' as KRef);

      await subclusterManager.launchSubcluster(config);

      expect(mockVatManager.launchVat).toHaveBeenCalledTimes(2);
      expect(mockVatManager.launchVat).toHaveBeenCalledWith(
        config.vats.alice,
        'alice',
        's1',
      );
      expect(mockVatManager.launchVat).toHaveBeenCalledWith(
        config.vats.bob,
        'bob',
        's1',
      );
      expect(mockWriteMessage).toHaveBeenCalledWith('ko1', 'bootstrap', [
        { alice: expect.anything(), bob: expect.anything() },
        {},
      ]);
    });

    it('rolls the launch back when a peer vat fails to launch, stopping the workers that started', async () => {
      const config: ClusterConfig = {
        bootstrap: 'alice',
        vats: {
          alice: { sourceSpec: 'alice.js' },
          bob: { sourceSpec: 'bob.js' },
        },
      };
      const bobError = new Error('bob exploded');
      mockVatManager.launchVat
        .mockResolvedValueOnce('ko1' as KRef)
        .mockRejectedValueOnce(bobError);
      mockKernelStore.getSubclusterVats.mockReturnValue([
        'v1',
        'v2',
      ] as VatId[]);
      // Alice's worker is running; bob's never started.
      vatsRunning = true;
      retiredVats.add('v2');

      await expect(subclusterManager.launchSubcluster(config)).rejects.toBe(
        bobError,
      );

      expect(mockWriteMessage).not.toHaveBeenCalled();
      expect(mockVatManager.stopVat).toHaveBeenCalledExactlyOnceWith(
        'v1',
        true,
      );
      expect(outcomes).toStrictEqual([{ abort: true, failure: bobError }]);
    });

    it('rolls the launch back when the bootstrap vat fails to launch', async () => {
      mockVatManager.launchVat.mockRejectedValueOnce(new Error('boom'));

      await expect(
        subclusterManager.launchSubcluster(createMockClusterConfig()),
      ).rejects.toThrow('boom');

      expect(mockVatManager.stopVat).not.toHaveBeenCalled();
      expect(outcomes).toStrictEqual([
        { abort: true, failure: new Error('boom') },
      ]);
    });

    it("lets a fault in a failed launch's cleanup reach the run loop", async () => {
      mockVatManager.launchVat.mockRejectedValueOnce(new Error('boom'));
      mockKernelStore.getSubclusterVats.mockImplementation(() => {
        throw new Error('store unreadable');
      });

      await expect(
        subclusterManager.launchSubcluster(createMockClusterConfig()),
      ).rejects.toThrow('store unreadable');

      expect(outcomes).toStrictEqual([]);
    });

    it('stops every started member before a fault in stopping one reaches the run loop, naming the launch failure', async () => {
      const launchFailure = new Error('carol exploded');
      const stopFailure = new Error('SQLITE_FULL');
      mockVatManager.launchVat.mockRejectedValueOnce(launchFailure);
      mockKernelStore.getSubclusterVats.mockReturnValue([
        'v1',
        'v2',
      ] as VatId[]);
      vatsRunning = true;
      mockVatManager.stopVat.mockRejectedValueOnce(stopFailure);

      const error = (await subclusterManager
        .launchSubcluster(createMockClusterConfig())
        .catch((reason: unknown) => reason)) as AggregateError;

      expect({
        stopped: mockVatManager.stopVat.mock.calls.map(([vatId]) => vatId),
        errors: error.errors,
        cause: error.cause,
        outcomes,
      }).toStrictEqual({
        stopped: ['v2', 'v1'],
        errors: [stopFailure],
        cause: launchFailure,
        outcomes: [],
      });
    });

    it("writes a system subcluster's name with its record", async () => {
      await subclusterManager.launchSubcluster(createMockClusterConfig(), {
        isSystem: true,
        systemName: 'sys',
      });

      expect(mockKernelStore.setSystemSubclusterMapping).toHaveBeenCalledWith(
        'sys',
        's1',
      );
    });

    it('includes unrestricted kernel services when specified', async () => {
      const config: ClusterConfig = {
        bootstrap: 'testVat',
        vats: {
          testVat: { sourceSpec: 'test.js' },
        },
        services: ['testService'],
      };
      (mockGetKernelService as ReturnType<typeof vi.fn>).mockReturnValue({
        kref: 'ko99',
        systemOnly: false,
      });

      await subclusterManager.launchSubcluster(config);

      expect(mockGetKernelService).toHaveBeenCalledWith('testService');
      expect(mockWriteMessage).toHaveBeenCalledWith('ko1', 'bootstrap', [
        expect.anything(),
        { testService: expect.anything() },
      ]);
    });

    it('passes a service named __proto__ as an own property', async () => {
      const config: ClusterConfig = {
        bootstrap: 'testVat',
        vats: {
          testVat: { sourceSpec: 'test.js' },
        },
        services: ['__proto__'],
      };
      (mockGetKernelService as ReturnType<typeof vi.fn>).mockReturnValue({
        kref: 'ko99',
        systemOnly: false,
      });

      await subclusterManager.launchSubcluster(config);

      const [, services] = (mockWriteMessage as ReturnType<typeof vi.fn>).mock
        .calls[0]![2] as [unknown, object];
      expect(Object.getPrototypeOf(services)).toBe(Object.prototype);
      expect(Object.keys(services)).toStrictEqual(['__proto__']);
    });

    it('throws when user subcluster requests a restricted service', async () => {
      const config: ClusterConfig = {
        bootstrap: 'testVat',
        vats: {
          testVat: { sourceSpec: 'test.js' },
        },
        services: ['kernelFacet'],
      };
      (mockGetKernelService as ReturnType<typeof vi.fn>).mockReturnValue({
        kref: 'ko99',
        systemOnly: true,
      });

      await expect(subclusterManager.launchSubcluster(config)).rejects.toThrow(
        "no registered kernel service 'kernelFacet'",
      );
    });

    it('allows system subcluster to access restricted services', async () => {
      const config: ClusterConfig = {
        bootstrap: 'testVat',
        vats: {
          testVat: { sourceSpec: 'test.js' },
        },
        services: ['kernelFacet'],
      };
      (mockGetKernelService as ReturnType<typeof vi.fn>).mockReturnValue({
        kref: 'ko99',
        systemOnly: true,
      });

      await subclusterManager.launchSubcluster(config, { isSystem: true });

      expect(mockGetKernelService).toHaveBeenCalledWith('kernelFacet');
      expect(mockWriteMessage).toHaveBeenCalledWith('ko1', 'bootstrap', [
        expect.anything(),
        { kernelFacet: expect.anything() },
      ]);
    });

    it.each([
      ['invalid cluster config', {} as ClusterConfig, 'invalid cluster config'],
      [
        'invalid bootstrap vat name',
        {
          bootstrap: 'nonexistent',
          vats: { alice: { sourceSpec: 'alice.js' } },
        } as ClusterConfig,
        'invalid bootstrap vat name',
      ],
      [
        'a vat name that shadows a built-in',
        {
          bootstrap: 'alice',
          vats: {
            alice: { sourceSpec: 'alice.js' },
            constructor: { sourceSpec: 'c.js' },
          },
        } as ClusterConfig,
        'invalid vat name',
      ],
    ])('refuses %s before asking the run loop', async (_, config, reason) => {
      await expect(subclusterManager.launchSubcluster(config)).rejects.toThrow(
        reason,
      );

      expect(mockKernelQueue.enqueueInbox).not.toHaveBeenCalled();
    });

    it('throws when kernel service not found', async () => {
      const config: ClusterConfig = {
        bootstrap: 'testVat',
        vats: {
          testVat: { sourceSpec: 'test.js' },
        },
        services: ['unknownService'],
      };
      (mockGetKernelService as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      await expect(subclusterManager.launchSubcluster(config)).rejects.toThrow(
        "no registered kernel service 'unknownService'",
      );
    });

    it('destroys the IO channels and rolls back on validation failure', async () => {
      const { manager, ioManager } = makeManagerWithIO();
      (mockGetKernelService as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      await expect(
        manager.launchSubcluster({ ...ioConfig, services: ['unknownService'] }),
      ).rejects.toThrow("no registered kernel service 'unknownService'");

      expect(ioManager.destroyChannels).toHaveBeenCalledWith('s1');
      expect(outcomes.map((outcome) => outcome.abort)).toStrictEqual([true]);
    });

    it('destroys the IO channels and rolls back on vat launch failure', async () => {
      const { manager, ioManager } = makeManagerWithIO();
      mockVatManager.launchVat.mockRejectedValue(new Error('vat boom'));
      // Service lookup happens before vat launch, so the IO channel service
      // must be registered for the test to reach the vat launch step.
      (mockGetKernelService as ReturnType<typeof vi.fn>).mockReturnValue({
        kref: 'ko99',
        systemOnly: false,
      });

      await expect(manager.launchSubcluster(ioConfig)).rejects.toThrow(
        'vat boom',
      );

      expect(ioManager.destroyChannels).toHaveBeenCalledWith('s1');
      expect(outcomes.map((outcome) => outcome.abort)).toStrictEqual([true]);
    });

    it('rolls back when createChannels fails', async () => {
      const { manager, ioManager } = makeManagerWithIO();
      ioManager.createChannels.mockRejectedValue(
        new Error('channel creation failed'),
      );

      await expect(manager.launchSubcluster(ioConfig)).rejects.toThrow(
        'channel creation failed',
      );

      expect(ioManager.destroyChannels).toHaveBeenCalledWith('s1');
      expect(outcomes.map((outcome) => outcome.abort)).toStrictEqual([true]);
    });

    it('does not mask the original error when destroyChannels fails during rollback', async () => {
      const { manager, ioManager } = makeManagerWithIO();
      ioManager.destroyChannels.mockRejectedValue(new Error('cleanup boom'));
      mockVatManager.launchVat.mockRejectedValue(new Error('launch boom'));
      (mockGetKernelService as ReturnType<typeof vi.fn>).mockReturnValue({
        kref: 'ko99',
        systemOnly: false,
      });

      await expect(manager.launchSubcluster(ioConfig)).rejects.toThrow(
        'launch boom',
      );

      expect(outcomes.map((outcome) => outcome.abort)).toStrictEqual([true]);
    });

    it('throws when config declares IO but no IO manager is provided', async () => {
      await expect(
        subclusterManager.launchSubcluster(ioConfig),
      ).rejects.toThrow('no IO channel factory was provided');

      expect(outcomes.map((outcome) => outcome.abort)).toStrictEqual([true]);
    });

    it('throws when launchVat returns undefined', async () => {
      const config: ClusterConfig = {
        bootstrap: 'testVat',
        vats: {
          testVat: { sourceSpec: 'test.js' },
        },
      };
      // Simulate launchVat returning undefined (which shouldn't happen normally)
      mockVatManager.launchVat.mockResolvedValue(undefined as unknown as KRef);

      await expect(subclusterManager.launchSubcluster(config)).rejects.toThrow(
        'no launch result for bootstrap vat',
      );
    });

    it('returns bootstrap result when bootstrap does not return error', async () => {
      const config = createMockClusterConfig();
      const bootstrapResult = {
        body: '{"error":"Bootstrap failed"}',
        slots: [],
      };
      mockWriteMessage.mockReturnValue({
        answer: Promise.resolve(bootstrapResult),
      });

      // Note: We can't easily mock kunser since it's imported at module level
      // kunser doesn't return an Error for this body, so launchSubcluster succeeds
      const result = await subclusterManager.launchSubcluster(config);
      expect(result).toStrictEqual({
        subclusterId: 's1',
        rootKref: 'ko1',
        bootstrapResult,
        vatRootKrefs: { testVat: 'ko1' },
      });
    });

    describe('bootstrap failure propagation', () => {
      beforeEach(() => {
        // The subcluster the launch wrote, for its termination to find.
        mockKernelStore.getSubcluster.mockReturnValue(
          createMockSubcluster(s1, createMockClusterConfig()),
        );
        vatsRunning = true;
      });

      it('rejects with the underlying error when the bootstrap message rejects, and terminates the subcluster', async () => {
        const config = createMockClusterConfig();
        mockWriteMessage.mockImplementation(() => {
          // The kernel rejects an answer with the serialized error.
          const { promise, reject } = makePromiseKit<CapData<KRef>>();
          reject(kser(new Error('vat failed to build root object')));
          return { answer: promise };
        });

        await expect(
          subclusterManager.launchSubcluster(config),
        ).rejects.toThrow('vat failed to build root object');

        expect(
          vi
            .mocked(mockKernelQueue.enqueueInbox)
            .mock.calls.map(([what]) => what),
        ).toStrictEqual(['launch a subcluster', 'terminate a subcluster']);
        expect(mockKernelStore.deleteSubcluster).toHaveBeenCalledWith('s1');
      });

      it('rethrows when the bootstrap message resolves to a serialized error', async () => {
        const config = createMockClusterConfig();
        mockWriteMessage.mockReturnValue({
          answer: Promise.resolve(kser(new Error('bootstrap threw'))),
        });

        await expect(
          subclusterManager.launchSubcluster(config),
        ).rejects.toThrow('bootstrap threw');

        expect(mockKernelStore.deleteSubcluster).toHaveBeenCalledWith('s1');
      });

      it('reports the bootstrap failure when the termination fails too', async () => {
        const config = createMockClusterConfig();
        mockWriteMessage.mockImplementation(() => ({
          answer: Promise.reject(new Error('bootstrap threw')),
        }));
        mockVatManager.stopVat.mockRejectedValue(new Error('SQLITE_FULL'));

        await expect(
          subclusterManager.launchSubcluster(config),
        ).rejects.toThrow('bootstrap threw');
      });
    });
  });

  describe('terminateSubcluster', () => {
    it('stops every member and deletes the record, in a crank of its own', async () => {
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      vatsRunning = true;

      await subclusterManager.terminateSubcluster(s1);

      expect(mockKernelQueue.enqueueInbox).toHaveBeenCalledExactlyOnceWith(
        'terminate a subcluster',
        expect.any(Function),
      );
      expect(mockVatManager.stopVat.mock.calls).toStrictEqual([
        ['v2', true],
        ['v1', true],
      ]);
      expect(mockVatManager.collectGarbage).toHaveBeenCalledTimes(2);
      expect(mockKernelStore.deleteSubcluster).toHaveBeenCalledWith('s1');
    });

    it('retires a member the kernel has no handle for', async () => {
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      subcluster.vats = { testVat: asVatId('v1') };
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      vatsRunning = false;

      await subclusterManager.terminateSubcluster(s1);

      expect(mockVatManager.stopVat).toHaveBeenCalledWith('v1', true);
      expect(mockKernelStore.deleteSubcluster).toHaveBeenCalledWith('s1');
    });

    it('skips a member with neither a handle nor a record', async () => {
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      subcluster.vats = { testVat: asVatId('v1') };
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      // Retired by a crank before this one.
      retiredVats.add('v1');

      await subclusterManager.terminateSubcluster(s1);

      expect(mockVatManager.stopVat).not.toHaveBeenCalled();
      expect(mockKernelStore.deleteSubcluster).toHaveBeenCalledWith('s1');
    });

    it('drops the system name the subcluster was recorded under', async () => {
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['sys', s1]]),
      );

      await subclusterManager.terminateSubcluster(s1);

      expect(
        mockKernelStore.deleteSystemSubclusterMapping,
      ).toHaveBeenCalledWith('sys');
    });

    it("lets a fault in a member's death reach the run loop", async () => {
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      vatsRunning = true;
      mockVatManager.stopVat.mockRejectedValueOnce(new Error('SQLITE_FULL'));

      await expect(subclusterManager.terminateSubcluster(s1)).rejects.toThrow(
        'SQLITE_FULL',
      );

      expect(mockKernelStore.deleteSubcluster).not.toHaveBeenCalled();
    });

    it('destroys the IO channels, going on when that fails', async () => {
      const { manager, ioManager } = makeManagerWithIO();
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      ioManager.destroyChannels.mockRejectedValue(new Error('socket busy'));

      await manager.terminateSubcluster(s1);

      expect(ioManager.destroyChannels).toHaveBeenCalledWith('s1');
      expect(mockKernelStore.deleteSubcluster).toHaveBeenCalledWith('s1');
    });

    it('rejects a subcluster that is not found, with the crank committed', async () => {
      mockKernelStore.getSubcluster.mockReturnValue(undefined);

      await expect(
        subclusterManager.terminateSubcluster('nonexistent' as SubclusterId),
      ).rejects.toThrow(SubclusterNotFoundError);

      expect(outcomes.map((outcome) => outcome.abort)).toStrictEqual([
        undefined,
      ]);
    });

    it('handles empty vat list', async () => {
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      subcluster.vats = {};
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);

      await subclusterManager.terminateSubcluster(s1);

      expect(mockVatManager.stopVat).not.toHaveBeenCalled();
      expect(mockKernelStore.deleteSubcluster).toHaveBeenCalledWith('s1');
    });
  });

  describe('getSubcluster', () => {
    it('returns subcluster when found', () => {
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);

      const result = subclusterManager.getSubcluster(s1);

      expect(result).toStrictEqual(subcluster);
      expect(mockKernelStore.getSubcluster).toHaveBeenCalledWith('s1');
    });

    it('returns undefined when not found', () => {
      mockKernelStore.getSubcluster.mockReturnValue(undefined);

      const result = subclusterManager.getSubcluster(
        'nonexistent' as SubclusterId,
      );

      expect(result).toBeUndefined();
    });
  });

  describe('getSubclusters', () => {
    it('returns all subclusters', () => {
      const subclusters = [
        createMockSubcluster(s1, createMockClusterConfig('test1')),
        createMockSubcluster(
          asSubclusterId('s2'),
          createMockClusterConfig('test2'),
        ),
      ];
      mockKernelStore.getSubclusters.mockReturnValue(subclusters);

      const result = subclusterManager.getSubclusters();

      expect(result).toStrictEqual(subclusters);
      expect(mockKernelStore.getSubclusters).toHaveBeenCalled();
    });

    it('returns empty array when no subclusters', () => {
      mockKernelStore.getSubclusters.mockReturnValue([]);

      const result = subclusterManager.getSubclusters();

      expect(result).toStrictEqual([]);
    });
  });

  describe('isVatInSubcluster', () => {
    it('returns true when vat is in subcluster', () => {
      mockKernelStore.getVatSubcluster.mockReturnValue(s1);

      const result = subclusterManager.isVatInSubcluster(asVatId('v1'), s1);

      expect(result).toBe(true);
      expect(mockKernelStore.getVatSubcluster).toHaveBeenCalledWith('v1');
    });

    it('returns false when vat is not in subcluster', () => {
      mockKernelStore.getVatSubcluster.mockReturnValue(asSubclusterId('s2'));

      const result = subclusterManager.isVatInSubcluster(asVatId('v1'), s1);

      expect(result).toBe(false);
    });

    it('returns false when vat has no subcluster', () => {
      // @ts-expect-error mock
      mockKernelStore.getVatSubcluster.mockReturnValue(undefined);

      const result = subclusterManager.isVatInSubcluster(asVatId('v1'), s1);

      expect(result).toBe(false);
    });
  });

  describe('getSubclusterVats', () => {
    it('returns vat IDs for subcluster', () => {
      const vatIds = ['v1', 'v2', 'v3'] as VatId[];
      mockKernelStore.getSubclusterVats.mockReturnValue(vatIds);

      const result = subclusterManager.getSubclusterVats(s1);

      expect(result).toStrictEqual(vatIds);
      expect(mockKernelStore.getSubclusterVats).toHaveBeenCalledWith('s1');
    });

    it('returns empty array when no vats', () => {
      mockKernelStore.getSubclusterVats.mockReturnValue([]);

      const result = subclusterManager.getSubclusterVats(s1);

      expect(result).toStrictEqual([]);
    });
  });

  describe('initSystemSubclusters', () => {
    const makeSystemConfig = (name: string): SystemSubclusterConfig => ({
      name,
      config: createMockClusterConfig(name),
    });

    it('validates no duplicate names', () => {
      const configs = [makeSystemConfig('dup'), makeSystemConfig('dup')];

      expect(() => subclusterManager.initSystemSubclusters(configs)).toThrow(
        'Duplicate system subcluster names in config',
      );
    });

    it('accepts configs with no persisted mappings', () => {
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(new Map());

      subclusterManager.initSystemSubclusters([makeSystemConfig('sys1')]);

      expect(mockKernelStore.getAllSystemSubclusterMappings).toHaveBeenCalled();
    });

    it('deletes orphaned system subclusters no longer in config', () => {
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['orphan', s1]]),
      );
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);

      // Pass empty configs - the persisted "orphan" is not in config
      subclusterManager.initSystemSubclusters([]);

      expect(mockKernelStore.deleteVatConfig).toHaveBeenCalled();
      expect(mockKernelStore.markVatAsTerminated).toHaveBeenCalled();
      expect(mockKernelStore.deleteSubcluster).toHaveBeenCalledWith('s1');
      expect(
        mockKernelStore.deleteSystemSubclusterMapping,
      ).toHaveBeenCalledWith('orphan');
      // These vats never ran here, so nothing else releases the root pin the
      // incarnation that did run them took.
      for (const vatId of Object.values(subcluster.vats)) {
        expect(mockVatManager.releaseVatRootPin).toHaveBeenCalledWith(vatId);
      }
    });

    it('restores valid persisted system subclusters', () => {
      const config = createMockClusterConfig('sys');
      const subcluster = createMockSubcluster(s1, config);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['sys', s1]]),
      );
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      mockKernelStore.getRootObject.mockReturnValue(asKRef('ko1'));

      subclusterManager.initSystemSubclusters([makeSystemConfig('sys')]);

      expect(subclusterManager.getSystemSubclusterRoot('sys')).toBe('ko1');
    });

    it('cleans up mapping when subcluster no longer exists', () => {
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['sys', asSubclusterId('s99')]]),
      );
      mockKernelStore.getSubcluster.mockReturnValue(undefined);

      subclusterManager.initSystemSubclusters([makeSystemConfig('sys')]);

      expect(
        mockKernelStore.deleteSystemSubclusterMapping,
      ).toHaveBeenCalledWith('sys');
    });

    it('restores no root for a system subcluster with no bootstrap vat, and goes on', () => {
      const s2 = asSubclusterId('s2');
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([
          ['sys', s1],
          ['kept', s2],
        ]),
      );
      mockKernelStore.getSubcluster.mockImplementation((id) =>
        id === s1
          ? {
              id,
              config: createMockClusterConfig('sys'),
              vats: { vat2: asVatId('v2') },
            }
          : createMockSubcluster(id, createMockClusterConfig('kept')),
      );
      mockKernelStore.getRootObject.mockReturnValue(asKRef('ko1'));

      subclusterManager.initSystemSubclusters([
        makeSystemConfig('sys'),
        makeSystemConfig('kept'),
      ]);

      expect(() => subclusterManager.getSystemSubclusterRoot('sys')).toThrow(
        'System subcluster "sys" not found',
      );
      expect({
        keptRoot: subclusterManager.getSystemSubclusterRoot('kept'),
        mappingDeleted:
          mockKernelStore.deleteSystemSubclusterMapping.mock.calls,
      }).toStrictEqual({ keptRoot: 'ko1', mappingDeleted: [] });
    });

    it('throws when persisted system subcluster has no root object', () => {
      const config = createMockClusterConfig('sys');
      const subcluster = createMockSubcluster(s1, config);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['sys', s1]]),
      );
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      mockKernelStore.getRootObject.mockReturnValue(undefined);

      expect(() =>
        subclusterManager.initSystemSubclusters([makeSystemConfig('sys')]),
      ).toThrow('has no root object - database may be corrupted');
    });
  });

  describe('removeSystemSubclustersWithoutBootstrapVat', () => {
    const config: ClusterConfig = {
      bootstrap: 'boot',
      vats: {
        boot: { sourceSpec: 'boot.js' },
        alice: { sourceSpec: 'alice.js' },
        bob: { sourceSpec: 'bob.js' },
      },
    };

    /**
     * Make a manager with an IO manager, over system subclusters restored with
     * their bootstrap vats, which the boot may then have lost.
     *
     * @param after - By system name, each subcluster's vats as the boot left
     *   them. The first is `s1`, the second `s2`.
     * @returns The manager and its IO manager.
     */
    const makeRestoredManager = (
      after: Record<string, Record<string, VatId>>,
    ) => {
      const ioManager = makeMockIOManager();
      const logger = new Logger('test');
      vi.spyOn(logger, 'error').mockReturnValue();
      vi.spyOn(logger, 'info').mockReturnValue();
      const manager = new SubclusterManager({
        kernelStore: mockKernelStore,
        kernelQueue: mockKernelQueue,
        vatManager: mockVatManager,
        getKernelService: mockGetKernelService,
        ioManager: ioManager as never,
        logger,
      });
      const names = Object.keys(after);
      const idOf = (name: string): SubclusterId =>
        asSubclusterId(`s${names.indexOf(name) + 1}`);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map(names.map((name) => [name, idOf(name)])),
      );
      mockKernelStore.getSubcluster.mockImplementation((id) => ({
        id,
        config,
        vats: { boot: asVatId('v1') },
      }));
      mockKernelStore.getRootObject.mockReturnValue(asKRef('ko1'));
      manager.initSystemSubclusters(names.map((name) => ({ name, config })));
      mockKernelStore.getSubcluster.mockImplementation((id) => {
        const name = names.find((candidate) => idOf(candidate) === id);
        return name === undefined
          ? undefined
          : { id, config, vats: after[name] ?? {} };
      });
      return { manager, ioManager, logger };
    };

    it('removes a system subcluster whose bootstrap vat is gone, with its other vats', async () => {
      const { manager, ioManager, logger } = makeRestoredManager({
        sys: { alice: asVatId('v2'), bob: asVatId('v3') },
      });

      await manager.removeSystemSubclustersWithoutBootstrapVat();

      expect({
        stopped: mockVatManager.stopVat.mock.calls,
        channelsDestroyed: ioManager.destroyChannels.mock.calls,
        recordDeleted: mockKernelStore.deleteSubcluster.mock.calls,
        mappingDeleted:
          mockKernelStore.deleteSystemSubclusterMapping.mock.calls,
      }).toStrictEqual({
        stopped: [
          ['v3', true],
          ['v2', true],
        ],
        channelsDestroyed: [['s1']],
        recordDeleted: [['s1']],
        mappingDeleted: [['sys']],
      });
      expect(() => manager.getSystemSubclusterRoot('sys')).toThrow(
        'System subcluster "sys" not found',
      );
      expect(logger.error).toHaveBeenCalledWith(
        'System subcluster "sys" lost its bootstrap vat; launching it again from its config',
      );
    });

    it('removes every system subcluster that lost its bootstrap vat', async () => {
      const { manager } = makeRestoredManager({
        first: { alice: asVatId('v2') },
        second: { bob: asVatId('v3') },
      });

      await manager.removeSystemSubclustersWithoutBootstrapVat();

      expect({
        stopped: mockVatManager.stopVat.mock.calls,
        recordDeleted: mockKernelStore.deleteSubcluster.mock.calls,
        mappingDeleted:
          mockKernelStore.deleteSystemSubclusterMapping.mock.calls,
      }).toStrictEqual({
        stopped: [
          ['v2', true],
          ['v3', true],
        ],
        recordDeleted: [['s1'], ['s2']],
        mappingDeleted: [['first'], ['second']],
      });
    });

    it('leaves a system subcluster that has its bootstrap vat, and removes one that does not', async () => {
      const { manager } = makeRestoredManager({
        kept: { boot: asVatId('v1') },
        lost: { alice: asVatId('v2') },
      });

      await manager.removeSystemSubclustersWithoutBootstrapVat();

      expect({
        stopped: mockVatManager.stopVat.mock.calls,
        recordDeleted: mockKernelStore.deleteSubcluster.mock.calls,
        mappingDeleted:
          mockKernelStore.deleteSystemSubclusterMapping.mock.calls,
        keptRoot: manager.getSystemSubclusterRoot('kept'),
      }).toStrictEqual({
        stopped: [['v2', true]],
        recordDeleted: [['s2']],
        mappingDeleted: [['lost']],
        keptRoot: 'ko1',
      });
    });

    it('skips a member that has neither a handle nor a record', async () => {
      const { manager } = makeRestoredManager({
        sys: { alice: asVatId('v2'), bob: asVatId('v3') },
      });
      retiredVats.add('v3');

      await manager.removeSystemSubclustersWithoutBootstrapVat();

      expect(mockVatManager.stopVat.mock.calls).toStrictEqual([['v2', true]]);
      expect(mockKernelStore.deleteSubcluster).toHaveBeenCalledWith('s1');
    });

    it('removes the record even when its IO channels will not close', async () => {
      const { manager, ioManager } = makeRestoredManager({ sys: {} });
      ioManager.destroyChannels.mockRejectedValueOnce(new Error('EBUSY'));

      await manager.removeSystemSubclustersWithoutBootstrapVat();

      expect({
        recordDeleted: mockKernelStore.deleteSubcluster.mock.calls,
        mappingDeleted:
          mockKernelStore.deleteSystemSubclusterMapping.mock.calls,
      }).toStrictEqual({ recordDeleted: [['s1']], mappingDeleted: [['sys']] });
    });

    it('drops the name of a system subcluster whose record is gone', async () => {
      const { manager } = makeRestoredManager({ sys: {} });
      mockKernelStore.getSubcluster.mockReturnValue(undefined);

      await manager.removeSystemSubclustersWithoutBootstrapVat();

      expect({
        stopped: mockVatManager.stopVat.mock.calls,
        mappingDeleted:
          mockKernelStore.deleteSystemSubclusterMapping.mock.calls,
      }).toStrictEqual({ stopped: [], mappingDeleted: [['sys']] });
      expect(() => manager.getSystemSubclusterRoot('sys')).toThrow(
        'System subcluster "sys" not found',
      );
    });

    it('keeps the record when a member cannot be terminated', async () => {
      const { manager } = makeRestoredManager({
        sys: { alice: asVatId('v2') },
      });
      const storeFault = new Error('disk I/O error');
      mockVatManager.stopVat.mockRejectedValueOnce(storeFault);

      await expect(
        manager.removeSystemSubclustersWithoutBootstrapVat(),
      ).rejects.toBe(storeFault);

      expect(mockKernelStore.deleteSubcluster).not.toHaveBeenCalled();
      expect(
        mockKernelStore.deleteSystemSubclusterMapping,
      ).not.toHaveBeenCalled();
    });
  });

  describe('launchNewSystemSubclusters', () => {
    const makeSystemConfig = (name: string): SystemSubclusterConfig => ({
      name,
      config: createMockClusterConfig(name),
    });

    it('launches configs not already restored from persistence', async () => {
      // First restore a persisted subcluster
      const config = createMockClusterConfig('existing');
      const subcluster = createMockSubcluster(s1, config);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['existing', s1]]),
      );
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      mockKernelStore.getRootObject.mockReturnValue('ko-existing' as KRef);

      subclusterManager.initSystemSubclusters([
        makeSystemConfig('existing'),
        makeSystemConfig('newOne'),
      ]);

      // Now launch new ones — "existing" should be skipped
      mockKernelStore.addSubcluster.mockReturnValue(asSubclusterId('s2'));
      await subclusterManager.launchNewSystemSubclusters([
        makeSystemConfig('existing'),
        makeSystemConfig('newOne'),
      ]);

      // launchVat should have been called once for the new subcluster
      expect(mockVatManager.launchVat).toHaveBeenCalledOnce();
      expect(mockKernelStore.setSystemSubclusterMapping).toHaveBeenCalledWith(
        'newOne',
        's2',
      );
    });

    it('does nothing when all configs are already restored', async () => {
      const config = createMockClusterConfig('sys');
      const subcluster = createMockSubcluster(s1, config);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['sys', s1]]),
      );
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      mockKernelStore.getRootObject.mockReturnValue(asKRef('ko1'));

      subclusterManager.initSystemSubclusters([makeSystemConfig('sys')]);

      await subclusterManager.launchNewSystemSubclusters([
        makeSystemConfig('sys'),
      ]);

      expect(mockVatManager.launchVat).not.toHaveBeenCalled();
    });

    it('persists mappings for newly launched subclusters', async () => {
      mockKernelStore.addSubcluster.mockReturnValue(s1);

      await subclusterManager.launchNewSystemSubclusters([
        makeSystemConfig('newSys'),
      ]);

      expect(mockKernelStore.setSystemSubclusterMapping).toHaveBeenCalledWith(
        'newSys',
        's1',
      );
      expect(subclusterManager.getSystemSubclusterRoot('newSys')).toBe('ko1');
    });
  });

  describe('getSystemSubclusterRoot', () => {
    it('returns kref for a known system subcluster', () => {
      // Set up state via initSystemSubclusters
      const config = createMockClusterConfig('sys');
      const subcluster = createMockSubcluster(s1, config);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['sys', s1]]),
      );
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      mockKernelStore.getRootObject.mockReturnValue(asKRef('ko42'));

      subclusterManager.initSystemSubclusters([
        { name: 'sys', config: createMockClusterConfig('sys') },
      ]);

      expect(subclusterManager.getSystemSubclusterRoot('sys')).toBe('ko42');
    });

    it('throws for unknown system subcluster name', () => {
      expect(() =>
        subclusterManager.getSystemSubclusterRoot('unknown'),
      ).toThrow('System subcluster "unknown" not found');
    });
  });

  describe('clearSystemSubclusters', () => {
    it('clears all system subcluster root state', () => {
      // Set up state via initSystemSubclusters
      const config = createMockClusterConfig('sys');
      const subcluster = createMockSubcluster(s1, config);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['sys', s1]]),
      );
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      mockKernelStore.getRootObject.mockReturnValue(asKRef('ko42'));

      subclusterManager.initSystemSubclusters([
        { name: 'sys', config: createMockClusterConfig('sys') },
      ]);

      expect(subclusterManager.getSystemSubclusterRoot('sys')).toBe('ko42');

      subclusterManager.clearSystemSubclusters();

      expect(() => subclusterManager.getSystemSubclusterRoot('sys')).toThrow(
        'System subcluster "sys" not found',
      );
    });
  });

  describe('terminateSubcluster with system subcluster mapping', () => {
    it('cleans up system subcluster mapping when terminating a system subcluster', async () => {
      // Set up a system subcluster via init
      const config = createMockClusterConfig('sys');
      const subcluster = createMockSubcluster(s1, config);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(
        new Map([['sys', s1]]),
      );
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      mockKernelStore.getRootObject.mockReturnValue(asKRef('ko1'));
      mockKernelStore.getSubclusterVats.mockReturnValue([
        'v1',
        'v2',
      ] as VatId[]);

      subclusterManager.initSystemSubclusters([
        { name: 'sys', config: createMockClusterConfig('sys') },
      ]);

      expect(subclusterManager.getSystemSubclusterRoot('sys')).toBe('ko1');

      await subclusterManager.terminateSubcluster(s1);

      expect(
        mockKernelStore.deleteSystemSubclusterMapping,
      ).toHaveBeenCalledWith('sys');
      expect(() => subclusterManager.getSystemSubclusterRoot('sys')).toThrow(
        'System subcluster "sys" not found',
      );
    });

    it('does not clean up mappings for non-system subclusters', async () => {
      const subcluster = createMockSubcluster(s1, createMockClusterConfig());
      mockKernelStore.getSubcluster.mockReturnValue(subcluster);
      mockKernelStore.getSubclusterVats.mockReturnValue([]);
      mockKernelStore.getAllSystemSubclusterMappings.mockReturnValue(new Map());

      await subclusterManager.terminateSubcluster(s1);

      expect(
        mockKernelStore.deleteSystemSubclusterMapping,
      ).not.toHaveBeenCalled();
    });
  });

  describe('restorePersistedIOChannels', () => {
    const subclusterWithIO = (
      id: SubclusterId,
      io: Record<string, { type: 'socket'; path: string }>,
    ): Subcluster => ({
      id,
      config: {
        bootstrap: 'svc',
        vats: { svc: { sourceSpec: 'svc.js' } },
        io,
      },
      vats: { svc: 'v1' as VatId },
    });

    const subclusterWithoutIO = (id: SubclusterId): Subcluster => ({
      id,
      config: createMockClusterConfig(`s-${id}`),
      vats: { [`s-${id}Vat`]: 'v1' as VatId },
    });

    it('re-creates channels for every persisted subcluster declaring io', async () => {
      const ioA = { llm: { type: 'socket' as const, path: '/tmp/a.sock' } };
      const ioB = { wire: { type: 'socket' as const, path: '/tmp/b.sock' } };
      mockKernelStore.getSubclusters.mockReturnValue([
        subclusterWithIO(s1, ioA),
        subclusterWithIO(asSubclusterId('s2'), ioB),
      ]);
      const ioManager = makeMockIOManager();
      const mgr = new SubclusterManager({
        kernelStore: mockKernelStore,
        kernelQueue: mockKernelQueue,
        vatManager: mockVatManager,
        getKernelService: mockGetKernelService,
        ioManager: ioManager as never,
      });

      await mgr.restorePersistedIOChannels();

      expect(ioManager.createChannels).toHaveBeenCalledTimes(2);
      expect(ioManager.createChannels).toHaveBeenCalledWith('s1', ioA);
      expect(ioManager.createChannels).toHaveBeenCalledWith('s2', ioB);
    });

    it('skips subclusters whose config does not declare io', async () => {
      mockKernelStore.getSubclusters.mockReturnValue([
        subclusterWithoutIO(s1),
        subclusterWithIO(asSubclusterId('s2'), {
          io: { type: 'socket' as const, path: '/tmp/s2.sock' },
        }),
      ]);
      const ioManager = makeMockIOManager();
      const mgr = new SubclusterManager({
        kernelStore: mockKernelStore,
        kernelQueue: mockKernelQueue,
        vatManager: mockVatManager,
        getKernelService: mockGetKernelService,
        ioManager: ioManager as never,
      });

      await mgr.restorePersistedIOChannels();

      expect(ioManager.createChannels).toHaveBeenCalledTimes(1);
      expect(ioManager.createChannels).toHaveBeenCalledWith(
        's2',
        expect.objectContaining({ io: expect.anything() }),
      );
    });

    it('is a no-op when no IOManager was provided', async () => {
      mockKernelStore.getSubclusters.mockReturnValue([
        subclusterWithIO(s1, {
          llm: { type: 'socket' as const, path: '/tmp/a.sock' },
        }),
      ]);
      // Default subclusterManager from beforeEach has no ioManager;
      // a missing manager must not cause an error here.
      expect(
        await subclusterManager.restorePersistedIOChannels(),
      ).toBeUndefined();
    });

    it('continues past a per-subcluster failure', async () => {
      mockKernelStore.getSubclusters.mockReturnValue([
        subclusterWithIO(s1, {
          llm: { type: 'socket' as const, path: '/tmp/a.sock' },
        }),
        subclusterWithIO(asSubclusterId('s2'), {
          wire: { type: 'socket' as const, path: '/tmp/b.sock' },
        }),
      ]);
      const ioManager = makeMockIOManager();
      ioManager.createChannels.mockImplementationOnce(async () => {
        throw new Error('socket in use');
      });
      const mgr = new SubclusterManager({
        kernelStore: mockKernelStore,
        kernelQueue: mockKernelQueue,
        vatManager: mockVatManager,
        getKernelService: mockGetKernelService,
        ioManager: ioManager as never,
      });

      expect(await mgr.restorePersistedIOChannels()).toBeUndefined();
      expect(ioManager.createChannels).toHaveBeenCalledTimes(2);
    });
  });
});
