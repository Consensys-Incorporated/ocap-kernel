import type { CapData } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import type { Mock, MockInstance } from 'vitest';

import * as gc from './garbage-collection/garbage-collection.ts';
import { KernelQueue } from './KernelQueue.ts';
import { kser, kslot, makeKernelError } from './liveslots/kernel-marshal.ts';
import type { KernelStore } from './store/index.ts';
import * as types from './types.ts';
import type {
  KRef,
  KernelMessage,
  KernelOneResolution,
  RemoteId,
  RunLoopItem,
  RunQueueItem,
} from './types.ts';
import { asKRef, asVatId } from '../test/branded.ts';

const v1 = asVatId('v1');

vi.mock('./garbage-collection/garbage-collection.ts', () => ({
  processGCActionSet: vi.fn().mockReturnValue(null),
}));

vi.mock('@endo/promise-kit', () => ({
  makePromiseKit: vi.fn(),
}));

/**
 * Sentinel error used to stop the infinite run loop in tests.
 * Thrown by collectGarbage (which runs after each delivery) so the
 * test can assert on the side-effects of that delivery.
 */
const STOP_RUN_LOOP = 'test: stop run loop';

describe('KernelQueue', () => {
  let kernelStore: KernelStore;
  let kernelQueue: KernelQueue;
  let mockPromiseKit: ReturnType<typeof makePromiseKit>;
  let terminateVat: Mock<ConstructorParameters<typeof KernelQueue>[1]>;

  beforeEach(() => {
    mockPromiseKit = {
      promise: Promise.resolve(),
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    (makePromiseKit as unknown as MockInstance).mockReturnValue(mockPromiseKit);

    terminateVat = vi
      .fn<ConstructorParameters<typeof KernelQueue>[1]>()
      .mockResolvedValue(undefined);

    kernelStore = {
      nextTerminatedVatCleanup: vi.fn(),
      collectGarbage: vi.fn(),
      assertRefCountsIfAuditing: vi.fn(),
      runQueueLength: vi.fn(),
      dequeueRun: vi.fn(),
      enqueueRun: vi.fn(),
      initKernelPromise: vi.fn().mockReturnValue(['kp1']),
      kernelRefExists: vi.fn().mockReturnValue(true),
      incrementRefCount: vi.fn(),
      pinObject: vi.fn(),
      getKernelPromise: vi.fn(),
      resolveKernelPromise: vi.fn().mockReturnValue([]),
      nextReapAction: vi.fn().mockReturnValue(null),
      getGCActions: vi.fn().mockReturnValue([]),
      startCrank: vi.fn(),
      endCrank: vi.fn(),
      createCrankSavepoint: vi.fn(),
      rollbackCrank: vi.fn(),
      waitForCrank: vi.fn(),
      isInCrank: vi.fn().mockReturnValue(false),
      // Crank buffer methods
      bufferCrankOutput: vi.fn(),
      flushCrankBuffer: vi.fn().mockReturnValue([]),
    } as unknown as KernelStore;

    kernelQueue = new KernelQueue(kernelStore, terminateVat);
  });

  /**
   * Make a promise kit whose `resolve`/`reject` actually settle its promise,
   * for tests where the module-level `makePromiseKit` mock's bare `vi.fn()`
   * settlers won't do.
   *
   * @returns A promise and its settlement functions.
   */
  const makeRealPromiseKit = (): {
    promise: Promise<CapData<KRef>>;
    resolve: (value: CapData<KRef>) => void;
    reject: (reason: unknown) => void;
  } => {
    let settleWithValue!: (value: CapData<KRef>) => void;
    let settleWithReason!: (reason: unknown) => void;
    const promise = new Promise<CapData<KRef>>((resolve, reject) => {
      settleWithValue = resolve;
      settleWithReason = reject;
    });
    return {
      promise,
      resolve: settleWithValue,
      reject: settleWithReason,
    };
  };

  /**
   * Run a single crank whose delivery blows up, killing the run loop.
   *
   * @param error - The error the delivery fails with.
   */
  const killRunLoop = async (error: Error): Promise<void> => {
    (kernelStore.runQueueLength as unknown as MockInstance).mockReturnValueOnce(
      1,
    );
    (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
      type: 'send',
      target: 'ko123',
      message: {} as KernelMessage,
    });
    const deliver = vi.fn().mockRejectedValue(error);
    await expect(kernelQueue.run(deliver)).rejects.toBe(error);
  };

  /**
   * Run one crank with `during` inside it, then stop the run loop in the next,
   * asserting what it died of.
   *
   * @param during - What happens while the crank is open.
   * @param options - Options bag.
   * @param options.diesOf - What the run loop dies of instead of that stop.
   */
  const runACrankWhile = async (
    during: () => void,
    { diesOf }: { diesOf?: Error } = {},
  ): Promise<void> => {
    (kernelStore.isInCrank as unknown as MockInstance).mockReturnValue(true);
    (kernelStore.runQueueLength as unknown as MockInstance).mockReturnValue(1);
    (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValue({
      type: 'send',
      target: 'ko123',
      message: {} as KernelMessage,
    });
    const stop = new Error(STOP_RUN_LOOP);
    const deliver = vi
      .fn()
      .mockImplementationOnce(async () => {
        during();
        return undefined;
      })
      .mockRejectedValueOnce(stop);
    await expect(kernelQueue.run(deliver)).rejects.toBe(diesOf ?? stop);
  };

  describe('run', () => {
    it('processes items from the run queue and performs cleanup', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: {} as KernelMessage,
      };
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValue(
        mockItem,
      );
      const processGCActionSetSpy = vi.spyOn(gc, 'processGCActionSet');
      const deliverError = new Error('stop');
      const deliver = vi.fn().mockRejectedValue(deliverError);
      await expect(kernelQueue.run(deliver)).rejects.toBe(deliverError);
      expect(kernelStore.startCrank).toHaveBeenCalled();
      expect(kernelStore.createCrankSavepoint).toHaveBeenCalledWith('crank');
      expect(kernelStore.createCrankSavepoint).toHaveBeenCalledWith('delivery');
      expect(processGCActionSetSpy).toHaveBeenCalled();
      expect(kernelStore.nextReapAction).toHaveBeenCalled();
      expect(kernelStore.nextTerminatedVatCleanup).toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledWith(mockItem);
      expect(kernelStore.endCrank).toHaveBeenCalled();
    });

    it('rolls back crank when deliver returns abort', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: { result: 'kp99' } as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const deliver = vi.fn().mockResolvedValue({ abort: true });
      (
        kernelStore.collectGarbage as unknown as MockInstance
      ).mockImplementation(() => {
        throw new Error(STOP_RUN_LOOP);
      });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(kernelStore.startCrank).toHaveBeenCalled();
      expect(kernelStore.createCrankSavepoint).toHaveBeenCalledWith('crank');
      expect(kernelStore.createCrankSavepoint).toHaveBeenCalledWith('delivery');
      expect(deliver).toHaveBeenCalledWith(mockItem);
      expect(kernelStore.rollbackCrank).toHaveBeenCalledWith('delivery');
      expect(kernelStore.collectGarbage).toHaveBeenCalled();
      expect(kernelStore.endCrank).toHaveBeenCalled();
    });

    it("runs a crank result's afterCommit once the crank has committed", async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: {} as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const order: string[] = [];
      (kernelStore.endCrank as unknown as MockInstance).mockImplementation(
        () => {
          order.push('endCrank');
        },
      );
      const afterCommit = vi.fn(async () => {
        order.push('afterCommit');
        throw new Error(STOP_RUN_LOOP);
      });
      const deliver = vi.fn().mockResolvedValue({ afterCommit });

      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

      expect(order).toStrictEqual(['endCrank', 'afterCommit']);
    });

    it('runs afterCommit before a held request that fails to be written kills the run loop', async () => {
      (kernelStore.isInCrank as unknown as MockInstance).mockReturnValue(true);
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });
      const fault = new Error('SQLITE_FULL');
      (
        kernelStore.enqueueRun as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw fault;
      });
      const afterCommit = vi.fn(async () => undefined);
      const deliver = vi.fn().mockImplementationOnce(async () => {
        kernelQueue.enqueueRestartVat(v1);
        return { afterCommit };
      });

      await expect(kernelQueue.run(deliver)).rejects.toBe(fault);

      expect(afterCommit).toHaveBeenCalledOnce();
    });

    it('dies of the held request that failed to be written when afterCommit fails too', async () => {
      (kernelStore.isInCrank as unknown as MockInstance).mockReturnValue(true);
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });
      const fault = new Error('SQLITE_FULL');
      (
        kernelStore.enqueueRun as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw fault;
      });
      const afterCommitFault = new Error('transmit failed');
      const deliver = vi.fn().mockImplementationOnce(async () => {
        kernelQueue.enqueueRestartVat(v1);
        return {
          afterCommit: async () => {
            throw afterCommitFault;
          },
        };
      });

      await expect(kernelQueue.run(deliver)).rejects.toStrictEqual(
        new AggregateError(
          [fault, afterCommitFault],
          "Run loop died writing a held request, and its crank's afterCommit failed: Error: transmit failed",
          { cause: fault },
        ),
      );
    });

    it('withholds afterCommit when the delivery threw', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: {} as KernelMessage,
      };
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValue(
        mockItem,
      );
      const deliver = vi.fn().mockRejectedValue(new Error(STOP_RUN_LOOP));

      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

      expect(kernelStore.rollbackCrank).toHaveBeenCalledWith('delivery');
    });

    it('withholds afterCommit when ending the crank threw', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: {} as KernelMessage,
      };
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValue(
        mockItem,
      );
      (kernelStore.endCrank as unknown as MockInstance).mockImplementation(
        () => {
          throw new Error(STOP_RUN_LOOP);
        },
      );
      const afterCommit = vi.fn();
      const deliver = vi.fn().mockResolvedValue({ afterCommit });

      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

      // The commit is what `afterCommit` reports on, and it did not happen.
      expect(afterCommit).not.toHaveBeenCalled();
    });

    it("runs each crank's afterCommit once, not every later crank's", async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: {} as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance).mockReturnValue(
        1,
      );
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValue(
        mockItem,
      );
      const afterCommit = vi.fn();
      let cranks = 0;
      const deliver = vi.fn(async () => {
        cranks += 1;
        if (cranks > 3) {
          throw new Error(STOP_RUN_LOOP);
        }
        // Only the first crank has post-commit work.
        return cranks === 1 ? { afterCommit } : {};
      });

      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

      expect(afterCommit).toHaveBeenCalledOnce();
    });

    it('withholds afterCommit from a crank that aborted', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: {} as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const afterCommit = vi.fn();
      const deliver = vi.fn().mockResolvedValue({ abort: true, afterCommit });
      // The aborted crank has to finish, or the loop exits before it could
      // have run `afterCommit` for reasons that have nothing to do with the
      // abort. So stop on the turn after it.
      (kernelStore.endCrank as unknown as MockInstance).mockImplementationOnce(
        () => undefined,
      );
      (kernelStore.endCrank as unknown as MockInstance).mockImplementation(
        () => {
          throw new Error(STOP_RUN_LOOP);
        },
      );

      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

      expect(afterCommit).not.toHaveBeenCalled();
    });

    it('terminates vat when deliver returns terminate', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: {} as KernelMessage,
      };
      const terminateInfo = {
        vatId: 'v1',
        info: { body: '"test"', slots: [] },
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const deliver = vi.fn().mockResolvedValue({ terminate: terminateInfo });
      (
        kernelStore.collectGarbage as unknown as MockInstance
      ).mockImplementation(() => {
        throw new Error(STOP_RUN_LOOP);
      });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(kernelStore.startCrank).toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledWith(mockItem);
      expect(terminateVat).toHaveBeenCalledWith(
        terminateInfo.vatId,
        terminateInfo.info,
      );
      expect(kernelStore.collectGarbage).toHaveBeenCalled();
      expect(kernelStore.endCrank).toHaveBeenCalled();
    });
  });

  describe('getRunLoopStatus', () => {
    it('reports idle before the run loop starts', () => {
      expect(kernelQueue.getRunLoopStatus()).toStrictEqual({ state: 'idle' });
    });

    it('reports running while the run loop is processing', async () => {
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });
      // A delivery that never settles parks the loop mid-crank.
      const deliver = vi.fn().mockReturnValue(new Promise(() => undefined));
      kernelQueue.run(deliver).catch(() => undefined);
      await Promise.resolve();
      expect(deliver).toHaveBeenCalled();
      expect(kernelQueue.getRunLoopStatus()).toStrictEqual({
        state: 'running',
      });
    });

    it('reports failed once the run loop dies', async () => {
      await killRunLoop(new Error('crank exploded'));
      expect(kernelQueue.getRunLoopStatus()).toStrictEqual({
        state: 'failed',
        error: 'crank exploded',
        detail: expect.stringContaining('crank exploded'),
      });
    });

    // One normalization, so what `run` rejects with and what the status reports
    // are the same object rather than two wrappers that happen to agree.
    it('reports failed for a non-Error run loop failure', async () => {
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });
      const deliver = vi.fn().mockRejectedValue('not an error');

      const failure = await kernelQueue.run(deliver).catch((error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe('not an error');
      // The thrown value survives, so it isn't lost to the normalization.
      expect(failure.cause).toBe('not an error');
      expect(kernelQueue.getRunLoopStatus()).toStrictEqual({
        state: 'failed',
        error: 'not an error',
        detail: expect.stringContaining('not an error'),
      });
    });
  });

  describe('run loop death', () => {
    it('rejects in-flight message results', async () => {
      const kit = makeRealPromiseKit();
      (makePromiseKit as unknown as MockInstance).mockReturnValueOnce(kit);
      const resultPromise = kernelQueue.enqueueMessage(
        asKRef('ko123'),
        'test',
        [],
      );
      expect(kernelQueue.subscriptions.has(asKRef('kp1'))).toBe(true);

      const failure = new Error('crank exploded');
      await killRunLoop(failure);

      await expect(resultPromise).rejects.toThrow(
        'Kernel run loop died; this message result will never be delivered',
      );
      await expect(resultPromise).rejects.toHaveProperty('cause', failure);
      expect(kernelQueue.subscriptions.size).toBe(0);
    });

    it('rejects messages queued after the run loop dies', async () => {
      const failure = new Error('crank exploded');
      await killRunLoop(failure);
      await expect(
        kernelQueue.enqueueMessage(asKRef('ko123'), 'test', []),
      ).rejects.toThrow('Kernel run loop died; cannot queue a message');
      expect(kernelStore.enqueueRun).not.toHaveBeenCalled();
    });

    it('rolls back the crank it died in', async () => {
      await killRunLoop(new Error('crank exploded'));
      // Without this, endCrank's savepoint release commits the half-finished
      // crank and the dequeued item is lost.
      expect(kernelStore.rollbackCrank).toHaveBeenCalledWith('delivery');
    });

    it('does not roll back when the savepoint was never created', async () => {
      (
        kernelStore.createCrankSavepoint as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw new Error('database is gone');
      });
      await expect(kernelQueue.run(vi.fn())).rejects.toThrow(
        'database is gone',
      );
      expect(kernelStore.rollbackCrank).not.toHaveBeenCalled();
    });

    it('does not roll back twice when an aborted crank then throws', async () => {
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: { result: 'kp99' } as KernelMessage,
      });
      const deliver = vi.fn().mockResolvedValue({ abort: true });
      (
        kernelStore.collectGarbage as unknown as MockInstance
      ).mockImplementation(() => {
        throw new Error(STOP_RUN_LOOP);
      });

      // A second rollback would throw "no such savepoint" over this error.
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(kernelStore.rollbackCrank).toHaveBeenCalledOnce();
    });

    it('reports both failures when the rollback also fails', async () => {
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });
      const rollbackError = new Error('database is gone');
      (
        kernelStore.rollbackCrank as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw rollbackError;
      });
      const crankError = new Error('crank exploded');
      const deliver = vi.fn().mockRejectedValue(crankError);

      // The rollback failure names itself; the original stays the `cause`, since
      // that is the root cause an operator needs.
      await expect(kernelQueue.run(deliver)).rejects.toMatchObject({
        message:
          'Run loop died and its crank could not be rolled back: Error: database is gone',
        cause: crankError,
        errors: [crankError, rollbackError],
      });
      expect(kernelQueue.getRunLoopStatus()).toStrictEqual({
        state: 'failed',
        error:
          'Run loop died and its crank could not be rolled back: Error: database is gone',
        // The headline names the rollback, so only `detail` can carry the error
        // that actually killed the kernel to the one consumer that reports it.
        detail: expect.stringContaining('crank exploded'),
      });
    });

    // `rollbackCrank` discards the savepoint even when its database call throws,
    // so a second attempt could only report a missing savepoint. Without the
    // `finally` that clears the flag, the abort path leaves it set, the catch
    // asks again, and "no such savepoint" becomes the reason the kernel reports
    // for its own death — the database error reaching nobody, since only
    // `error.message` crosses the wire.
    it('reports the database failure when an aborted crank cannot roll back', async () => {
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: { result: 'kp99' } as KernelMessage,
      });
      const rollbackError = new Error('database is gone');
      (
        kernelStore.rollbackCrank as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw rollbackError;
      });
      const deliver = vi.fn().mockResolvedValue({ abort: true });

      await expect(kernelQueue.run(deliver)).rejects.toBe(rollbackError);
      expect(kernelStore.rollbackCrank).toHaveBeenCalledOnce();
      expect(kernelQueue.getRunLoopStatus()).toStrictEqual({
        state: 'failed',
        error: 'database is gone',
        detail: expect.stringContaining('database is gone'),
      });
    });

    // The rollback flag is per-crank. If an earlier abort could latch it, every
    // later crank that died would skip its rollback and commit half its work.
    it('rolls back a later crank after an earlier one aborted', async () => {
      const items: RunQueueItem[] = [
        { type: 'send', target: asKRef('ko1'), message: {} as KernelMessage },
        { type: 'send', target: asKRef('ko2'), message: {} as KernelMessage },
      ];
      let dequeued = 0;
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockImplementation(() => (dequeued < items.length ? 1 : 0));
      (kernelStore.dequeueRun as unknown as MockInstance).mockImplementation(
        () => {
          const item = items[dequeued];
          dequeued += 1;
          return item;
        },
      );
      const secondError = new Error('second crank exploded');
      const deliver = vi
        .fn()
        .mockResolvedValueOnce({ abort: true })
        .mockRejectedValueOnce(secondError);

      await expect(kernelQueue.run(deliver)).rejects.toBe(secondError);

      expect(kernelStore.rollbackCrank).toHaveBeenCalledTimes(2);
      expect(kernelQueue.getRunLoopStatus()).toStrictEqual({
        state: 'failed',
        error: 'second crank exploded',
        detail: expect.stringContaining('second crank exploded'),
      });
    });

    it('refuses ingress via assertRunLoopAlive', async () => {
      const failure = new Error('crank exploded');
      expect(() => kernelQueue.assertRunLoopAlive('accept work')).not.toThrow();

      await killRunLoop(failure);

      expect(() => kernelQueue.assertRunLoopAlive('accept work')).toThrow(
        'Kernel run loop died; cannot accept work',
      );
      // The failure that killed the loop is the root cause.
      await expect(async () =>
        kernelQueue.assertRunLoopAlive('accept work'),
      ).rejects.toHaveProperty('cause', failure);
    });

    // Teardown enqueues too, so the guard cannot sit on these mutators: it must
    // keep working after the loop dies, because `VatHandle.terminate` and
    // `RemoteManager` reject the promises a dead endpoint was deciding, and
    // refusing that would break `terminateAllVats` and `reset`.
    it.each([
      {
        teardown: 'resolvePromises',
        call: (queue: KernelQueue) =>
          queue.resolvePromises(v1, [
            [asKRef('kp1'), true, { body: 'x', slots: [] }],
          ]),
        didWork: () => kernelStore.resolveKernelPromise,
      },
      {
        teardown: 'enqueueNotify',
        call: (queue: KernelQueue) => queue.enqueueNotify(v1, asKRef('kp1')),
        didWork: () => kernelStore.enqueueRun,
      },
      {
        teardown: 'enqueueSend',
        call: (queue: KernelQueue) =>
          queue.enqueueSend(asKRef('ko123'), {
            methargs: { body: 'x', slots: [] },
            result: null,
          }),
        didWork: () => kernelStore.enqueueRun,
      },
    ])(
      'still allows $teardown after the run loop dies',
      async ({ call, didWork }) => {
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValue({
          state: 'unresolved',
          decider: 'v1',
          subscribers: [],
        });
        await killRunLoop(new Error('crank exploded'));

        expect(() => call(kernelQueue)).not.toThrow();
        // "Allows" has to mean the work happened, not merely that nothing threw.
        expect(didWork()).toHaveBeenCalled();
      },
    );

    // The guard sits outside `run`'s try, so the refusal must not be mistaken
    // for the loop dying: were it inside, a stray second call would mark a
    // healthy kernel failed and reject every in-flight result.
    it('refuses to start the run loop twice without killing the running one', async () => {
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });
      const deliver = vi.fn().mockReturnValue(new Promise(() => undefined));
      kernelQueue.run(deliver).catch(() => undefined);
      await kernelQueue.enqueueMessage(asKRef('ko123'), 'method', []);
      expect(kernelQueue.subscriptions.has(asKRef('kp1'))).toBe(true);

      await expect(kernelQueue.run(deliver)).rejects.toThrow(
        'run loop already started',
      );

      expect(kernelQueue.getRunLoopStatus()).toStrictEqual({
        state: 'running',
      });
      expect(kernelQueue.subscriptions.has(asKRef('kp1'))).toBe(true);
    });
  });

  describe('enqueueMessage', () => {
    it('creates a message, enqueues it, and returns a promise for the result', async () => {
      const target = asKRef('ko123');
      const method = 'test';
      const args = ['arg1', { key: 'value' }];
      const resultValue = { body: 'result', slots: [] };
      let resolvePromise = (_value: CapData<KRef>): void => {
        // do nothing
      };
      const resultPromiseRaw = new Promise<CapData<KRef>>((resolve) => {
        resolvePromise = resolve;
      });
      const successPromiseKit = {
        promise: resultPromiseRaw,
        resolve: resolvePromise,
        reject: vi.fn(),
      };
      (makePromiseKit as unknown as MockInstance).mockReturnValueOnce(
        successPromiseKit,
      );
      const resultPromise = kernelQueue.enqueueMessage(target, method, args);
      expect(kernelStore.initKernelPromise).toHaveBeenCalled();
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        target,
        'queue|target',
      );
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        'kp1',
        'queue|result',
      );
      expect(kernelStore.enqueueRun).toHaveBeenCalledWith({
        type: 'send',
        target,
        message: expect.objectContaining({
          methargs: expect.anything(),
          result: 'kp1',
        }),
      });
      expect(kernelQueue.subscriptions.has(asKRef('kp1'))).toBe(true);
      const subscription = kernelQueue.subscriptions.get(asKRef('kp1'));
      expect(subscription).toStrictEqual({
        resolve: expect.any(Function),
        reject: expect.any(Function),
      });
      resolvePromise(resultValue);
      const result = await resultPromise;
      expect(result).toStrictEqual(resultValue);
    });

    it('refuses a target that is not a kref', async () => {
      await expect(
        kernelQueue.enqueueMessage('not-a-kref' as KRef, 'test', []),
      ).rejects.toThrow('not a valid KRef');

      expect(kernelStore.initKernelPromise).not.toHaveBeenCalled();
    });

    it.each([
      ['target', asKRef('ko404'), []],
      ['argument', asKRef('ko123'), [kslot(asKRef('ko404'))]],
    ])(
      'rejects a message whose %s the kernel does not have, charging nothing',
      async (_, target, args) => {
        (
          kernelStore.kernelRefExists as unknown as MockInstance
        ).mockImplementation((kref) => kref !== 'ko404');
        (makePromiseKit as unknown as MockInstance).mockReturnValueOnce(
          makeRealPromiseKit(),
        );

        await expect(
          kernelQueue.enqueueMessage(target, 'test', args),
        ).rejects.toStrictEqual(
          makeKernelError(
            'OBJECT_DELETED',
            'ko404 does not exist; it may have been deleted',
          ),
        );

        expect(kernelStore.initKernelPromise).not.toHaveBeenCalled();
        expect(kernelStore.incrementRefCount).not.toHaveBeenCalled();
        expect(kernelQueue.subscriptions.size).toBe(0);
      },
    );

    it('rejects the caller with what a write throws when no crank is open, leaving no subscription', async () => {
      (makePromiseKit as unknown as MockInstance).mockReturnValueOnce(
        makeRealPromiseKit(),
      );
      const fault = new Error('SQLITE_FULL');
      (
        kernelStore.enqueueRun as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw fault;
      });

      await expect(
        kernelQueue.enqueueMessage(asKRef('ko123'), 'test', []),
      ).rejects.toBe(fault);
      expect(kernelQueue.subscriptions.size).toBe(0);
    });

    it("rejects a held message's caller when held requests are discarded", async () => {
      (makePromiseKit as unknown as MockInstance).mockReturnValueOnce(
        makeRealPromiseKit(),
      );
      const discarded = new Error('discarded');
      let answered: Promise<CapData<KRef>> | undefined;
      await runACrankWhile(() => {
        answered = kernelQueue.enqueueMessage(asKRef('ko123'), 'test', []);
        kernelQueue.discardHeldRequests(discarded);
      });

      await expect(answered).rejects.toBe(discarded);
      expect(kernelStore.initKernelPromise).not.toHaveBeenCalled();
    });

    it('rejects a held message whose target was deleted while it waited', async () => {
      (makePromiseKit as unknown as MockInstance).mockReturnValueOnce(
        makeRealPromiseKit(),
      );
      let answered: Promise<CapData<KRef>> | undefined;
      await runACrankWhile(() => {
        answered = kernelQueue.enqueueMessage(asKRef('ko123'), 'test', []);
        (
          kernelStore.kernelRefExists as unknown as MockInstance
        ).mockReturnValue(false);
      });

      await expect(answered).rejects.toStrictEqual(
        makeKernelError(
          'OBJECT_DELETED',
          'ko123 does not exist; it may have been deleted',
        ),
      );
      expect(kernelStore.initKernelPromise).not.toHaveBeenCalled();
    });

    it.each(['kernelRefExists', 'initKernelPromise', 'enqueueRun'] as const)(
      'kills the run loop when %s fails while writing a held message, and tells its caller',
      async (method) => {
        (makePromiseKit as unknown as MockInstance).mockReturnValueOnce(
          makeRealPromiseKit(),
        );
        const fault = new Error('SQLITE_FULL');
        (kernelStore[method] as unknown as MockInstance).mockImplementationOnce(
          () => {
            throw fault;
          },
        );
        let answered: Promise<CapData<KRef>> | undefined;
        await runACrankWhile(
          () => {
            answered = kernelQueue.enqueueMessage(asKRef('ko123'), 'test', []);
          },
          { diesOf: fault },
        );

        expect(
          await answered?.catch((reason: unknown) => reason),
        ).toStrictEqual(
          new Error(
            'Kernel run loop died; this message result will never be delivered',
            { cause: fault },
          ),
        );
      },
    );
  });

  describe('held requests', () => {
    it('writes them in the order they were made', async () => {
      const written: unknown[] = [];
      (kernelStore.enqueueRun as unknown as MockInstance).mockImplementation(
        (item: RunQueueItem) => written.push(item),
      );
      await runACrankWhile(() => {
        kernelQueue
          .enqueueMessage(asKRef('ko123'), 'first', [])
          .catch(() => undefined);
        kernelQueue.enqueueTerminateVat(v1);
        kernelQueue
          .writeOutsideCrank(() => written.push('write'))
          .catch(() => undefined);
        kernelQueue
          .enqueueMessage(asKRef('ko123'), 'second', [])
          .catch(() => undefined);
      });

      expect(written).toStrictEqual([
        {
          type: 'send',
          target: 'ko123',
          message: { methargs: kser(['first', []]), result: 'kp1' },
        },
        { type: 'terminateVat', vatId: 'v1' },
        'write',
        {
          type: 'send',
          target: 'ko123',
          message: { methargs: kser(['second', []]), result: 'kp1' },
        },
      ]);
    });

    it.each([
      [
        'message',
        async (queue: KernelQueue) =>
          queue.enqueueMessage(asKRef('ko123'), 'test', []),
        'Kernel run loop died; this message result will never be delivered',
      ],
      [
        'write',
        async (queue: KernelQueue, write: () => void) =>
          queue.writeOutsideCrank(write),
        'Kernel run loop died; this work will never be carried out',
      ],
    ])(
      'rejects a held %s when its crank kills the run loop',
      async (_, request, reason) => {
        (makePromiseKit as unknown as MockInstance).mockReturnValueOnce(
          makeRealPromiseKit(),
        );
        const failure = new Error('crank exploded');
        const write = vi.fn();
        let result: Promise<unknown> | undefined;
        await runACrankWhile(
          () => {
            result = request(kernelQueue, write);
            throw failure;
          },
          { diesOf: failure },
        );

        await expect(result).rejects.toThrow(reason);
        expect(write).not.toHaveBeenCalled();
        expect(kernelStore.initKernelPromise).not.toHaveBeenCalled();
      },
    );

    it('tells the callers behind one whose write kills the run loop', async () => {
      const messageKit = makeRealPromiseKit();
      const writeKit = makeRealPromiseKit();
      (makePromiseKit as unknown as MockInstance)
        .mockReturnValueOnce(messageKit)
        .mockReturnValueOnce(writeKit);
      const fault = new Error('SQLITE_FULL');
      (
        kernelStore.enqueueRun as unknown as MockInstance
      ).mockImplementationOnce(() => {
        throw fault;
      });
      const write = vi.fn();
      await runACrankWhile(
        () => {
          kernelQueue.enqueueRestartVat(v1);
          kernelQueue
            .enqueueMessage(asKRef('ko123'), 'test', [])
            .catch(() => undefined);
          kernelQueue.writeOutsideCrank(write).catch(() => undefined);
        },
        { diesOf: fault },
      );

      await expect(messageKit.promise).rejects.toThrow(
        'Kernel run loop died; this message result will never be delivered',
      );
      await expect(writeKit.promise).rejects.toThrow(
        'Kernel run loop died; this work will never be carried out',
      );
      expect(write).not.toHaveBeenCalled();
    });

    // This and the next are outside `writeOutsideCrank`'s block, whose promise
    // kit they would leave unused for a later test to take. This one's
    // assertion is a type, checked by `test:types` rather than vitest.
    // oxlint-disable-next-line vitest/expect-expect
    it('refuses at compile time a write that returns a promise', () => {
      expectTypeOf(kernelQueue.writeOutsideCrank<Promise<string>>)
        .parameter(0)
        .returns.toBeNever();
    });

    it('refuses a write once the run loop is dead', async () => {
      await killRunLoop(new Error('crank exploded'));
      const write = vi.fn();

      await expect(kernelQueue.writeOutsideCrank(write)).rejects.toThrow(
        'Kernel run loop died; cannot write outside a crank',
      );
      expect(write).not.toHaveBeenCalled();
    });
  });

  describe('writeOutsideCrank', () => {
    beforeEach(() => {
      (makePromiseKit as unknown as MockInstance).mockReturnValueOnce(
        makeRealPromiseKit(),
      );
    });

    it('makes the write at once when no crank is open', async () => {
      const write = vi.fn().mockReturnValue('written');

      const result = kernelQueue.writeOutsideCrank(write);

      expect(write).toHaveBeenCalledOnce();
      expect(await result).toBe('written');
    });

    it('rejects with what the write throws', async () => {
      const fault = new Error('SQLITE_FULL');

      await expect(
        kernelQueue.writeOutsideCrank(() => {
          throw fault;
        }),
      ).rejects.toBe(fault);
    });

    it('holds the write until the open crank ends', async () => {
      const write = vi.fn().mockReturnValue('written');
      let result: Promise<unknown> | undefined;
      let calledDuringCrank = true;
      await runACrankWhile(() => {
        result = kernelQueue.writeOutsideCrank(write);
        calledDuringCrank = write.mock.calls.length > 0;
      });

      expect(calledDuringCrank).toBe(false);
      expect(write).toHaveBeenCalledOnce();
      expect(await result).toBe('written');
    });

    it("rejects with a peer's refusal that a held write throws, and the run loop goes on", async () => {
      const refusal = new Error('invalid message seq: 0');
      let result: Promise<unknown> | undefined;
      await runACrankWhile(() => {
        result = kernelQueue.writeOutsideCrank(() => {
          throw refusal;
        });
      });

      await expect(result).rejects.toBe(refusal);
    });

    it('rejects with what a held write throws, and the run loop goes on (gap, #1171)', async () => {
      const fault = new Error('SQLITE_FULL');
      let result: Promise<unknown> | undefined;
      await runACrankWhile(() => {
        result = kernelQueue.writeOutsideCrank(() => {
          throw fault;
        });
      });

      await expect(result).rejects.toBe(fault);
    });

    it.each([false, true])(
      'rejects a held write when held requests are discarded, outlivesStop: %s',
      async (outlivesStop) => {
        const write = vi.fn();
        const discarded = new Error('discarded');
        let result: Promise<unknown> | undefined;
        await runACrankWhile(() => {
          result = kernelQueue.writeOutsideCrank(write, { outlivesStop });
          kernelQueue.discardHeldRequests(discarded);
        });

        await expect(result).rejects.toBe(discarded);
        expect(write).not.toHaveBeenCalled();
      },
    );

    it.each([
      { options: { outlivesStop: true }, settled: 'written' },
      { options: { outlivesStop: false }, settled: 'stopped' },
      { options: undefined, settled: 'stopped' },
    ])(
      'makes a write held through a stop only if it outlives one, given $options',
      async ({ options, settled }) => {
        let result: Promise<unknown> | undefined;
        await runACrankWhile(() => {
          result = kernelQueue.writeOutsideCrank(() => 'written', options);
          kernelQueue.discardHeldRequests(new Error('stopped'), {
            stopping: true,
          });
        });

        expect(await result?.catch((error: Error) => error.message)).toBe(
          settled,
        );
      },
    );
  });

  describe('enqueueSend', () => {
    it('enqueues a send message and increments reference counts', () => {
      const target = asKRef('ko123');
      const message: KernelMessage = {
        methargs: {
          body: 'method args',
          slots: [asKRef('ko1'), asKRef('ko2')],
        },
        result: asKRef('kp2'),
      };
      kernelQueue.enqueueSend(target, message);
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        target,
        'queue|target',
      );
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        message.result,
        'queue|result',
      );
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        'ko1',
        'queue|slot',
      );
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        'ko2',
        'queue|slot',
      );
      expect(kernelStore.enqueueRun).toHaveBeenCalledWith({
        type: 'send',
        target,
        message,
      });
    });

    it('handles messages without result or slots', () => {
      const target = asKRef('ko123');
      const message: KernelMessage = {
        methargs: { body: 'method args', slots: [] },
        result: null,
      };
      kernelQueue.enqueueSend(target, message);
      expect(kernelStore.incrementRefCount).toHaveBeenCalledTimes(1);
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        target,
        'queue|target',
      );
      expect(kernelStore.enqueueRun).toHaveBeenCalledWith({
        type: 'send',
        target,
        message,
      });
    });
  });

  describe('enqueueNotify', () => {
    it('enqueues a notify and increments refcount', () => {
      const endpointId = v1;
      const kpid = asKRef('kp123');
      kernelQueue.enqueueNotify(endpointId, kpid);
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        kpid,
        'notify',
      );
      expect(kernelStore.enqueueRun).toHaveBeenCalledWith({
        type: 'notify',
        endpointId,
        kpid,
      });
    });
  });

  describe('remote arrivals', () => {
    /**
     * Hand the queue a message from a remote.
     *
     * @param options - Options bag.
     * @param options.seq - The message's sequence number.
     * @param options.remoteId - The remote it came from.
     * @param options.peerId - The peer that sent it.
     * @param options.highestReceivedSeq - What a committed crank has taken from
     * that remote.
     * @returns Whether the queue held it.
     */
    const arrive = ({
      seq,
      remoteId = 'r1',
      peerId = `peer-${remoteId}`,
      highestReceivedSeq = 0,
    }: {
      seq: number;
      remoteId?: string;
      peerId?: string;
      highestReceivedSeq?: number;
    }): boolean =>
      kernelQueue.acceptRemoteInbound({
        remoteId: remoteId as RemoteId,
        peerId,
        seq,
        message: `{"seq":${seq}}`,
        highestReceivedSeq,
      });

    /**
     * The run loop item an {@link arrive} call becomes.
     *
     * @param seq - The message's sequence number.
     * @param remoteId - The remote it came from.
     * @returns The item.
     */
    const arrival = (seq: number, remoteId = 'r1'): RunLoopItem => ({
      type: 'remoteInbound',
      remoteId: remoteId as RemoteId,
      peerId: `peer-${remoteId}`,
      seq,
      message: `{"seq":${seq}}`,
    });

    /**
     * Hand the queue a peer's incarnation change.
     *
     * @param incarnation - The incarnation the peer reported.
     * @param options - Options bag.
     * @param options.peerId - The peer.
     * @param options.restart - Whether it replaced one the kernel knew.
     */
    const reportIncarnation = (
      incarnation: string,
      { peerId = 'peer-r1', restart = true } = {},
    ): void => {
      kernelQueue.acceptPeerIncarnation({ peerId, incarnation, restart });
    };

    /**
     * Run the loop until it has delivered `count` items.
     *
     * @param count - How many to deliver before stopping the loop.
     * @returns The items, in the order delivered.
     */
    const deliverItems = async (count: number): Promise<RunLoopItem[]> => {
      const delivered: RunLoopItem[] = [];
      const deliver = vi.fn().mockImplementation(async (item: RunLoopItem) => {
        delivered.push(item);
        if (delivered.length === count) {
          throw new Error(STOP_RUN_LOOP);
        }
        return {};
      });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      return delivered;
    };

    it('holds an arrival out of the run queue and hands it to a crank', async () => {
      arrive({ seq: 1 });
      expect(kernelStore.enqueueRun).not.toHaveBeenCalled();

      expect(await deliverItems(1)).toStrictEqual([arrival(1)]);
    });

    it('refuses an arrival once the run loop has died', async () => {
      await killRunLoop(new Error('dead'));

      expect(() => arrive({ seq: 1 })).toThrow('Kernel run loop died');
    });

    it('refuses an incarnation change once the run loop has died', async () => {
      await killRunLoop(new Error('dead'));

      expect(() => reportIncarnation('incarnation-B')).toThrow(
        'Kernel run loop died',
      );
    });

    /**
     * The run loop item a {@link reportIncarnation} call becomes.
     *
     * @param incarnation - The incarnation the peer reported.
     * @param options - Options bag.
     * @param options.restart - Whether it replaced one the kernel knew.
     * @returns The item.
     */
    const change = (
      incarnation: string,
      { restart = true } = {},
    ): RunLoopItem => ({
      type: 'peerIncarnation',
      peerId: 'peer-r1',
      incarnation,
      restart,
    });

    it('takes what a peer sends while its incarnation change waits ahead of the change', async () => {
      arrive({ seq: 47 });
      reportIncarnation('incarnation-B');
      arrive({ seq: 3, remoteId: 'r2' });
      arrive({ seq: 48 });

      expect(await deliverItems(4)).toStrictEqual([
        arrival(47),
        arrival(48),
        change('incarnation-B'),
        arrival(3, 'r2'),
      ]);
    });

    it('takes what a peer sends behind its first incarnation change', async () => {
      reportIncarnation('incarnation-A', { restart: false });
      arrive({ seq: 1 });

      expect(await deliverItems(2)).toStrictEqual([
        change('incarnation-A', { restart: false }),
        arrival(1),
      ]);
    });

    it('drops a copy of a message sent again while its incarnation change waits', async () => {
      arrive({ seq: 1 });
      reportIncarnation('incarnation-B');

      expect(arrive({ seq: 1 })).toBe(true);
      expect(await deliverItems(2)).toStrictEqual([
        arrival(1),
        change('incarnation-B'),
      ]);
    });

    it("compares a message with what committed when only another peer's incarnation changed", async () => {
      reportIncarnation('incarnation-B');
      arrive({ seq: 3, remoteId: 'r2', highestReceivedSeq: 5 });
      arrive({ seq: 6, remoteId: 'r2', highestReceivedSeq: 5 });

      expect(await deliverItems(2)).toStrictEqual([
        change('incarnation-B'),
        arrival(6, 'r2'),
      ]);
    });

    it('lists the incarnations a peer reported in changes still waiting', async () => {
      reportIncarnation('incarnation-A', { restart: false });
      reportIncarnation('incarnation-X', { peerId: 'peer-r2' });
      reportIncarnation('incarnation-B');

      expect({
        r1: kernelQueue.waitingIncarnations('peer-r1'),
        r2: kernelQueue.waitingIncarnations('peer-r2'),
        r3: kernelQueue.waitingIncarnations('peer-r3'),
      }).toStrictEqual({
        r1: ['incarnation-A', 'incarnation-B'],
        r2: ['incarnation-X'],
        r3: [],
      });
      await deliverItems(3);
      expect(kernelQueue.waitingIncarnations('peer-r1')).toStrictEqual([]);
    });

    it('carries out only the latest of the restarts reported while one waits', async () => {
      reportIncarnation('incarnation-B');
      reportIncarnation('incarnation-X', { peerId: 'peer-r2' });
      for (const incarnation of ['incarnation-C', 'incarnation-D']) {
        reportIncarnation(incarnation);
      }
      arrive({ seq: 1, remoteId: 'r3' });

      expect(await deliverItems(3)).toStrictEqual([
        change('incarnation-D'),
        { ...change('incarnation-X'), peerId: 'peer-r2' },
        arrival(1, 'r3'),
      ]);
    });

    it('keeps the count of what was taken ahead of a restart that a later one replaces', () => {
      reportIncarnation('incarnation-B');
      for (let seq = 1; seq <= 100; seq += 1) {
        arrive({ seq });
      }
      reportIncarnation('incarnation-C');
      const held = Array.from({ length: 100 }, (_, index) =>
        arrive({ seq: index + 101, highestReceivedSeq: index + 1 }),
      );

      expect(held.every(Boolean)).toBe(true);
      expect(arrive({ seq: 201, highestReceivedSeq: 101 })).toBe(false);
    });

    it('discards every arrival', async () => {
      arrive({ seq: 1 });
      arrive({ seq: 1, remoteId: 'r2' });
      reportIncarnation('incarnation-B');

      kernelQueue.discardArrivals();
      arrive({ seq: 2 });

      expect(await deliverItems(1)).toStrictEqual([arrival(2)]);
    });

    it.each([
      { what: 'a message arrives', accept: () => arrive({ seq: 1 }) },
      {
        what: 'a peer restarts',
        accept: () => reportIncarnation('incarnation-B'),
      },
    ])('wakes a parked run loop when $what', async ({ accept }) => {
      (kernelStore.runQueueLength as unknown as MockInstance).mockReturnValue(
        0,
      );
      let turns = 0;
      (kernelStore.endCrank as unknown as MockInstance).mockImplementation(
        () => {
          turns += 1;
          if (turns === 1) {
            // The loop found nothing and has armed its wake.
            accept();
          } else if (turns > 2) {
            throw new Error(STOP_RUN_LOOP);
          }
        },
      );
      const deliver = vi.fn().mockResolvedValue({});

      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

      expect(mockPromiseKit.resolve).toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledOnce();
    });

    it('holds 200 arrivals from a remote and refuses the next', () => {
      const held = Array.from({ length: 200 }, (_, index) =>
        arrive({ seq: index + 1 }),
      );

      expect(held.every(Boolean)).toBe(true);
      expect(arrive({ seq: 201 })).toBe(false);
    });

    it('refuses the 201st arrival from a remote whose incarnation change waits', () => {
      for (let seq = 1; seq <= 100; seq += 1) {
        arrive({ seq });
      }
      reportIncarnation('incarnation-B');
      const held = Array.from({ length: 100 }, (_, index) =>
        arrive({ seq: index + 101 }),
      );

      expect(held.every(Boolean)).toBe(true);
      expect(arrive({ seq: 201 })).toBe(false);
    });

    it('takes no more than 200 arrivals ahead of one waiting restart', async () => {
      reportIncarnation('incarnation-B');
      arrive({ seq: 1 });
      let refused: number | undefined;
      const delivered: RunLoopItem[] = [];
      // A peer still sending on the old channel, one message per crank.
      const deliver = vi.fn(async (item: RunLoopItem) => {
        delivered.push(item);
        if (item.type !== 'remoteInbound' || delivered.length > 300) {
          throw new Error(STOP_RUN_LOOP);
        }
        const next = item.seq + 1;
        if (!arrive({ seq: next, highestReceivedSeq: item.seq })) {
          refused = next;
        }
        return {};
      });

      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

      expect({
        refused,
        delivered: delivered.length,
        last: delivered.at(-1),
      }).toStrictEqual({
        refused: 201,
        delivered: 201,
        last: change('incarnation-B'),
      });
    });

    it('counts each remote against its own share', async () => {
      for (let seq = 1; seq <= 200; seq += 1) {
        arrive({ seq });
      }

      expect(arrive({ seq: 1, remoteId: 'r2' })).toBe(true);
      const delivered = await deliverItems(201);
      expect(delivered.at(-1)).toStrictEqual(arrival(1, 'r2'));
    });

    it('holds a copy of an arrival already waiting only once', async () => {
      arrive({ seq: 1 });
      arrive({ seq: 2 });
      arrive({ seq: 1 });

      expect(await deliverItems(2)).toStrictEqual([arrival(1), arrival(2)]);
    });

    // Two peers can hold one remote ID after a reset (#1208); the router drops
    // the one it no longer names, so its message cannot stand in for the
    // other's.
    it('holds a message from a peer sharing its remote ID with another', async () => {
      arrive({ seq: 1, peerId: 'peerA' });

      expect(arrive({ seq: 1, peerId: 'peerB' })).toBe(true);
      const delivered = await deliverItems(2);
      expect(
        delivered.map((item) => item.type === 'remoteInbound' && item.peerId),
      ).toStrictEqual(['peerA', 'peerB']);
    });

    it('does not hold a copy of what a committed crank has taken', async () => {
      expect(arrive({ seq: 4, highestReceivedSeq: 5 })).toBe(true);
      arrive({ seq: 6, highestReceivedSeq: 5 });

      expect(await deliverItems(1)).toStrictEqual([arrival(6)]);
    });

    it('stops counting held arrivals against the cap once a committed crank has passed their seq', () => {
      for (let seq = 1; seq <= 200; seq += 1) {
        arrive({ seq });
      }

      expect(arrive({ seq: 201, highestReceivedSeq: 200 })).toBe(true);
    });

    it('takes arrivals and run queue items in turns', async () => {
      arrive({ seq: 1 });
      arrive({ seq: 2 });
      (kernelStore.runQueueLength as unknown as MockInstance).mockReturnValue(
        1,
      );
      (kernelStore.dequeueRun as unknown as MockInstance)
        .mockReturnValueOnce({ type: 'send', target: 'ko1', message: {} })
        .mockReturnValueOnce({ type: 'send', target: 'ko2', message: {} });

      const delivered = await deliverItems(4);

      expect(delivered.map((item) => item.type)).toStrictEqual([
        'remoteInbound',
        'send',
        'remoteInbound',
        'send',
      ]);
    });

    it('takes arrivals back to back while the run queue is empty', async () => {
      (kernelStore.runQueueLength as unknown as MockInstance).mockReturnValue(
        0,
      );
      arrive({ seq: 1 });
      arrive({ seq: 2 });

      expect(await deliverItems(2)).toStrictEqual([arrival(1), arrival(2)]);
      // The loop parks on a promise kit, and a parked loop waits for a wake
      // that no message already held will send.
      expect(makePromiseKit).not.toHaveBeenCalled();
    });

    it('takes a GC action before an arrival', async () => {
      arrive({ seq: 1 });
      const gcAction = { type: 'dropExports', endpointId: 'v1', krefs: [] };
      vi.mocked(gc.processGCActionSet).mockReturnValueOnce(
        gcAction as unknown as ReturnType<typeof gc.processGCActionSet>,
      );

      expect(await deliverItems(2)).toStrictEqual([gcAction, arrival(1)]);
    });
  });

  it.each([
    {
      what: 'restart',
      enqueue: (queue: KernelQueue): void => queue.enqueueRestartVat(v1),
      item: { type: 'restartVat', vatId: 'v1' },
    },
    {
      what: 'termination',
      enqueue: (queue: KernelQueue): void => queue.enqueueTerminateVat(v1),
      item: { type: 'terminateVat', vatId: 'v1' },
    },
    {
      what: 'message',
      enqueue: (queue: KernelQueue): void => {
        queue
          .enqueueMessage(asKRef('ko123'), 'test', [])
          .catch(() => undefined);
      },
      item: {
        type: 'send',
        target: 'ko123',
        message: { methargs: kser(['test', []]), result: 'kp1' },
      },
    },
  ])(
    'holds a $what request made during a crank until that crank ends',
    async ({ enqueue, item }) => {
      const events: string[] = [];
      (kernelStore.isInCrank as unknown as MockInstance).mockReturnValue(true);
      (kernelStore.enqueueRun as unknown as MockInstance).mockImplementation(
        () => events.push('enqueueRun'),
      );
      (kernelStore.rollbackCrank as unknown as MockInstance).mockImplementation(
        () => events.push('rollbackCrank'),
      );
      (kernelStore.endCrank as unknown as MockInstance).mockImplementation(() =>
        events.push('endCrank'),
      );
      (kernelStore.runQueueLength as unknown as MockInstance).mockReturnValue(
        1,
      );
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValue({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });
      const stop = new Error('test: stop run loop');
      const deliver = vi
        .fn()
        .mockImplementationOnce(async () => {
          enqueue(kernelQueue);
          return { abort: true };
        })
        .mockRejectedValueOnce(stop);

      await expect(kernelQueue.run(deliver)).rejects.toBe(stop);

      expect(events.slice(0, 3)).toStrictEqual([
        'rollbackCrank',
        'endCrank',
        'enqueueRun',
      ]);
      expect(kernelStore.enqueueRun).toHaveBeenCalledWith(item);
    },
  );

  describe('enqueueRestartVat', () => {
    it('enqueues a restart request', () => {
      kernelQueue.enqueueRestartVat(v1);

      expect(kernelStore.enqueueRun).toHaveBeenCalledWith({
        type: 'restartVat',
        vatId: 'v1',
      });
    });

    it.each([
      ['restart', (queue: KernelQueue) => queue.enqueueRestartVat(v1)],
      ['termination', (queue: KernelQueue) => queue.enqueueTerminateVat(v1)],
    ])(
      'does not write a %s discarded before its crank ends',
      async (_, request) => {
        (kernelStore.isInCrank as unknown as MockInstance).mockReturnValue(
          true,
        );
        (kernelStore.runQueueLength as unknown as MockInstance).mockReturnValue(
          1,
        );
        (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValue({
          type: 'send',
          target: 'ko123',
          message: {} as KernelMessage,
        });
        const stop = new Error('test: stop run loop');
        const deliver = vi
          .fn()
          .mockImplementationOnce(async () => {
            request(kernelQueue);
            kernelQueue.discardHeldRequests(new Error('discarded'));
            return undefined;
          })
          .mockRejectedValueOnce(stop);

        await expect(kernelQueue.run(deliver)).rejects.toBe(stop);

        expect(kernelStore.enqueueRun).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['restart', (queue: KernelQueue) => queue.enqueueRestartVat(v1)],
      ['termination', (queue: KernelQueue) => queue.enqueueTerminateVat(v1)],
    ])(
      'drops a %s held by a crank that kills the run loop',
      async (_, request) => {
        (kernelStore.isInCrank as unknown as MockInstance).mockReturnValue(
          true,
        );
        (kernelStore.runQueueLength as unknown as MockInstance).mockReturnValue(
          1,
        );
        (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValue({
          type: 'send',
          target: 'ko123',
          message: {} as KernelMessage,
        });
        const failure = new Error('crank exploded');
        const deliver = vi.fn().mockImplementationOnce(async () => {
          request(kernelQueue);
          throw failure;
        });

        await expect(kernelQueue.run(deliver)).rejects.toBe(failure);

        // Its caller hears of the death through `onRunLoopDeath` instead.
        expect(kernelStore.enqueueRun).not.toHaveBeenCalled();
      },
    );

    it('refuses once the run loop is dead', async () => {
      await killRunLoop(new Error('crank exploded'));

      expect(() => kernelQueue.enqueueRestartVat(v1)).toThrow(
        'Kernel run loop died; cannot restart a vat',
      );
      expect(kernelStore.enqueueRun).not.toHaveBeenCalled();
    });
  });

  describe('enqueueTerminateVat', () => {
    it('enqueues a termination request with its reason', () => {
      const reason = { body: 'because', slots: [] } as CapData<KRef>;

      kernelQueue.enqueueTerminateVat(v1, reason);

      expect(kernelStore.enqueueRun).toHaveBeenCalledWith({
        type: 'terminateVat',
        vatId: 'v1',
        reason,
      });
    });

    it('leaves the reason out when there is none', () => {
      kernelQueue.enqueueTerminateVat(v1);

      // `toHaveBeenCalledWith` ignores an `undefined`-valued key, and the item
      // struct's `reason` is `exactOptional`, so the key has to be absent.
      expect(
        (kernelStore.enqueueRun as unknown as MockInstance).mock.calls,
      ).toStrictEqual([[{ type: 'terminateVat', vatId: 'v1' }]]);
    });

    it('refuses a reason that carries slots', () => {
      const reason = { body: 'because', slots: ['ko1'] } as CapData<KRef>;

      expect(() => kernelQueue.enqueueTerminateVat(v1, reason)).toThrow(
        'a termination reason cannot carry slots',
      );
      expect(kernelStore.enqueueRun).not.toHaveBeenCalled();
    });

    it('refuses once the run loop is dead', async () => {
      await killRunLoop(new Error('crank exploded'));

      expect(() => kernelQueue.enqueueTerminateVat(v1)).toThrow(
        'Kernel run loop died; cannot terminate a vat',
      );
      expect(kernelStore.enqueueRun).not.toHaveBeenCalled();
    });
  });

  describe('onRunLoopDeath', () => {
    it('tells a waiter the work will never be done', async () => {
      const reject = vi.fn();
      kernelQueue.onRunLoopDeath(reject);
      const failure = new Error('crank exploded');

      await killRunLoop(failure);

      expect(reject).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Kernel run loop died; this work will never be carried out',
          cause: failure,
        }),
      );
    });

    it('tells a waiter that arrives after the death', async () => {
      await killRunLoop(new Error('crank exploded'));
      const reject = vi.fn();

      kernelQueue.onRunLoopDeath(reject);

      expect(reject).toHaveBeenCalledOnce();
    });

    it('leaves an unregistered waiter alone', async () => {
      const reject = vi.fn();
      const stopWatching = kernelQueue.onRunLoopDeath(reject);
      stopWatching();

      await killRunLoop(new Error('crank exploded'));

      expect(reject).not.toHaveBeenCalled();
    });
  });

  describe('resolvePromises', () => {
    it('resolves kernel promises and buffers notifications for subscribers', () => {
      const endpointId = v1;
      const kpid = asKRef('kp123');
      const resolution: KernelOneResolution = [
        kpid,
        false,
        { body: 'resolved value', slots: ['ko1'] } as CapData<KRef>,
      ];
      (kernelStore.getKernelPromise as unknown as MockInstance).mockReturnValue(
        {
          state: 'unresolved',
          decider: endpointId,
          subscribers: ['v2', 'v3'],
        },
      );
      const resolveHandler = vi.fn();
      const rejectHandler = vi.fn();
      kernelQueue.subscriptions.set(kpid, {
        resolve: resolveHandler,
        reject: rejectHandler,
      });
      kernelQueue.resolvePromises(endpointId, [resolution], false);
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        'ko1',
        'resolve|slot',
      );
      // Notifications are buffered with refcount increments
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        kpid,
        'notify',
      );
      expect(kernelStore.bufferCrankOutput).toHaveBeenCalledWith({
        type: 'notify',
        endpointId: 'v2',
        kpid,
      });
      expect(kernelStore.bufferCrankOutput).toHaveBeenCalledWith({
        type: 'notify',
        endpointId: 'v3',
        kpid,
      });
      expect(kernelStore.resolveKernelPromise).toHaveBeenCalledWith(
        kpid,
        false,
        { body: 'resolved value', slots: ['ko1'] },
      );
      // Kernel subscription callback is NOT called immediately - deferred to flush
      expect(resolveHandler).not.toHaveBeenCalled();
      // Subscription is still registered, will be invoked during flush
      expect(kernelQueue.subscriptions.has(kpid)).toBe(true);
    });

    it.each([
      ['pins', true, ['ko1', 'kp2']],
      ['does not pin', false, []],
    ])(
      '%s the resolution slots when the kernel is subscribed: %s',
      (_title, subscribed, pinned) => {
        const kpid = asKRef('kp1');
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValue({
          state: 'unresolved',
          decider: v1,
          subscribers: [],
        });
        if (subscribed) {
          kernelQueue.subscriptions.set(kpid, {
            resolve: vi.fn(),
            reject: vi.fn(),
          });
        }
        kernelQueue.resolvePromises(
          v1,
          [[kpid, false, { body: '', slots: [asKRef('ko1'), asKRef('kp2')] }]],
          false,
        );
        expect(
          (kernelStore.pinObject as unknown as MockInstance).mock.calls,
        ).toStrictEqual(pinned.map((slot) => [slot]));
      },
    );

    it('handles resolutions with undefined vatId (kernel decider)', () => {
      const kpid = asKRef('kp123');
      const resolution: KernelOneResolution = [
        kpid,
        false,
        { body: 'resolved value', slots: ['ko1'] } as CapData<KRef>,
      ];
      (kernelStore.getKernelPromise as unknown as MockInstance).mockReturnValue(
        {
          state: 'unresolved',
          decider: undefined,
          subscribers: ['v2'],
        },
      );
      const resolveHandler = vi.fn();
      const rejectHandler = vi.fn();
      kernelQueue.subscriptions.set(kpid, {
        resolve: resolveHandler,
        reject: rejectHandler,
      });
      const insistEndpointIdSpy = vi.spyOn(types, 'insistEndpointId');
      kernelQueue.resolvePromises(undefined, [resolution], false);
      expect(insistEndpointIdSpy).not.toHaveBeenCalled();
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        'ko1',
        'resolve|slot',
      );
      // Notification is buffered with refcount increment
      expect(kernelStore.incrementRefCount).toHaveBeenCalledWith(
        kpid,
        'notify',
      );
      expect(kernelStore.bufferCrankOutput).toHaveBeenCalledWith({
        type: 'notify',
        endpointId: 'v2',
        kpid,
      });
      expect(kernelStore.resolveKernelPromise).toHaveBeenCalledWith(
        kpid,
        false,
        resolution[2],
      );
      // Kernel subscription callback is NOT called immediately - deferred to flush
      expect(resolveHandler).not.toHaveBeenCalled();
      expect(kernelQueue.subscriptions.has(kpid)).toBe(true);
      insistEndpointIdSpy.mockRestore();
    });

    it('handles promises with no subscribers', () => {
      const endpointId = v1;
      const kpid = asKRef('kp3');
      const resolution: KernelOneResolution = [
        kpid,
        false,
        { body: 'resolved value', slots: [] } as CapData<KRef>,
      ];
      (kernelStore.getKernelPromise as unknown as MockInstance).mockReturnValue(
        {
          state: 'unresolved',
          decider: endpointId,
          subscribers: [],
        },
      );
      const resolveHandler = vi.fn();
      const rejectHandler = vi.fn();
      kernelQueue.subscriptions.set(kpid, {
        resolve: resolveHandler,
        reject: rejectHandler,
      });
      kernelQueue.resolvePromises(endpointId, [resolution], false);
      // No notifications buffered because no subscribers
      expect(kernelStore.bufferCrankOutput).not.toHaveBeenCalled();
      expect(kernelStore.resolveKernelPromise).toHaveBeenCalledWith(
        kpid,
        false,
        resolution[2],
      );
      // Kernel subscription callback is NOT called immediately - deferred to flush
      expect(resolveHandler).not.toHaveBeenCalled();
      expect(kernelQueue.subscriptions.has(kpid)).toBe(true);
    });

    it('throws error if a promise is already resolved', () => {
      const endpointId = v1;
      const kpid = asKRef('kp123');
      const resolution: KernelOneResolution = [
        kpid,
        false,
        { body: 'resolved value', slots: ['ko1'] } as CapData<KRef>,
      ];
      (kernelStore.getKernelPromise as unknown as MockInstance).mockReturnValue(
        {
          state: 'fulfilled',
          decider: endpointId,
        },
      );
      expect(() =>
        kernelQueue.resolvePromises(endpointId, [resolution]),
      ).toThrow('"kp123" was already resolved');
      // A refused resolve charges nothing, so it leaves nothing behind for the
      // refcount audit to find with no holder.
      expect(kernelStore.incrementRefCount).not.toHaveBeenCalled();
    });

    it('throws error if the resolver is not the decider', () => {
      const endpointId = v1;
      const wrongEndpointId = 'v2';
      const kpid = asKRef('kp123');
      const resolution: KernelOneResolution = [
        kpid,
        false,
        { body: 'resolved value', slots: ['ko1'] } as CapData<KRef>,
      ];
      (kernelStore.getKernelPromise as unknown as MockInstance).mockReturnValue(
        {
          state: 'unresolved',
          decider: wrongEndpointId,
        },
      );
      expect(() =>
        kernelQueue.resolvePromises(endpointId, [resolution]),
      ).toThrow(
        '"v1" not permitted to resolve "kp123" because "its decider is v2"',
      );
      expect(kernelStore.incrementRefCount).not.toHaveBeenCalled();
    });
  });

  describe('abort with terminate', () => {
    it('rejects the JS subscription for the aborted send item', async () => {
      const rejectSpy = vi.fn();
      kernelQueue.subscriptions.set(asKRef('kp99'), {
        resolve: vi.fn(),
        reject: rejectSpy,
      });
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: { result: 'kp99' } as KernelMessage,
      };
      const terminateInfo = {
        body: '"vat terminated"',
        slots: [],
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const deliver = vi.fn().mockResolvedValue({
        abort: true,
        terminate: { vatId: 'v1', info: terminateInfo },
      });
      (
        kernelStore.collectGarbage as unknown as MockInstance
      ).mockImplementation(() => {
        throw new Error(STOP_RUN_LOOP);
      });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(kernelStore.rollbackCrank).toHaveBeenCalledWith('delivery');
      expect(rejectSpy).toHaveBeenCalledWith(terminateInfo);
      expect(kernelQueue.subscriptions.has(asKRef('kp99'))).toBe(false);
    });

    it('preserves the subscription when abort without terminate', async () => {
      const resolveSpy = vi.fn();
      const rejectSpy = vi.fn();
      kernelQueue.subscriptions.set(asKRef('kp99'), {
        resolve: resolveSpy,
        reject: rejectSpy,
      });
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko123'),
        message: { result: 'kp99' } as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const deliver = vi.fn().mockResolvedValue({ abort: true });
      // Sample at the end of the aborted crank: the sentinel error below kills
      // the run loop, which discards every subscription still waiting.
      let subscribedAfterAbort: boolean | undefined;
      let rejectedAfterAbort: boolean | undefined;
      (
        kernelStore.collectGarbage as unknown as MockInstance
      ).mockImplementation(() => {
        subscribedAfterAbort = kernelQueue.subscriptions.has(asKRef('kp99'));
        rejectedAfterAbort = rejectSpy.mock.calls.length > 0;
        throw new Error(STOP_RUN_LOOP);
      });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(kernelStore.rollbackCrank).toHaveBeenCalledWith('delivery');
      expect(rejectedAfterAbort).toBe(false);
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(subscribedAfterAbort).toBe(true);
    });
  });

  describe('crank savepoints', () => {
    /**
     * Deliver one item and then die inside `collectGarbage`. The throw has to
     * land there, after the crank result has been processed: a delivery that
     * threw would never reach the rollback decision these tests are about.
     *
     * @param crankResult - What the delivery reports.
     */
    async function deliverThenDie(crankResult: object): Promise<void> {
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: { result: 'kp99' } as KernelMessage,
      });
      (
        kernelStore.collectGarbage as unknown as MockInstance
      ).mockImplementation(() => {
        throw new Error(STOP_RUN_LOOP);
      });
      await expect(
        kernelQueue.run(vi.fn().mockResolvedValue(crankResult)),
      ).rejects.toThrow(STOP_RUN_LOOP);
    }

    it('takes the delivery savepoint inside the crank savepoint', async () => {
      await killRunLoop(new Error('crank exploded'));

      expect(
        (kernelStore.createCrankSavepoint as unknown as MockInstance).mock
          .calls,
      ).toStrictEqual([['crank'], ['delivery']]);
    });

    it('keeps a vat death recorded without an abort', async () => {
      // `vatPowers.exitVat` terminates gracefully, so nothing has rolled back
      // when `collectGarbage` throws.
      await deliverThenDie({ terminate: { vatId: 'v1', info: {} } });

      expect(kernelStore.rollbackCrank).not.toHaveBeenCalled();
    });

    it('keeps a vat death recorded by a termination that then threw', async () => {
      // `VatHandle.terminate` ends the worker's stream on its first line, so a
      // throw after that still leaves a vat nothing can deliver to.
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: { result: 'kp99' } as KernelMessage,
      });
      terminateVat.mockRejectedValueOnce(new Error('teardown exploded'));

      await expect(
        kernelQueue.run(
          vi.fn().mockResolvedValue({ terminate: { vatId: 'v1', info: {} } }),
        ),
      ).rejects.toThrow('teardown exploded');

      expect(kernelStore.rollbackCrank).not.toHaveBeenCalled();
    });

    it('keeps work a delivery marked irrevocable', async () => {
      await deliverThenDie({ irrevocable: true });

      expect(kernelStore.rollbackCrank).not.toHaveBeenCalled();
    });

    it('rolls a plain delivery failure back', async () => {
      await deliverThenDie({ abort: true });

      expect(
        (kernelStore.rollbackCrank as unknown as MockInstance).mock.calls,
      ).toStrictEqual([['delivery']]);
    });

    it('keeps the crank error when ending the crank fails too', async () => {
      const endCrankError = new Error('commit failed');
      (kernelStore.endCrank as unknown as MockInstance).mockImplementation(
        () => {
          throw endCrankError;
        },
      );

      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });
      const crankError = new Error('crank exploded');
      const deliver = vi.fn().mockRejectedValue(crankError);

      await expect(kernelQueue.run(deliver)).rejects.toMatchObject({
        message: expect.stringContaining('commit failed'),
        cause: crankError,
        errors: [crankError, endCrankError],
      });
    });

    it('reports a failed end of an otherwise healthy crank', async () => {
      (kernelStore.endCrank as unknown as MockInstance).mockImplementation(
        () => {
          throw new Error('commit failed');
        },
      );
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });

      const endCrankError = new Error('commit failed');
      (kernelStore.endCrank as unknown as MockInstance).mockImplementation(
        () => {
          throw endCrankError;
        },
      );

      await expect(kernelQueue.run(vi.fn())).rejects.toBe(endCrankError);
    });

    it('keeps a crank error of undefined distinguishable from none', async () => {
      (kernelStore.endCrank as unknown as MockInstance).mockImplementation(
        () => {
          throw new Error('commit failed');
        },
      );
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });

      await expect(
        kernelQueue.run(vi.fn().mockRejectedValue(undefined)),
      ).rejects.toThrow('could not be ended');
    });
  });

  describe('audit ordering', () => {
    /**
     * Deliver one item, then stop the loop from the second crank so the first
     * runs all the way through its flush.
     *
     * @param crankResult - What the delivery reports.
     */
    async function deliverOneItem(crankResult?: object): Promise<void> {
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: { result: 'kp99' } as KernelMessage,
      });
      (kernelStore.startCrank as unknown as MockInstance)
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error(STOP_RUN_LOOP);
        });

      await expect(
        kernelQueue.run(vi.fn().mockResolvedValue(crankResult)),
      ).rejects.toThrow(STOP_RUN_LOOP);
    }

    /**
     * @param method - A store method the crank calls.
     * @returns When it was first called, in mock invocation order.
     */
    function firstCallTo(method: unknown): number {
      return (method as MockInstance).mock.invocationCallOrder[0] as number;
    }

    it('audits before the flush answers anyone', async () => {
      await deliverOneItem();

      expect(firstCallTo(kernelStore.assertRefCountsIfAuditing)).toBeLessThan(
        firstCallTo(kernelStore.flushCrankBuffer),
      );
    });

    it('leaves an external caller unanswered when the audit fires', async () => {
      const resolveSpy = vi.fn();
      kernelQueue.subscriptions.set(asKRef('kp1'), {
        resolve: resolveSpy,
        reject: vi.fn(),
      });
      (kernelStore.flushCrankBuffer as unknown as MockInstance).mockReturnValue(
        [{ type: 'notify', endpointId: 'v1', kpid: 'kp1' }],
      );
      (
        kernelStore.assertRefCountsIfAuditing as unknown as MockInstance
      ).mockImplementation(() => {
        throw new Error('reference count invariant violated');
      });
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockReturnValueOnce(1);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko123',
        message: {} as KernelMessage,
      });

      await expect(kernelQueue.run(vi.fn())).rejects.toThrow(
        'reference count invariant violated',
      );

      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('flushes before it audits once a vat death has committed the crank', async () => {
      // Nothing can undo the crank now, so a queue row held back from the run
      // queue would keep the charge it was given with nothing to spend it on.
      await deliverOneItem({ terminate: { vatId: 'v1', info: {} } });

      expect(firstCallTo(kernelStore.flushCrankBuffer)).toBeLessThan(
        firstCallTo(kernelStore.assertRefCountsIfAuditing),
      );
    });
  });

  describe('one-item-per-crank', () => {
    it('calls startCrank/endCrank for each delivered item', async () => {
      const items: RunQueueItem[] = [
        { type: 'send', target: asKRef('ko1'), message: {} as KernelMessage },
        { type: 'send', target: asKRef('ko2'), message: {} as KernelMessage },
      ];
      let dequeueCount = 0;
      (
        kernelStore.runQueueLength as unknown as MockInstance
      ).mockImplementation(() => (dequeueCount < items.length ? 1 : 0));
      (kernelStore.dequeueRun as unknown as MockInstance).mockImplementation(
        () => {
          const item = items[dequeueCount];
          dequeueCount += 1;
          return item;
        },
      );
      let deliverCount = 0;
      const deliver = vi.fn().mockImplementation(async () => {
        deliverCount += 1;
        if (deliverCount >= items.length) {
          return Promise.reject(new Error('done'));
        }
        return Promise.resolve(undefined);
      });
      await expect(kernelQueue.run(deliver)).rejects.toThrow('done');
      // Two items delivered = two cranks = two startCrank + two endCrank calls
      expect(kernelStore.startCrank).toHaveBeenCalledTimes(2);
      expect(kernelStore.endCrank).toHaveBeenCalledTimes(2);
      expect(deliver).toHaveBeenCalledTimes(2);
    });
  });

  describe('invokeKernelSubscription', () => {
    it('calls reject for rejected promises', async () => {
      const rejectSpy = vi.fn();
      const resolveSpy = vi.fn();
      kernelQueue.subscriptions.set(asKRef('kp1'), {
        resolve: resolveSpy,
        reject: rejectSpy,
      });
      const rejectedValue = { body: '"error"', slots: [] };
      (kernelStore.flushCrankBuffer as unknown as MockInstance).mockReturnValue(
        [{ type: 'notify', endpointId: 'v1', kpid: 'kp1' }],
      );
      (kernelStore.getKernelPromise as unknown as MockInstance).mockReturnValue(
        {
          state: 'rejected',
          value: rejectedValue,
        },
      );
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko1'),
        message: {} as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const deliver = vi.fn().mockResolvedValue(undefined);
      // The second crank, so the first runs to its flush: the subscription
      // callbacks come after the audit now.
      (kernelStore.startCrank as unknown as MockInstance)
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error(STOP_RUN_LOOP);
        });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(rejectSpy).toHaveBeenCalledWith(rejectedValue);
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('calls resolve for fulfilled promises', async () => {
      const rejectSpy = vi.fn();
      const resolveSpy = vi.fn();
      kernelQueue.subscriptions.set(asKRef('kp1'), {
        resolve: resolveSpy,
        reject: rejectSpy,
      });
      const fulfilledValue = { body: '"ok"', slots: [] };
      (kernelStore.flushCrankBuffer as unknown as MockInstance).mockReturnValue(
        [{ type: 'notify', endpointId: 'v1', kpid: 'kp1' }],
      );
      (kernelStore.getKernelPromise as unknown as MockInstance).mockReturnValue(
        {
          state: 'fulfilled',
          value: fulfilledValue,
        },
      );
      const mockItem: RunQueueItem = {
        type: 'send',
        target: asKRef('ko1'),
        message: {} as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const deliver = vi.fn().mockResolvedValue(undefined);
      // The second crank, so the first runs to its flush: the subscription
      // callbacks come after the audit now.
      (kernelStore.startCrank as unknown as MockInstance)
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error(STOP_RUN_LOOP);
        });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(resolveSpy).toHaveBeenCalledWith(fulfilledValue);
      expect(rejectSpy).not.toHaveBeenCalled();
    });

    it('answers a subscription whose promise was collected before the flush', async () => {
      const resolveSpy = vi.fn();
      kernelQueue.subscriptions.set(asKRef('kp1'), {
        resolve: resolveSpy,
        reject: vi.fn(),
      });
      const fulfilledValue = { body: '"ok"', slots: [] };
      let collected = false;
      (
        kernelStore.getKernelPromise as unknown as MockInstance
      ).mockImplementation(() => {
        if (collected) {
          throw new Error('unknown kernel promise kp1');
        }
        return { state: 'unresolved', decider: 'v1', subscribers: [] };
      });
      (
        kernelStore.collectGarbage as unknown as MockInstance
      ).mockImplementation(() => {
        collected = true;
      });
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce({
        type: 'send',
        target: 'ko1',
        message: {} as KernelMessage,
      });
      // The vat resolves the promise mid-crank, so the answer waits for the
      // flush.
      const deliver = vi.fn().mockImplementation(async () => {
        kernelQueue.resolvePromises(
          v1,
          [[asKRef('kp1'), false, fulfilledValue]],
          false,
        );
        return undefined;
      });
      (kernelStore.startCrank as unknown as MockInstance)
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error(STOP_RUN_LOOP);
        });

      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

      expect(resolveSpy).toHaveBeenCalledWith(fulfilledValue);
    });
  });

  describe('GC actions for an offline endpoint', () => {
    it("passes run's isOffline to processGCActionSet", async () => {
      const isOffline = vi.fn();
      (gc.processGCActionSet as unknown as MockInstance).mockImplementationOnce(
        () => {
          throw new Error(STOP_RUN_LOOP);
        },
      );

      await expect(kernelQueue.run(vi.fn(), { isOffline })).rejects.toThrow(
        STOP_RUN_LOOP,
      );

      expect(gc.processGCActionSet).toHaveBeenCalledWith(kernelStore, {
        isOffline,
      });
    });

    it('wakes a parked run loop to look at them again', async () => {
      let wake!: () => void;
      const parked = new Promise<void>((resolve) => {
        wake = resolve;
      });
      (makePromiseKit as unknown as MockInstance).mockReturnValueOnce({
        promise: parked,
        resolve: wake,
        reject: vi.fn(),
      });
      (gc.processGCActionSet as unknown as MockInstance)
        .mockReturnValueOnce(null)
        .mockImplementationOnce(() => {
          throw new Error(STOP_RUN_LOOP);
        });

      const running = kernelQueue.run(vi.fn());
      await vi.waitFor(() =>
        expect(gc.processGCActionSet).toHaveBeenCalledOnce(),
      );
      kernelQueue.recheckGCActions();

      await expect(running).rejects.toThrow(STOP_RUN_LOOP);
      expect(gc.processGCActionSet).toHaveBeenCalledTimes(2);
    });

    it('does nothing to a run loop in the middle of a crank', async () => {
      let finishDelivery!: () => void;
      const deliver = vi.fn(
        async () =>
          new Promise<undefined>((resolve) => {
            finishDelivery = () => resolve(undefined);
          }),
      );
      (gc.processGCActionSet as unknown as MockInstance)
        .mockReturnValueOnce({
          type: 'dropExports',
          endpointId: 'v1',
          krefs: ['ko1'],
        })
        .mockImplementationOnce(() => {
          throw new Error(STOP_RUN_LOOP);
        });

      const running = kernelQueue.run(deliver);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      kernelQueue.recheckGCActions();
      finishDelivery();

      await expect(running).rejects.toThrow(STOP_RUN_LOOP);
      expect(gc.processGCActionSet).toHaveBeenCalledTimes(2);
    });
  });

  describe('waitForCrank', () => {
    it('handles when waitForCrank returns a delayed promise', async () => {
      let resolvePromise: ((value: void) => void) | undefined;
      const delayedPromise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });
      (kernelStore.waitForCrank as unknown as MockInstance).mockReturnValue(
        delayedPromise,
      );
      const waitPromise = kernelQueue.waitForCrank();
      const raceResult = await Promise.race([
        waitPromise,
        Promise.resolve('immediate'),
      ]);
      expect(raceResult).toBe('immediate');
      resolvePromise?.();
      await waitPromise;
      expect(kernelStore.waitForCrank).toHaveBeenCalledOnce();
    });
  });
});
