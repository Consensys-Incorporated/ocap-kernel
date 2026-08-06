import type { VatOneResolution } from '@agoric/swingset-liveslots';
import type { CapData } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

import * as gc from './garbage-collection/garbage-collection.ts';
import { KernelQueue } from './KernelQueue.ts';
import type { KernelStore } from './store/index.ts';
import * as types from './types.ts';
import type { KRef, KernelMessage, RunQueueItem } from './types.ts';

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
  let terminateVat: (vatId: string, reason?: CapData<KRef>) => Promise<void>;

  beforeEach(() => {
    mockPromiseKit = {
      promise: Promise.resolve(),
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    (makePromiseKit as unknown as MockInstance).mockReturnValue(mockPromiseKit);

    terminateVat = vi.fn().mockResolvedValue(undefined);

    kernelStore = {
      nextTerminatedVatCleanup: vi.fn(),
      collectGarbage: vi.fn(),
      assertRefCountsIfAuditing: vi.fn(),
      runQueueLength: vi.fn(),
      dequeueRun: vi.fn(),
      enqueueRun: vi.fn(),
      initKernelPromise: vi.fn().mockReturnValue(['kp1']),
      incrementRefCount: vi.fn(),
      getKernelPromise: vi.fn(),
      resolveKernelPromise: vi.fn().mockReturnValue([]),
      nextReapAction: vi.fn().mockReturnValue(null),
      getGCActions: vi.fn().mockReturnValue([]),
      startCrank: vi.fn(),
      endCrank: vi.fn(),
      createCrankSavepoint: vi.fn(),
      rollbackCrank: vi.fn(),
      waitForCrank: vi.fn(),
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

  describe('run', () => {
    it('processes items from the run queue and performs cleanup', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: 'ko123',
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
      expect(kernelStore.createCrankSavepoint).toHaveBeenCalledWith('start');
      expect(processGCActionSetSpy).toHaveBeenCalled();
      expect(kernelStore.nextReapAction).toHaveBeenCalled();
      expect(kernelStore.nextTerminatedVatCleanup).toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledWith(mockItem);
      expect(kernelStore.endCrank).toHaveBeenCalled();
    });

    it('rolls back crank when deliver returns abort', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: 'ko123',
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
      expect(kernelStore.createCrankSavepoint).toHaveBeenCalledWith('start');
      expect(deliver).toHaveBeenCalledWith(mockItem);
      expect(kernelStore.rollbackCrank).toHaveBeenCalledWith('start');
      expect(kernelStore.collectGarbage).toHaveBeenCalled();
      expect(kernelStore.endCrank).toHaveBeenCalled();
    });

    it('terminates vat when deliver returns terminate', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: 'ko123',
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

    // `#flushCrankBuffer` settles the promise `enqueueMessage` handed an external
    // caller, reading the resolution out of the store on the way. Rolling the
    // crank back afterwards un-resolves that promise in the store and restores
    // the run queue item, so a restart delivers the message a second time and
    // notifies every other subscriber again — while the original caller has
    // already been told the first answer.
    it('does not roll back a crank whose result the caller already received', async () => {
      const mockItem: RunQueueItem = {
        type: 'send',
        target: 'ko123',
        message: { result: 'kp1' } as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );

      // A caller is awaiting this message's result.
      const resolve = vi.fn();
      const reject = vi.fn();
      kernelQueue.subscriptions.set('kp1', { resolve, reject });

      // The crank succeeds, so the flush hands that caller its answer...
      (
        kernelStore.flushCrankBuffer as unknown as MockInstance
      ).mockReturnValueOnce([
        { type: 'notify', endpointId: 'v1', kpid: 'kp1' },
      ]);
      (kernelStore.getKernelPromise as unknown as MockInstance).mockReturnValue(
        {
          state: 'fulfilled',
          value: { body: '"answer"', slots: [] },
        },
      );

      // ...and only then does the kernel die, in work that runs after the flush.
      const terminationError = new Error('vat worker already gone');
      (terminateVat as unknown as MockInstance).mockRejectedValueOnce(
        terminationError,
      );
      const deliver = vi.fn().mockResolvedValue({
        terminate: { vatId: 'v1', info: { body: '"exit"', slots: [] } },
      });

      await expect(kernelQueue.run(deliver)).rejects.toBe(terminationError);

      expect(resolve).toHaveBeenCalledWith({ body: '"answer"', slots: [] });
      expect(kernelStore.rollbackCrank).not.toHaveBeenCalled();
    });

    // `rollbackCrank('start')` rolls back the crank's outermost savepoint, which
    // ends the transaction — so anything the crank does to the store afterwards
    // autocommits piecemeal and no rollback can reach it. Whatever the ordering,
    // the rollback has to be the last thing the crank asks of the store.
    it.each([
      { label: 'an abort', crankResult: { abort: true } },
      {
        label: 'an abort that also terminates',
        crankResult: {
          abort: true,
          terminate: { vatId: 'v1', info: { body: '"exit"', slots: [] } },
        },
      },
    ])(
      'does no store work after rolling back $label',
      async ({ crankResult }) => {
        const mockItem: RunQueueItem = {
          type: 'send',
          target: 'ko123',
          message: { result: 'kp99' } as KernelMessage,
        };
        (kernelStore.runQueueLength as unknown as MockInstance)
          .mockReturnValueOnce(1)
          .mockReturnValue(0);
        (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
          mockItem,
        );

        const storeCalls: string[] = [];
        (
          kernelStore.rollbackCrank as unknown as MockInstance
        ).mockImplementation(() => {
          storeCalls.push('rollbackCrank');
        });
        (terminateVat as unknown as MockInstance).mockImplementation(
          async () => {
            storeCalls.push('terminateVat');
          },
        );
        (
          kernelStore.collectGarbage as unknown as MockInstance
        ).mockImplementation(() => {
          storeCalls.push('collectGarbage');
          throw new Error(STOP_RUN_LOOP);
        });

        const deliver = vi.fn().mockResolvedValue(crankResult);
        await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);

        expect(storeCalls).toContain('rollbackCrank');
        expect(storeCalls.at(-1)).toBe('rollbackCrank');
      },
    );
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
      const resultPromise = kernelQueue.enqueueMessage('ko123', 'test', []);
      expect(kernelQueue.subscriptions.has('kp1')).toBe(true);

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
        kernelQueue.enqueueMessage('ko123', 'test', []),
      ).rejects.toThrow('Kernel run loop died; cannot queue a message');
      expect(kernelStore.enqueueRun).not.toHaveBeenCalled();
    });

    it('rolls back the crank it died in', async () => {
      await killRunLoop(new Error('crank exploded'));
      // Without this, endCrank's savepoint release commits the half-finished
      // crank and the dequeued item is lost.
      expect(kernelStore.rollbackCrank).toHaveBeenCalledWith('start');
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
    // `finally` that records the attempt, the abort path leaves the flag unset,
    // the catch asks again, and "no such savepoint" becomes the reason the
    // kernel reports for its own death — the database error reaching nobody,
    // since only `error.message` crosses the wire.
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
        { type: 'send', target: 'ko1', message: {} as KernelMessage },
        { type: 'send', target: 'ko2', message: {} as KernelMessage },
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
          queue.resolvePromises('v1', [
            ['kp1', true, { body: 'x', slots: [] }],
          ]),
        didWork: () => kernelStore.resolveKernelPromise,
      },
      {
        teardown: 'enqueueNotify',
        call: (queue: KernelQueue) => queue.enqueueNotify('v1', 'kp1'),
        didWork: () => kernelStore.enqueueRun,
      },
      {
        teardown: 'enqueueSend',
        call: (queue: KernelQueue) =>
          queue.enqueueSend('ko123', {
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
      await kernelQueue.enqueueMessage('ko123', 'method', []);
      expect(kernelQueue.subscriptions.has('kp1')).toBe(true);

      await expect(kernelQueue.run(deliver)).rejects.toThrow(
        'run loop already started',
      );

      expect(kernelQueue.getRunLoopStatus()).toStrictEqual({
        state: 'running',
      });
      expect(kernelQueue.subscriptions.has('kp1')).toBe(true);
    });
  });

  describe('enqueueMessage', () => {
    it('creates a message, enqueues it, and returns a promise for the result', async () => {
      const target = 'ko123';
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
      expect(kernelQueue.subscriptions.has('kp1')).toBe(true);
      const subscription = kernelQueue.subscriptions.get('kp1');
      expect(subscription).toStrictEqual({
        resolve: expect.any(Function),
        reject: expect.any(Function),
      });
      resolvePromise(resultValue);
      const result = await resultPromise;
      expect(result).toStrictEqual(resultValue);
    });
  });

  describe('enqueueSend', () => {
    it('enqueues a send message and increments reference counts', () => {
      const target = 'ko123';
      const message: KernelMessage = {
        methargs: { body: 'method args', slots: ['ko1', 'ko2'] },
        result: 'kp2',
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
      const target = 'ko123';
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
      const endpointId = 'v1';
      const kpid = 'kp123';
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

  describe('resolvePromises', () => {
    it('resolves kernel promises and buffers notifications for subscribers', () => {
      const endpointId = 'v1';
      const kpid = 'kp123';
      const resolution: VatOneResolution = [
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

    it('handles resolutions with undefined vatId (kernel decider)', () => {
      const kpid = 'kp123';
      const resolution: VatOneResolution = [
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
      const endpointId = 'v1';
      const kpid = 'kp3';
      const resolution: VatOneResolution = [
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
      const endpointId = 'v1';
      const kpid = 'kp123';
      const resolution: VatOneResolution = [
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
      const endpointId = 'v1';
      const wrongEndpointId = 'v2';
      const kpid = 'kp123';
      const resolution: VatOneResolution = [
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
      kernelQueue.subscriptions.set('kp99', {
        resolve: vi.fn(),
        reject: rejectSpy,
      });
      const mockItem: RunQueueItem = {
        type: 'send',
        target: 'ko123',
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
      expect(kernelStore.rollbackCrank).toHaveBeenCalledWith('start');
      expect(rejectSpy).toHaveBeenCalledWith(terminateInfo);
      expect(kernelQueue.subscriptions.has('kp99')).toBe(false);
    });

    it('preserves the subscription when abort without terminate', async () => {
      const resolveSpy = vi.fn();
      const rejectSpy = vi.fn();
      kernelQueue.subscriptions.set('kp99', {
        resolve: resolveSpy,
        reject: rejectSpy,
      });
      const mockItem: RunQueueItem = {
        type: 'send',
        target: 'ko123',
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
        subscribedAfterAbort = kernelQueue.subscriptions.has('kp99');
        rejectedAfterAbort = rejectSpy.mock.calls.length > 0;
        throw new Error(STOP_RUN_LOOP);
      });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(kernelStore.rollbackCrank).toHaveBeenCalledWith('start');
      expect(rejectedAfterAbort).toBe(false);
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(subscribedAfterAbort).toBe(true);
    });
  });

  describe('one-item-per-crank', () => {
    it('calls startCrank/endCrank for each delivered item', async () => {
      const items: RunQueueItem[] = [
        { type: 'send', target: 'ko1', message: {} as KernelMessage },
        { type: 'send', target: 'ko2', message: {} as KernelMessage },
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
      kernelQueue.subscriptions.set('kp1', {
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
        target: 'ko1',
        message: {} as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const deliver = vi.fn().mockResolvedValue(undefined);
      (
        kernelStore.collectGarbage as unknown as MockInstance
      ).mockImplementation(() => {
        throw new Error(STOP_RUN_LOOP);
      });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(rejectSpy).toHaveBeenCalledWith(rejectedValue);
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('calls resolve for fulfilled promises', async () => {
      const rejectSpy = vi.fn();
      const resolveSpy = vi.fn();
      kernelQueue.subscriptions.set('kp1', {
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
        target: 'ko1',
        message: {} as KernelMessage,
      };
      (kernelStore.runQueueLength as unknown as MockInstance)
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      (kernelStore.dequeueRun as unknown as MockInstance).mockReturnValueOnce(
        mockItem,
      );
      const deliver = vi.fn().mockResolvedValue(undefined);
      (
        kernelStore.collectGarbage as unknown as MockInstance
      ).mockImplementation(() => {
        throw new Error(STOP_RUN_LOOP);
      });
      await expect(kernelQueue.run(deliver)).rejects.toThrow(STOP_RUN_LOOP);
      expect(resolveSpy).toHaveBeenCalledWith(fulfilledValue);
      expect(rejectSpy).not.toHaveBeenCalled();
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
