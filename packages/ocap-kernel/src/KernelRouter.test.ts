import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import { kser, kslot } from './liveslots/kernel-marshal.ts';
import type { KernelStore } from './store/index.ts';
import type {
  KernelMessage,
  RunQueueItem,
  RunQueueItemSend,
  RunQueueItemNotify,
  RunQueueItemGCAction,
  RunQueueItemBringOutYourDead,
  EndpointId,
  VatId,
  GCRunQueueType,
  CrankResult,
  EndpointHandle,
} from './types.ts';

describe('KernelRouter', () => {
  // Mock dependencies
  let kernelStore: KernelStore;
  let kernelQueue: KernelQueue;
  let getEndpoint: (
    endpointId: EndpointId,
  ) => EndpointHandle | Promise<EndpointHandle>;
  let endpointHandle: EndpointHandle;
  let restartVat: MockInstance<(vatId: VatId) => Promise<void>>;
  let kernelRouter: KernelRouter;

  beforeEach(() => {
    // Mock EndpointHandle with more detailed return values
    const mockCrankResult: CrankResult = { didDelivery: 'v1' };

    endpointHandle = {
      deliverMessage: vi.fn().mockResolvedValue(mockCrankResult),
      deliverNotify: vi.fn().mockResolvedValue(mockCrankResult),
      deliverDropExports: vi.fn().mockResolvedValue(mockCrankResult),
      deliverRetireExports: vi.fn().mockResolvedValue(mockCrankResult),
      deliverRetireImports: vi.fn().mockResolvedValue(mockCrankResult),
      deliverBringOutYourDead: vi.fn().mockResolvedValue(mockCrankResult),
    } as unknown as EndpointHandle;

    // Mock getEndpoint function
    getEndpoint = vi.fn().mockReturnValue(endpointHandle);

    // Mock KernelStore
    kernelStore = {
      getOwner: vi.fn(),
      isRevoked: vi.fn(),
      getKernelPromise: vi.fn(),
      decrementRefCount: vi.fn(),
      setPromiseDecider: vi.fn(),
      translateRefKtoE: vi.fn(
        (_endpointId: string, kref: string) => `translated-${kref}`,
      ) as unknown as MockInstance,
      translateMessageKtoE: vi.fn(
        (_endpointId: string, message: KernelMessage) => message,
      ) as unknown as MockInstance,
      enqueuePromiseMessage: vi.fn(),
      erefToKref: vi.fn() as unknown as MockInstance,
      krefToEref: vi.fn() as unknown as MockInstance,
      getKpidsToRetire: vi.fn().mockReturnValue([]),
      translateCapDataKtoE: vi.fn(),
      krefsToErefs: vi.fn((_endpointId: string, krefs: string[]) =>
        krefs.map((kref: string) => `translated-${kref}`),
      ) as unknown as MockInstance,
      clearReachableFlag: vi.fn(),
      deleteCListEntry: vi.fn(),
      forgetKref: vi.fn(),
      orphanKernelObject: vi.fn(),
      hasCListEntry: vi.fn().mockReturnValue(true),
      isVatTerminated: vi.fn().mockReturnValue(false),
      isVatActive: vi.fn().mockReturnValue(true),
      createCrankSavepoint: vi.fn(),
    } as unknown as KernelStore;

    // Mock KernelQueue
    kernelQueue = {
      resolvePromises: vi.fn(),
    } as unknown as KernelQueue;

    const mockInvokeKernelService = vi.fn();
    restartVat = vi.fn().mockResolvedValue(undefined);

    // Create the router to test
    kernelRouter = new KernelRouter(
      kernelStore,
      kernelQueue,
      getEndpoint,
      mockInvokeKernelService,
      restartVat,
    );
  });

  describe('deliver', () => {
    describe('send', () => {
      it('delivers a send message to a vat with an object target and returns crank results', async () => {
        // Setup the kernel store to return an owner for the target
        const endpointId = 'v1';
        const target = 'ko123';
        (kernelStore.getOwner as unknown as MockInstance).mockReturnValueOnce(
          endpointId,
        );

        // Create a mock crank result that the vat will return
        const mockCrankResult: CrankResult = {
          didDelivery: endpointId,
          abort: false,
        };
        (
          endpointHandle.deliverMessage as unknown as MockInstance
        ).mockResolvedValueOnce(mockCrankResult);

        // Create a send message
        const message: KernelMessage = {
          methargs: { body: 'method args', slots: ['ko1', 'ko2'] },
          result: 'kp1',
        };
        const sendItem: RunQueueItemSend = {
          type: 'send',
          target,
          message,
        };

        const result = await kernelRouter.deliver(sendItem);

        // Verify the message was delivered to the vat and results returned
        expect(getEndpoint).toHaveBeenCalledWith(endpointId);
        expect(endpointHandle.deliverMessage).toHaveBeenCalledWith(
          `translated-${target}`,
          message,
        );
        expect(result).toStrictEqual(mockCrankResult);
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          'ko1',
          'deliver|send|slot',
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          'ko2',
          'deliver|send|slot',
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          target,
          'deliver|send|target',
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          'kp1',
          'deliver|send|result',
        );
      });

      it('splats a message when target is revoked and returns undefined', async () => {
        // Setup the kernel store to return a revoked owner for the target
        (kernelStore.isRevoked as unknown as MockInstance).mockReturnValueOnce(
          true,
        );

        // Create a send message
        const target = 'ko123';
        const message: KernelMessage = {
          methargs: { body: 'method args', slots: ['ko1', 'ko2'] },
          result: 'kp1',
        };
        const sendItem: RunQueueItemSend = {
          type: 'send',
          target,
          message,
        };
        const result = await kernelRouter.deliver(sendItem);

        // Verify the message was not delivered to any vat and resources were cleaned up
        expect(getEndpoint).not.toHaveBeenCalled();
        expect(endpointHandle.deliverMessage).not.toHaveBeenCalled();
        expect(result).toBeUndefined();

        // Verify refcounts were decremented
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          target,
          'deliver|splat|target',
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          'ko1',
          'deliver|splat|slot',
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          'ko2',
          'deliver|splat|slot',
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          'kp1',
          'deliver|splat|result',
        );
        // Verify the promise was rejected with 'revoked object'
        expect(kernelQueue.resolvePromises).toHaveBeenCalledWith(
          undefined,
          expect.arrayContaining([
            expect.arrayContaining([
              'kp1',
              true,
              expect.objectContaining({
                body: expect.stringContaining('[KERNEL:OBJECT_REVOKED]'),
                slots: [],
              }),
            ]),
          ]),
        );
      });

      it('splats a message when target has no owner and returns undefined', async () => {
        // Setup the kernel store to return no owner for the target
        (kernelStore.getOwner as unknown as MockInstance).mockReturnValueOnce(
          null,
        );

        // Create a send message
        const target = 'ko123';
        const message: KernelMessage = {
          methargs: { body: 'method args', slots: ['ko1', 'ko2'] },
          result: 'kp1',
        };
        const sendItem: RunQueueItemSend = {
          type: 'send',
          target,
          message,
        };
        const result = await kernelRouter.deliver(sendItem);

        // Verify the message was not delivered to any vat and resources were cleaned up
        expect(getEndpoint).not.toHaveBeenCalled();
        expect(endpointHandle.deliverMessage).not.toHaveBeenCalled();
        expect(result).toBeUndefined();

        // Verify refcounts were decremented
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          target,
          'deliver|splat|target',
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          'ko1',
          'deliver|splat|slot',
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          'ko2',
          'deliver|splat|slot',
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          'kp1',
          'deliver|splat|result',
        );
        // Verify the promise was rejected with OBJECT_DELETED
        expect(kernelQueue.resolvePromises).toHaveBeenCalledWith(
          undefined,
          expect.arrayContaining([
            expect.arrayContaining([
              'kp1',
              true,
              expect.objectContaining({
                body: expect.stringContaining('[KERNEL:OBJECT_DELETED]'),
                slots: [],
              }),
            ]),
          ]),
        );
      });

      it('enqueues a message on an unresolved promise and returns undefined', async () => {
        // Setup a promise reference and unresolved promise in the kernel store
        const target = 'kp123';
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'unresolved',
          value: { body: JSON.stringify({ status: 'unresolved' }), slots: [] },
        });
        // Create a send message
        const message: KernelMessage = {
          methargs: { body: 'method args', slots: [] },
          result: null,
        };
        const sendItem: RunQueueItemSend = {
          type: 'send',
          target,
          message,
        };
        const result = await kernelRouter.deliver(sendItem);

        // Verify the message was enqueued on the promise
        expect(kernelStore.enqueuePromiseMessage).toHaveBeenCalledWith(
          target,
          message,
        );
        // Verify no vat interaction occurred
        expect(getEndpoint).not.toHaveBeenCalled();
        expect(endpointHandle.deliverMessage).not.toHaveBeenCalled();
        expect(result).toBeUndefined();

        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          target,
          'requeue|target',
        );
      });

      it('hands over every reference a requeued message carries', async () => {
        const target = 'kp123';
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({ state: 'unresolved' });
        const message: KernelMessage = {
          methargs: { body: 'method args', slots: ['ko1', 'ko2'] },
          result: 'kp9',
        };
        await kernelRouter.deliver({ type: 'send', target, message });

        expect(kernelStore.enqueuePromiseMessage).toHaveBeenCalledWith(
          target,
          message,
        );
        expect(
          (kernelStore.decrementRefCount as unknown as MockInstance).mock.calls,
        ).toStrictEqual([
          [target, 'requeue|target'],
          ['kp9', 'requeue|result'],
          ['ko1', 'requeue|slot'],
          ['ko2', 'requeue|slot'],
        ]);
      });

      it('charges the queued target, not the object a fulfilled promise routes to', async () => {
        // The one delivery where the two differ: the message was queued against
        // the promise, so the promise is what `enqueueSend` charged, while the
        // object it fulfilled to is held by the resolution instead.
        const target = 'kp123';
        const routedTarget = 'ko99';
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'fulfilled',
          value: kser(kslot(routedTarget)),
        });
        (kernelStore.getOwner as unknown as MockInstance).mockReturnValueOnce(
          'v1',
        );
        const message: KernelMessage = {
          methargs: { body: 'method args', slots: [] },
          result: null,
        };

        await kernelRouter.deliver({ type: 'send', target, message });

        expect(endpointHandle.deliverMessage).toHaveBeenCalledWith(
          `translated-${routedTarget}`,
          message,
        );
        expect(
          (kernelStore.decrementRefCount as unknown as MockInstance).mock.calls,
        ).toStrictEqual([[target, 'deliver|send|target']]);
      });

      // The same distinction, on the path that discovers the endpoint is gone
      // only after routing has already succeeded. Every other test of this
      // branch aims at a plain object, where the item's target and the routed
      // target are the same kref and the two spellings are indistinguishable.
      it('charges the promise, not the object it resolved to, when the endpoint is gone', async () => {
        const promiseId = 'kp123';
        const resolvedObject = 'ko456';
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'fulfilled',
          value: { body: '#"$0"', slots: [resolvedObject] },
        });
        (kernelStore.getOwner as unknown as MockInstance).mockReturnValue('v1');
        (
          kernelStore.isVatTerminated as unknown as MockInstance
        ).mockReturnValue(true);
        (getEndpoint as unknown as MockInstance).mockRejectedValueOnce(
          new Error('vat v1 not found'),
        );

        await kernelRouter.deliver({
          type: 'send',
          target: promiseId,
          message: {
            methargs: { body: 'method args', slots: [] },
            result: null,
          },
        });

        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          promiseId,
          'deliver|splat|target',
        );
        // Charging this instead leaks the promise and collects an object that
        // nobody released.
        expect(kernelStore.decrementRefCount).not.toHaveBeenCalledWith(
          resolvedObject,
          'deliver|splat|target',
        );
      });

      it('splats message when promise resolves to a non-object', async () => {
        // Setup a fulfilled promise that doesn't resolve to an object
        const promiseId = 'kp123';

        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'fulfilled',
          value: {
            body: JSON.stringify({ value: 'not an object' }),
            slots: [],
          },
        });

        // Create a send message to the promise
        const message: KernelMessage = {
          methargs: { body: 'method args', slots: [] },
          result: 'kp2',
        };
        const sendItem: RunQueueItemSend = {
          type: 'send',
          target: promiseId,
          message,
        };

        const result = await kernelRouter.deliver(sendItem);

        // Message should be splatted, not delivered
        expect(getEndpoint).not.toHaveBeenCalled();
        expect(endpointHandle.deliverMessage).not.toHaveBeenCalled();
        expect(result).toBeUndefined();

        // Verify the result promise was rejected with BAD_PROMISE_RESOLUTION
        expect(kernelQueue.resolvePromises).toHaveBeenCalledWith(
          undefined,
          expect.arrayContaining([
            expect.arrayContaining([
              'kp2',
              true,
              expect.objectContaining({
                body: expect.stringContaining(
                  '[KERNEL:BAD_PROMISE_RESOLUTION]',
                ),
              }),
            ]),
          ]),
        );
      });

      it('splats message when promise is rejected', async () => {
        // Setup a rejected promise
        const promiseId = 'kp123';
        const rejection = {
          body: JSON.stringify({ error: 'rejection reason' }),
          slots: [],
        };

        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'rejected',
          value: rejection,
        });

        // Create a send message to the promise
        const message: KernelMessage = {
          methargs: { body: 'method args', slots: [] },
          result: 'kp2',
        };
        const sendItem: RunQueueItemSend = {
          type: 'send',
          target: promiseId,
          message,
        };

        const result = await kernelRouter.deliver(sendItem);

        // Message should be splatted, not delivered
        expect(getEndpoint).not.toHaveBeenCalled();
        expect(endpointHandle.deliverMessage).not.toHaveBeenCalled();
        expect(result).toBeUndefined();

        // Verify the result promise was rejected with the same reason
        expect(kernelQueue.resolvePromises).toHaveBeenCalledWith(
          undefined,
          expect.arrayContaining([
            expect.arrayContaining(['kp2', true, rejection]),
          ]),
        );
      });

      it('propagates a lookup failure for a vat that is absent but not terminated', async () => {
        // Not a splat: reporting a live endpoint as unreachable would discard a
        // deliverable message and reject its result for no reason.
        (kernelStore.getOwner as unknown as MockInstance).mockReturnValueOnce(
          'v1',
        );
        (getEndpoint as unknown as MockInstance).mockImplementationOnce(() => {
          throw new Error('vat v1 not found');
        });

        await expect(
          kernelRouter.deliver({
            type: 'send',
            target: 'ko123',
            message: {
              methargs: { body: 'method args', slots: [] },
              result: 'kp1',
            } as unknown as SwingsetMessage,
          }),
        ).rejects.toThrow('vat v1 not found');

        expect(kernelQueue.resolvePromises).not.toHaveBeenCalled();
      });

      it('splats message with ENDPOINT_UNREACHABLE when endpoint vanishes', async () => {
        const endpointId = 'v1';
        const target = 'ko123';
        (kernelStore.getOwner as unknown as MockInstance).mockReturnValueOnce(
          endpointId,
        );
        // The endpoint is gone for good, which is what makes it a splat rather
        // than an error worth propagating.
        (
          kernelStore.isVatTerminated as unknown as MockInstance
        ).mockReturnValue(true);
        (getEndpoint as unknown as MockInstance).mockImplementationOnce(() => {
          throw new Error('vat not found');
        });
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({ decider: endpointId });

        const message: Message = {
          methargs: { body: 'method args', slots: [] },
          result: 'kp1',
        };
        const sendItem: RunQueueItemSend = {
          type: 'send',
          target,
          message: message as unknown as SwingsetMessage,
        };

        const result = await kernelRouter.deliver(sendItem);

        expect(result).toBeUndefined();
        expect(kernelQueue.resolvePromises).toHaveBeenCalledWith(
          endpointId,
          expect.arrayContaining([
            expect.arrayContaining([
              'kp1',
              true,
              expect.objectContaining({
                body: expect.stringContaining('[KERNEL:ENDPOINT_UNREACHABLE]'),
              }),
            ]),
          ]),
        );
      });

      it('rejects with DELIVERY_FAILED when endpoint.deliverMessage throws', async () => {
        const endpointId = 'v1';
        const target = 'ko123';
        (kernelStore.getOwner as unknown as MockInstance).mockReturnValueOnce(
          endpointId,
        );
        (
          endpointHandle.deliverMessage as unknown as MockInstance
        ).mockRejectedValueOnce(new Error('queue full'));

        const message: Message = {
          methargs: { body: 'method args', slots: [] },
          result: 'kp1',
        };
        const sendItem: RunQueueItemSend = {
          type: 'send',
          target,
          message: message as unknown as SwingsetMessage,
        };

        await kernelRouter.deliver(sendItem);

        expect(kernelQueue.resolvePromises).toHaveBeenCalledWith(
          endpointId,
          expect.arrayContaining([
            expect.arrayContaining([
              'kp1',
              true,
              expect.objectContaining({
                body: expect.stringContaining('[KERNEL:DELIVERY_FAILED]'),
              }),
            ]),
          ]),
        );
      });
    });

    describe('notify', () => {
      it('drops a notify whose endpoint is gone for good', async () => {
        // Reachable while a vat is being torn down: `provideVat` waits for the
        // teardown, then reports the vat gone. Without this the rejection escapes
        // the crank and kills the run loop.
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'fulfilled',
          value: { body: JSON.stringify({ value: 'v' }), slots: [] },
        });
        (kernelStore.krefToEref as unknown as MockInstance).mockReturnValueOnce(
          'p+123',
        );
        (
          kernelStore.isVatTerminated as unknown as MockInstance
        ).mockReturnValue(true);
        (getEndpoint as unknown as MockInstance).mockRejectedValueOnce(
          new Error('vat v1 not found'),
        );

        const result = await kernelRouter.deliver({
          type: 'notify',
          endpointId: 'v1',
          kpid: 'kp123',
        });

        expect(result).toStrictEqual({ didDelivery: 'v1' });
        expect(endpointHandle.deliverNotify).not.toHaveBeenCalled();
        // Resolved before the translation, which would otherwise mint c-list
        // entries for an endpoint that cannot be told about them.
        expect(kernelStore.translateRefKtoE).not.toHaveBeenCalled();
      });

      it('delivers a notify to a vat and returns crank results', async () => {
        const endpointId = 'v1';
        const kpid = 'kp123';
        const notifyItem: RunQueueItemNotify = {
          type: 'notify',
          endpointId,
          kpid,
        };

        // Mock a resolved promise
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'fulfilled',
          value: {
            body: JSON.stringify({ value: 'resolved value' }),
            slots: [],
          },
        });

        // Mock that this promise is in the vat's clist
        (kernelStore.krefToEref as unknown as MockInstance).mockReturnValueOnce(
          'p+123',
        );

        // Mock that there's a promise to retire
        (
          kernelStore.getKpidsToRetire as unknown as MockInstance
        ).mockReturnValueOnce([kpid]);

        // Mock the getKernelPromise for the target promise
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'fulfilled',
          value: {
            body: JSON.stringify({ value: 'target promise value' }),
            slots: [],
          },
        });

        // Mock crank results
        const mockCrankResult: CrankResult = { didDelivery: endpointId };
        (
          endpointHandle.deliverNotify as unknown as MockInstance
        ).mockResolvedValueOnce(mockCrankResult);

        // Deliver the notify
        const result = await kernelRouter.deliver(notifyItem);

        // Verify the notification was delivered to the vat
        expect(getEndpoint).toHaveBeenCalledWith(endpointId);
        expect(endpointHandle.deliverNotify).toHaveBeenCalledWith(
          expect.any(Array),
        );
        expect(kernelStore.decrementRefCount).toHaveBeenCalledWith(
          kpid,
          'deliver|notify',
        );
        expect(result).toStrictEqual(mockCrankResult);
      });

      it('returns didDelivery when promise is not in vat clist', async () => {
        const endpointId = 'v1';
        const kpid = 'kp123';
        const notifyItem: RunQueueItemNotify = {
          type: 'notify',
          endpointId,
          kpid,
        };

        // Mock a resolved promise
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'fulfilled',
          value: {
            body: JSON.stringify({ value: 'resolved value' }),
            slots: [],
          },
        });

        // Mock that this promise is NOT in the vat's clist
        (kernelStore.krefToEref as unknown as MockInstance).mockReturnValueOnce(
          null,
        );

        // Deliver the notify
        const result = await kernelRouter.deliver(notifyItem);

        // Verify no notification was delivered to the vat
        expect(endpointHandle.deliverNotify).not.toHaveBeenCalled();
        expect(result).toStrictEqual({ didDelivery: endpointId });
        // The notification's own reference is released on the way out, not
        // stranded by the early return.
        expect(
          (kernelStore.decrementRefCount as unknown as MockInstance).mock.calls,
        ).toStrictEqual([[kpid, 'deliver|notify']]);
      });

      it('returns didDelivery when no kpids to retire', async () => {
        const endpointId = 'v1';
        const kpid = 'kp123';
        const notifyItem: RunQueueItemNotify = {
          type: 'notify',
          endpointId,
          kpid,
        };

        // Mock a resolved promise
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'fulfilled',
          value: {
            body: JSON.stringify({ value: 'resolved value' }),
            slots: [],
          },
        });

        // Mock that this promise is in the vat's clist
        (kernelStore.krefToEref as unknown as MockInstance).mockReturnValueOnce(
          'p+123',
        );

        // Mock that there are no promises to retire
        (
          kernelStore.getKpidsToRetire as unknown as MockInstance
        ).mockReturnValueOnce([]);

        // Deliver the notify
        const result = await kernelRouter.deliver(notifyItem);

        // Verify no notification was delivered to the vat
        expect(endpointHandle.deliverNotify).not.toHaveBeenCalled();
        expect(result).toStrictEqual({ didDelivery: endpointId });
        expect(
          (kernelStore.decrementRefCount as unknown as MockInstance).mock.calls,
        ).toStrictEqual([[kpid, 'deliver|notify']]);
      });

      it('releases only the notified promise when others are retired with it', async () => {
        const endpointId = 'v1';
        const kpid = 'kp123';
        const alsoRetired = 'kp456';
        const resolved = {
          state: 'fulfilled',
          value: { body: JSON.stringify({ value: 'resolved' }), slots: [] },
        };
        (kernelStore.getKernelPromise as unknown as MockInstance)
          .mockReturnValueOnce(resolved)
          .mockReturnValue(resolved);
        (kernelStore.krefToEref as unknown as MockInstance).mockReturnValueOnce(
          'p+123',
        );
        (
          kernelStore.getKpidsToRetire as unknown as MockInstance
        ).mockReturnValueOnce([kpid, alsoRetired]);

        await kernelRouter.deliver({ type: 'notify', endpointId, kpid });

        // Only `enqueueNotify` charges a notification, and only for its own
        // kpid, so the promises settled alongside it are nobody's to release.
        expect(
          (kernelStore.decrementRefCount as unknown as MockInstance).mock.calls,
        ).toStrictEqual([[kpid, 'deliver|notify']]);
      });

      it('throws if notification is for an unresolved promise', async () => {
        const endpointId = 'v1';
        const kpid = 'kp123';
        const notifyItem: RunQueueItemNotify = {
          type: 'notify',
          endpointId,
          kpid,
        };

        // Mock an unresolved promise with no value
        (
          kernelStore.getKernelPromise as unknown as MockInstance
        ).mockReturnValueOnce({
          state: 'unresolved',
          value: null,
        });

        // Deliver the notify should throw with the expected error message
        await expect(kernelRouter.deliver(notifyItem)).rejects.toThrow(
          'no value for promise kp123',
        );
      });
    });

    describe('gc actions', () => {
      it.each([
        ['dropExports', 'deliverDropExports'],
        ['retireExports', 'deliverRetireExports'],
        ['retireImports', 'deliverRetireImports'],
      ])(
        'delivers %s to a vat and returns crank results',
        async (actionType, deliverMethod) => {
          const endpointId = 'v1';
          const krefs = ['ko1', 'ko2'];
          const gcAction: RunQueueItemGCAction = {
            type: actionType as GCRunQueueType,
            endpointId,
            krefs,
          };

          // Mock crank results
          const mockCrankResult: CrankResult = { didDelivery: endpointId };
          (
            endpointHandle[
              deliverMethod as keyof EndpointHandle
            ] as unknown as MockInstance
          ).mockResolvedValueOnce(mockCrankResult);

          // Deliver the GC action
          const result = await kernelRouter.deliver(gcAction);

          // Verify the action was delivered to the vat
          expect(getEndpoint).toHaveBeenCalledWith(endpointId);
          expect(
            endpointHandle[deliverMethod as keyof EndpointHandle],
          ).toHaveBeenCalledWith(krefs.map((kref) => `translated-${kref}`));
          expect(result).toStrictEqual(mockCrankResult);
        },
      );

      it('clears the reachable flag when delivering dropExports', async () => {
        await kernelRouter.deliver({
          type: 'dropExports',
          endpointId: 'v1',
          krefs: ['ko1', 'ko2'],
        });

        expect(
          (kernelStore.clearReachableFlag as unknown as MockInstance).mock
            .calls,
        ).toStrictEqual([
          ['v1', 'ko1'],
          ['v1', 'ko2'],
        ]);
        expect(kernelStore.deleteCListEntry).not.toHaveBeenCalled();
      });

      it.each(['retireExports', 'retireImports'] as const)(
        'tears down the c-list entry when delivering %s',
        async (actionType) => {
          await kernelRouter.deliver({
            type: actionType,
            endpointId: 'v1',
            krefs: ['ko1', 'ko2'],
          });

          expect(
            (kernelStore.deleteCListEntry as unknown as MockInstance).mock
              .calls,
          ).toStrictEqual([
            ['v1', 'ko1', 'translated-ko1'],
            ['v1', 'ko2', 'translated-ko2'],
          ]);
        },
      );

      it('orphans the object when delivering retireExports', async () => {
        await kernelRouter.deliver({
          type: 'retireExports',
          endpointId: 'v1',
          krefs: ['ko1', 'ko2'],
        });

        // The owner has given up the last name for the object, so the kernel's
        // record of who owns it must go too or it outlives every reference.
        expect(
          (kernelStore.orphanKernelObject as unknown as MockInstance).mock
            .calls,
        ).toStrictEqual([
          ['ko1', 'v1'],
          ['ko2', 'v1'],
        ]);
      });

      it('leaves ownership alone when delivering retireImports', async () => {
        await kernelRouter.deliver({
          type: 'retireImports',
          endpointId: 'v1',
          krefs: ['ko1'],
        });

        expect(kernelStore.orphanKernelObject).not.toHaveBeenCalled();
      });

      it('waits for a vat that is coming back, then delivers to it', async () => {
        // The restart window: `provideVat` answers once the new incarnation is
        // up, so the crank waits instead of resolving a live vat as a dead one.
        let finishRestart!: (handle: EndpointHandle) => void;
        (getEndpoint as unknown as MockInstance).mockReturnValueOnce(
          new Promise<EndpointHandle>((resolve) => {
            finishRestart = resolve;
          }),
        );

        const delivered = kernelRouter.deliver({
          type: 'retireImports',
          endpointId: 'v1',
          krefs: ['ko1'],
        });

        // Nothing is released ahead of knowing where the action is going.
        expect(kernelStore.deleteCListEntry).not.toHaveBeenCalled();

        finishRestart(endpointHandle);
        await delivered;

        expect(endpointHandle.deliverRetireImports).toHaveBeenCalledWith([
          'translated-ko1',
        ]);
        expect(kernelStore.deleteCListEntry).toHaveBeenCalledWith(
          'v1',
          'ko1',
          'translated-ko1',
        );
      });

      it('still releases the kernel side when a terminated vat has vanished', async () => {
        getEndpoint.mockImplementationOnce(() => {
          throw Error('vat v1 not found');
        });
        (
          kernelStore.isVatTerminated as unknown as MockInstance
        ).mockReturnValue(true);

        const result = await kernelRouter.deliver({
          type: 'retireImports',
          endpointId: 'v1',
          krefs: ['ko1'],
        });

        expect(result).toStrictEqual({ didDelivery: 'v1' });
        // The action has already been consumed, so skipping the teardown would
        // lose it and leave the entry behind for good
        expect(kernelStore.deleteCListEntry).toHaveBeenCalledWith(
          'v1',
          'ko1',
          'translated-ko1',
        );
      });

      it('still releases the kernel side when a remote has vanished', async () => {
        getEndpoint.mockImplementationOnce(() => {
          throw Error('remote r1 not found');
        });

        const result = await kernelRouter.deliver({
          type: 'retireImports',
          endpointId: 'r1',
          krefs: ['ko1'],
        });

        expect(result).toStrictEqual({ didDelivery: 'r1' });
        expect(kernelStore.deleteCListEntry).toHaveBeenCalledWith(
          'r1',
          'ko1',
          'translated-ko1',
        );
      });

      it.each(['dropExports', 'retireExports', 'retireImports'] as const)(
        'refuses to release %s for a vat that is absent but not terminated',
        async (actionType) => {
          // A vat between incarnations still holds every one of these krefs, so
          // committing the kernel's release would leave the two disagreeing.
          getEndpoint.mockImplementationOnce(() => {
            throw Error('vat v1 not found');
          });

          await expect(
            kernelRouter.deliver({
              type: actionType,
              endpointId: 'v1',
              krefs: ['ko1'],
            }),
          ).rejects.toThrow('vat v1 not found');

          expect(kernelStore.clearReachableFlag).not.toHaveBeenCalled();
          expect(kernelStore.deleteCListEntry).not.toHaveBeenCalled();
          expect(kernelStore.orphanKernelObject).not.toHaveBeenCalled();
        },
      );

      it('skips krefs already cleaned up before delivery', async () => {
        (
          kernelStore.hasCListEntry as unknown as MockInstance
        ).mockImplementation(
          (_endpointId: string, kref: string) => kref === 'ko1',
        );

        await kernelRouter.deliver({
          type: 'retireImports',
          endpointId: 'v1',
          krefs: ['ko1', 'ko2'],
        });

        expect(
          (kernelStore.deleteCListEntry as unknown as MockInstance).mock.calls,
        ).toStrictEqual([['v1', 'ko1', 'translated-ko1']]);
      });

      it('does nothing when every kref is already gone', async () => {
        (kernelStore.hasCListEntry as unknown as MockInstance).mockReturnValue(
          false,
        );

        const result = await kernelRouter.deliver({
          type: 'retireImports',
          endpointId: 'v1',
          krefs: ['ko1'],
        });

        expect(result).toStrictEqual({ didDelivery: 'v1' });
        expect(kernelStore.deleteCListEntry).not.toHaveBeenCalled();
        expect(endpointHandle.deliverRetireImports).not.toHaveBeenCalled();
      });

      it('rolls back and terminates the vat when delivery fails', async () => {
        (
          endpointHandle.deliverRetireImports as unknown as MockInstance
        ).mockRejectedValueOnce(Error('endpoint went away mid-delivery'));

        const result = await kernelRouter.deliver({
          type: 'retireImports',
          endpointId: 'v1',
          krefs: ['ko1'],
        });

        // Committing the release while v1 still holds the eref would leave the
        // two disagreeing, and v1 would mint a fresh kref for the same object
        expect(result?.abort).toBe(true);
        expect(result?.terminate?.vatId).toBe('v1');
      });

      it('does not retry a remote that refuses the delivery', async () => {
        (
          endpointHandle.deliverRetireImports as unknown as MockInstance
        ).mockRejectedValueOnce(Error('remote queue full'));

        const result = await kernelRouter.deliver({
          type: 'retireImports',
          endpointId: 'r1',
          krefs: ['ko1'],
        });

        // Aborting would restore the action, and GC actions are selected ahead
        // of all other work, so a remote that keeps refusing would be handed
        // this same item every crank and nothing else would ever run
        expect(result).toStrictEqual({ didDelivery: 'r1' });
      });
    });

    describe('bringOutYourDead', () => {
      it('skips a reap whose endpoint is gone for good', async () => {
        (
          kernelStore.isVatTerminated as unknown as MockInstance
        ).mockReturnValue(true);
        (getEndpoint as unknown as MockInstance).mockRejectedValueOnce(
          new Error('vat v1 not found'),
        );

        const result = await kernelRouter.deliver({
          type: 'bringOutYourDead',
          endpointId: 'v1',
        });

        // A reap only asks an endpoint to tidy up, so one that is gone has
        // nothing left to ask — and nothing was delivered.
        expect(result).toBeUndefined();
        expect(endpointHandle.deliverBringOutYourDead).not.toHaveBeenCalled();
      });

      // Nothing purges the reap queue when a vat dies, and cleanup ends by
      // *unmarking* the vat it finished — so a reap scheduled before the vat
      // died arrives at an endpoint that is neither present nor terminated.
      // Read as a disagreement, that throw kills the run loop.
      it('skips a reap for a vat that has already been cleaned up', async () => {
        (
          kernelStore.isVatTerminated as unknown as MockInstance
        ).mockReturnValue(false);
        (kernelStore.isVatActive as unknown as MockInstance).mockReturnValue(
          false,
        );
        (getEndpoint as unknown as MockInstance).mockRejectedValueOnce(
          new Error('vat v1 not found'),
        );

        const result = await kernelRouter.deliver({
          type: 'bringOutYourDead',
          endpointId: 'v1',
        });

        expect(result).toBeUndefined();
        expect(endpointHandle.deliverBringOutYourDead).not.toHaveBeenCalled();
      });

      it('delivers bringOutYourDead to a vat and returns crank results', async () => {
        const endpointId = 'v1';
        const bringOutYourDeadItem: RunQueueItemBringOutYourDead = {
          type: 'bringOutYourDead',
          endpointId,
        };

        // Mock crank results
        const mockCrankResult: CrankResult = { didDelivery: endpointId };
        (
          endpointHandle.deliverBringOutYourDead as unknown as MockInstance
        ).mockResolvedValueOnce(mockCrankResult);

        // Deliver the bringOutYourDead action
        const result = await kernelRouter.deliver(bringOutYourDeadItem);

        // Verify the action was delivered to the endpoint
        expect(getEndpoint).toHaveBeenCalledWith(endpointId);
        expect(endpointHandle.deliverBringOutYourDead).toHaveBeenCalled();
        expect(result).toStrictEqual(mockCrankResult);
      });
    });

    describe('restartVat', () => {
      it('carries out a queued restart and reports no delivery', async () => {
        // Not a delivery: nothing was handed to the vat, and the incarnation that
        // comes back has taken none yet.
        const result = await kernelRouter.deliver({
          type: 'restartVat',
          vatId: 'v1',
        });

        expect(restartVat).toHaveBeenCalledWith('v1');
        expect(result).toBeUndefined();
      });

      it('lets a failed restart take the crank down', async () => {
        // Aborting would undo the terminated mark that makes the half-restarted
        // vat's c-list reclaimable.
        restartVat.mockRejectedValueOnce(new Error('worker died'));

        await expect(
          kernelRouter.deliver({ type: 'restartVat', vatId: 'v1' }),
        ).rejects.toThrow('worker died');
      });
    });

    it('throws on unknown run queue item type', async () => {
      // @ts-expect-error - deliberately using an invalid type
      const invalidItem: RunQueueItem = { type: 'invalid' };
      await expect(kernelRouter.deliver(invalidItem)).rejects.toThrow(
        'unsupported or unknown run queue item type',
      );
    });
  });
});
