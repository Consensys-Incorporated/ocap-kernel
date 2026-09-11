import { is } from '@metamask/superstruct';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { getStatusHandler } from './get-status.ts';
import type { Kernel } from '../../Kernel.ts';
import { KernelQueue } from '../../KernelQueue.ts';
import type { KernelStore } from '../../store/index.ts';
import { KernelStatusStruct } from '../../types.ts';

describe('getStatusHandler', () => {
  let mockKernel: Kernel;

  beforeEach(() => {
    mockKernel = {
      getStatus: vi.fn(),
    } as unknown as Kernel;
  });

  it('should return vats and subclusters status', async () => {
    const mockVats = [
      { id: 'v1', config: { sourceSpec: 'test' }, subclusterId: 'sc1' },
    ];
    const mockSubclusters = [
      { id: 'sc1', config: { bootstrap: 'test', vats: {} }, vats: [] },
    ];

    vi.mocked(mockKernel.getStatus).mockResolvedValueOnce({
      vats: mockVats,
      subclusters: mockSubclusters,
    });

    const result = await getStatusHandler.implementation(
      { kernel: mockKernel },
      [],
    );

    expect(mockKernel.getStatus).toHaveBeenCalledTimes(1);
    expect(result).toStrictEqual({
      vats: mockVats,
      subclusters: mockSubclusters,
    });
  });

  // `RpcClient` validates every result against `KernelStatusStruct`, so a
  // `runLoop` shape the struct rejects fails the whole getStatus call for every
  // client — the outage class this field exists to report.
  describe('runLoop passes result validation', () => {
    const makeStatus = (runLoop: unknown) => ({
      vats: [],
      subclusters: [],
      remoteComms: { state: 'disconnected' },
      runLoop,
    });

    /**
     * @returns A queue whose store does nothing, for reading its run loop status.
     */
    const makeKernelQueue = (): { queue: KernelQueue; store: KernelStore } => {
      const store = {
        startCrank: vi.fn(),
        endCrank: vi.fn(),
        beginOutOfCrank: vi.fn().mockResolvedValue(undefined),
        endOutOfCrank: vi.fn(),
        outOfCrankWorkPending: vi.fn().mockReturnValue(undefined),
        createCrankSavepoint: vi.fn(),
        rollbackCrank: vi.fn(),
        collectGarbage: vi.fn(),
        nextReapAction: vi.fn().mockReturnValue(null),
        getGCActions: vi.fn().mockReturnValue([]),
        runQueueLength: vi.fn().mockReturnValue(0),
        nextTerminatedVatCleanup: vi.fn(),
        dequeueRun: vi.fn(),
        flushCrankBuffer: vi.fn().mockReturnValue([]),
      } as unknown as KernelStore;
      return { queue: new KernelQueue(store, vi.fn()), store };
    };

    it.each([
      { name: 'idle', runLoop: { state: 'idle' } },
      { name: 'running', runLoop: { state: 'running' } },
      {
        name: 'failed',
        runLoop: { state: 'failed', error: 'boom', detail: '{}' },
      },
    ])('accepts $name', ({ runLoop }) => {
      expect(is(makeStatus(runLoop), KernelStatusStruct)).toBe(true);
    });

    it.each([
      { name: 'an unknown state', runLoop: { state: 'wedged' } },
      { name: 'failed without an error', runLoop: { state: 'failed' } },
      {
        name: 'failed without a detail',
        runLoop: { state: 'failed', error: 'boom' },
      },
      {
        name: 'a non-string error',
        runLoop: { state: 'failed', error: 1, detail: '{}' },
      },
      { name: 'a bare string', runLoop: 'failed' },
    ])('rejects $name', ({ runLoop }) => {
      expect(is(makeStatus(runLoop), KernelStatusStruct)).toBe(false);
    });

    // `runLoop` is required, so `RpcClient`'s result validation fails the whole
    // `getStatus` call for a reply from a kernel built before this field, rather
    // than quietly losing it. Pinned because the alternatives don't typecheck
    // here: `optional` widens the property to `| undefined` and `KernelStatus`
    // must satisfy `Json`.
    it('rejects a status with no runLoop at all', () => {
      // Everything else present and valid, so only the missing `runLoop` can be
      // what fails: `remoteComms: undefined` would fail on its own account.
      expect(
        is(
          {
            vats: [],
            subclusters: [],
            remoteComms: { state: 'disconnected' },
          },
          KernelStatusStruct,
        ),
      ).toBe(false);
    });

    // Ties the struct to what the queue actually emits, which are otherwise two
    // independent declarations of one shape.
    it('accepts what getRunLoopStatus returns before the run loop starts', () => {
      const { queue } = makeKernelQueue();
      expect(is(makeStatus(queue.getRunLoopStatus()), KernelStatusStruct)).toBe(
        true,
      );
    });

    it('accepts what getRunLoopStatus returns after the run loop dies', async () => {
      const { queue, store } = makeKernelQueue();
      vi.mocked(store.createCrankSavepoint).mockImplementationOnce(() => {
        throw new Error('boom');
      });

      await expect(queue.run(vi.fn())).rejects.toThrow('boom');

      expect(is(makeStatus(queue.getRunLoopStatus()), KernelStatusStruct)).toBe(
        true,
      );
    });
  });

  it('should propagate errors from getVats', async () => {
    const error = new Error('Status check failed');
    vi.mocked(mockKernel.getStatus).mockRejectedValueOnce(error);
    await expect(
      getStatusHandler.implementation({ kernel: mockKernel }, []),
    ).rejects.toThrow(error);
  });

  it('should propagate errors from getSubclusters', async () => {
    const error = new Error('Subcluster status check failed');
    vi.mocked(mockKernel.getStatus).mockRejectedValueOnce(error);
    await expect(
      getStatusHandler.implementation({ kernel: mockKernel }, []),
    ).rejects.toThrow(error);
  });
});
