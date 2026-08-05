import type { VatOneResolution } from '@agoric/swingset-liveslots';
import type { CapData } from '@endo/marshal';
import { Logger } from '@metamask/logger';

import { KernelQueue } from './KernelQueue.ts';
import {
  makeFatalKernelError,
  makeKernelError,
} from './liveslots/kernel-marshal.ts';
import type { KernelStore } from './store/index.ts';
import { extractSingleRef } from './store/utils/extract-ref.ts';
import { parseRef } from './store/utils/parse-ref.ts';
import { isPromiseRef } from './store/utils/promise-ref.ts';
import type {
  EndpointId,
  EndpointHandle,
  ERef,
  KRef,
  KernelMessage,
  RunQueueItem,
  RunQueueItemSend,
  RunQueueItemBringOutYourDead,
  RunQueueItemNotify,
  RunQueueItemGCAction,
  CrankResult,
} from './types.ts';
import { isVatId } from './types.ts';
import { assert, Fail } from './utils/assert.ts';

type MessageRoute = {
  endpointId?: EndpointId | 'kernel';
  target: KRef;
} | null;

/**
 * The KernelRouter is responsible for routing messages to the correct endpoint.
 *
 * This class is responsible for routing messages to the correct endpoint, including
 * sending messages, resolving promises, and dropping imports.
 */
export class KernelRouter {
  /** The kernel's store. */
  readonly #kernelStore: KernelStore;

  /** The kernel's queue. */
  readonly #kernelQueue: KernelQueue;

  /** A function that returns an endpoint handle for a given endpoint id. */
  readonly #getEndpoint: (endpointId: EndpointId) => EndpointHandle;

  /** A function that invokes a method on a kernel service. */
  readonly #invokeKernelService: (target: KRef, message: KernelMessage) => void;

  /** The logger, if any. */
  readonly #logger: Logger | undefined;

  /**
   * Construct a new KernelRouter.
   *
   * @param kernelStore - The kernel's store.
   * @param kernelQueue - The kernel's queue.
   * @param getEndpoint - A function that returns an endpoint handle for a given endpoint id.
   * @param invokeKernelService - A function that calls a method on a kernel service object.
   * @param logger - The logger. If not provided, no logging will be done.
   */
  constructor(
    kernelStore: KernelStore,
    kernelQueue: KernelQueue,
    getEndpoint: (endpointId: EndpointId) => EndpointHandle,
    invokeKernelService: (target: KRef, message: KernelMessage) => void,
    logger?: Logger,
  ) {
    this.#kernelStore = kernelStore;
    this.#kernelQueue = kernelQueue;
    this.#getEndpoint = getEndpoint;
    this.#invokeKernelService = invokeKernelService;
    this.#logger = logger;
  }

  /**
   * Deliver a run queue item to its target.
   *
   * If the item being delivered is message whose target is a promise, it is
   * delivered based on the kernel's model of the promise's state:
   * - unresolved: it is put onto the queue that the kernel maintains for that promise
   * - fulfilled: it is forwarded to the promise resolution target
   * - rejected: the result promise of the message is in turn rejected according
   *   to the kernel's model of the promise's rejection value
   *
   * If the item being delivered is a notification, the kernel's model of the
   * state of the promise being notified is updated, and any queue items
   * enqueued for that promise are placed onto the run queue. The notification
   * is also forwarded to all of the promise's registered subscribers.
   *
   * @param item - The message/notification to deliver.
   * @returns The crank outcome.
   */
  async deliver(item: RunQueueItem): Promise<CrankResult | undefined> {
    switch (item.type) {
      case 'send':
        return await this.#deliverSend(item);
      case 'notify':
        return await this.#deliverNotify(item);
      case 'dropExports':
      case 'retireExports':
      case 'retireImports':
        return await this.#deliverGCAction(item);
      case 'bringOutYourDead':
        return await this.#deliverBringOutYourDead(item);
      default:
        // @ts-expect-error Runtime does not respect "never".
        Fail`unsupported or unknown run queue item type ${item.type}`;
    }
    return undefined;
  }

  /**
   * Determine a message's destination route based on the target type and
   * state. In the most general case, this route consists of an endpointId and a
   * destination object reference.
   *
   * There are three possible outcomes:
   * - splat: message should be dropped (with optional error resolution),
   *   indicated by a null return value
   * - send: message should be delivered to a specific object at a specific endpoint
   * - requeue: message should be put back on the run queue for later delivery
   *   (for unresolved promises), indicated by absence of a target endpoint in the
   *   return value
   *
   * @param item - The message to route.
   * @returns the route for the message.
   */
  #routeMessage(item: RunQueueItemSend): MessageRoute {
    const { target, message } = item;

    const routeAsSplat = (error?: CapData<KRef>): MessageRoute => {
      if (message.result && error) {
        // Use the current decider as the resolver. After a crank rollback,
        // the decider may have reverted to the sending vat rather than the
        // (now-terminated) target vat.
        const promise = this.#kernelStore.getKernelPromise(message.result);
        this.#kernelQueue.resolvePromises(promise?.decider, [
          [message.result, true, error],
        ]);
      }
      return null;
    };
    const routeAsSend = (targetObject: KRef): MessageRoute => {
      if (this.#kernelStore.isRevoked(targetObject)) {
        return routeAsSplat(
          makeKernelError('OBJECT_REVOKED', 'Target object has been revoked'),
        );
      }
      const endpointId = this.#kernelStore.getOwner(targetObject);
      if (!endpointId) {
        return routeAsSplat(
          makeKernelError(
            'OBJECT_DELETED',
            'Target object has no owner; it may have been deleted',
          ),
        );
      }
      return { endpointId, target: targetObject };
    };
    const routeAsRequeue = (targetObject: KRef): MessageRoute => {
      return { target: targetObject };
    };

    if (isPromiseRef(target)) {
      const promise = this.#kernelStore.getKernelPromise(target);
      switch (promise.state) {
        case 'fulfilled': {
          if (promise.value) {
            const targetObject = extractSingleRef(promise.value);
            if (targetObject) {
              if (isPromiseRef(targetObject)) {
                return routeAsRequeue(targetObject);
              }
              return routeAsSend(targetObject);
            }
          }
          return routeAsSplat(
            makeKernelError(
              'BAD_PROMISE_RESOLUTION',
              'Promise fulfilled but did not contain an object reference',
            ),
          );
        }
        case 'rejected':
          return routeAsSplat(promise.value);
        case 'unresolved':
          return routeAsRequeue(target);
        default:
          throw Fail`unknown promise state ${promise.state}`;
      }
    } else {
      return routeAsSend(target);
    }
  }

  /**
   * Deliver a 'send' run queue item.
   *
   * @param item - The send item to deliver.
   * @returns The crank outcome.
   */
  async #deliverSend(item: RunQueueItemSend): Promise<CrankResult | undefined> {
    const route = this.#routeMessage(item);
    let crankResult: CrankResult | undefined;

    // Message went splat
    if (!route) {
      this.#kernelStore.decrementRefCount(item.target, 'deliver|splat|target');
      if (item.message.result) {
        this.#kernelStore.decrementRefCount(
          item.message.result,
          'deliver|splat|result',
        );
      }
      for (const slot of item.message.methargs.slots) {
        this.#kernelStore.decrementRefCount(slot, 'deliver|splat|slot');
      }
      this.#logger?.log(
        `@@@@ message went splat ${item.target}<-${JSON.stringify(item.message)}`,
      );
      return crankResult;
    }

    const { endpointId, target } = route;
    const { message } = item;
    this.#logger?.log(
      `@@@@ deliver ${endpointId} send ${target}<-${JSON.stringify(message)}`,
    );
    if (endpointId) {
      const isKernelServiceMessage = endpointId === 'kernel';
      let endpoint: EndpointHandle | null = null;
      if (!isKernelServiceMessage) {
        try {
          endpoint = this.#getEndpoint(endpointId);
        } catch {
          // TODO: Narrow this catch to the expected error type (e.g.,
          // VatNotFoundError) so that unexpected errors are not silently
          // swallowed and deliverable messages are not incorrectly discarded.
          // Endpoint vanished (e.g., vat terminated but ownership entries not
          // yet cleaned up). Treat the same as a splat.
          if (message.result) {
            const promise = this.#kernelStore.getKernelPromise(message.result);
            this.#kernelQueue.resolvePromises(promise.decider, [
              [
                message.result,
                true,
                makeKernelError(
                  'ENDPOINT_UNREACHABLE',
                  'Target endpoint is unreachable (terminated or disconnected)',
                ),
              ],
            ]);
            this.#kernelStore.decrementRefCount(
              message.result,
              'deliver|splat|result',
            );
          }
          this.#kernelStore.decrementRefCount(
            item.target,
            'deliver|splat|target',
          );
          for (const slot of message.methargs.slots) {
            this.#kernelStore.decrementRefCount(slot, 'deliver|splat|slot');
          }
          this.#logger?.log(
            `@@@@ message went splat (endpoint gone) ${target}<-${JSON.stringify(message)}`,
          );
          return crankResult;
        }
      }
      if (endpoint || isKernelServiceMessage) {
        if (message.result) {
          this.#kernelStore.setPromiseDecider(message.result, endpointId);
          this.#kernelStore.decrementRefCount(
            message.result,
            'deliver|send|result',
          );
        }
      }
      if (endpoint) {
        // endpoint is only set when !isKernelServiceMessage, so endpointId
        // is narrowed to EndpointId here (TS can't infer this).
        const eid = endpointId as EndpointId;
        const endpointTarget = this.#kernelStore.translateRefKtoE(
          eid,
          target,
          false,
        );
        const endpointMessage = this.#kernelStore.translateMessageKtoE(
          eid,
          message,
        );
        try {
          crankResult = await endpoint.deliverMessage(
            endpointTarget,
            endpointMessage,
          );
        } catch (error) {
          // Delivery failed (e.g., remote queue full). Reject the kernel promise
          // so the caller knows the message wasn't delivered.
          this.#logger?.error(`Delivery to ${endpointId} failed:`, error);
          if (message.result) {
            const detail =
              error instanceof Error ? error.message : String(error);
            this.#kernelQueue.resolvePromises(endpointId, [
              [
                message.result,
                true,
                makeKernelError('DELIVERY_FAILED', detail),
              ],
            ]);
          }
          // Continue processing other messages - don't let one failure crash the queue
        }
      } else if (isKernelServiceMessage) {
        crankResult = this.#deliverKernelServiceMessage(target, message);
      } else {
        Fail`no owner for kernel object ${target}`;
      }
      // `item.target`, not the routed `target`: a message aimed at a promise
      // is charged against the promise, and routing may have resolved it to a
      // different object.
      this.#kernelStore.decrementRefCount(item.target, 'deliver|send|target');
      for (const slot of message.methargs.slots) {
        this.#kernelStore.decrementRefCount(slot, 'deliver|send|slot');
      }
    } else {
      // The references move from this run queue item to the promise's queue
      // entry. New holder first, so nothing transiently looks unreferenced.
      this.#kernelStore.enqueuePromiseMessage(target, message);
      this.#kernelStore.decrementRefCount(item.target, 'requeue|target');
      if (message.result) {
        this.#kernelStore.decrementRefCount(message.result, 'requeue|result');
      }
      for (const slot of message.methargs.slots) {
        this.#kernelStore.decrementRefCount(slot, 'requeue|slot');
      }
    }

    return crankResult;
  }

  /**
   * Delivers a message to a kernel service object.
   *
   * @param target - The kernel reference of the target service object.
   * @param message - The message to deliver to the service.
   * @returns The crank result indicating the delivery was to the kernel.
   */
  #deliverKernelServiceMessage(
    target: KRef,
    message: KernelMessage,
  ): CrankResult {
    this.#invokeKernelService(target, message);
    return { didDelivery: 'kernel' };
  }

  /**
   * Deliver a 'notify' run queue item.
   *
   * @param item - The notify item to deliver.
   * @returns The crank outcome.
   */
  async #deliverNotify(item: RunQueueItemNotify): Promise<CrankResult> {
    const { endpointId, kpid } = item;
    const { context, isPromise } = parseRef(kpid);
    assert(
      context === 'kernel' && isPromise,
      `${kpid} is not a kernel promise`,
    );
    this.#logger?.log(
      `@@@@ deliver ${endpointId} notify ${endpointId} ${kpid}`,
    );
    const promise = this.#kernelStore.getKernelPromise(kpid);
    const { state, value } = promise;
    assert(value, `no value for promise ${kpid}`);
    if (state === 'unresolved') {
      Fail`notification on unresolved promise ${kpid}`;
    }
    // Release the queued notification's reference up front, so the paths that
    // decide there is nothing to deliver don't leak it.
    this.#kernelStore.decrementRefCount(kpid, 'deliver|notify');
    if (!this.#kernelStore.krefToEref(endpointId, kpid)) {
      // no c-list entry, already done
      return { didDelivery: endpointId };
    }
    const targets = this.#kernelStore.getKpidsToRetire(kpid, value);
    if (targets.length === 0) {
      // no kpids to retire, already done
      return { didDelivery: endpointId };
    }
    const resolutions: VatOneResolution[] = [];
    for (const toResolve of targets) {
      const tPromise = this.#kernelStore.getKernelPromise(toResolve);
      if (tPromise.state === 'unresolved') {
        Fail`target promise ${toResolve} is unresolved`;
      }
      if (!tPromise.value) {
        throw Fail`target promise ${toResolve} has no value`;
      }
      resolutions.push([
        this.#kernelStore.translateRefKtoE(endpointId, toResolve, true),
        tPromise.state === 'rejected',
        this.#kernelStore.translateCapDataKtoE(endpointId, tPromise.value),
      ]);
    }
    // TODO: SwingSet also tears down the c-list entry for each promise in the
    // batch here, since the endpoint can never refer to a settled promise by
    // that eref again. Left alone for now because the debug UI discovers
    // exported ocap URLs by scanning these entries. The cost of keeping them is
    // that a settled promise reached this way holds a count forever, so it is
    // never collected and its resolution slots are never released.
    const endpoint = this.#getEndpoint(endpointId);
    return await endpoint.deliverNotify(resolutions);
  }

  /**
   * Deliver a Garbage Collection action run queue item.
   *
   * @param item - The dropExports | retireExports | retireImports item to deliver.
   * @returns The crank outcome.
   */
  async #deliverGCAction(item: RunQueueItemGCAction): Promise<CrankResult> {
    const { type, endpointId, krefs } = item;
    this.#logger?.log(
      `@@@@ deliver ${endpointId} ${type} ${JSON.stringify(krefs)}`,
    );
    // This action was selected while the endpoint's c-list held every one of
    // these krefs, but `nextTerminatedVatCleanup` runs between selection and
    // here and can take the entries — and the endpoint — with it. Whatever
    // survives still has to be released on the kernel's side: the action has
    // already been consumed from the durable set, so skipping the teardown
    // would lose it and leave the entry behind for good.
    const live = krefs.filter((kref) =>
      this.#kernelStore.hasCListEntry(endpointId, kref),
    );
    if (live.length < krefs.length) {
      this.#logger?.error(
        `${type} for ${endpointId}: ${krefs.length - live.length} of ${krefs.length} kref(s) were cleaned up before delivery`,
      );
    }
    if (live.length === 0) {
      return { didDelivery: endpointId };
    }
    const erefs = this.#kernelStore.krefsToErefs(endpointId, live);
    // Telling an endpoint to let go is also the kernel letting go. Otherwise a
    // dropped export stays flagged reachable, so the same action gets derived
    // again, and retired entries outlive the objects they name.
    live.forEach((kref, index) => {
      if (type === 'dropExports') {
        this.#kernelStore.clearReachableFlag(endpointId, kref);
        return;
      }
      // `erefs` is parallel to `live`: krefsToErefs throws rather than
      // returning a short array, so every index is populated.
      this.#kernelStore.deleteCListEntry(
        endpointId,
        kref,
        erefs[index] as ERef,
      );
      if (type === 'retireExports') {
        // Retiring an export is the owner giving up the last name for the
        // object, so the kernel's record of who owns it goes too.
        this.#kernelStore.orphanKernelObject(kref, endpointId);
      }
    });
    let endpoint: EndpointHandle;
    try {
      endpoint = this.#getEndpoint(endpointId);
    } catch (error) {
      this.#logger?.error(
        `Endpoint ${endpointId} vanished before ${type} of ${JSON.stringify(live)}; released the kernel's side anyway:`,
        error,
      );
      return { didDelivery: endpointId };
    }
    const method =
      `deliver${(type[0] as string).toUpperCase()}${type.slice(1)}` as
        | 'deliverDropExports'
        | 'deliverRetireExports'
        | 'deliverRetireImports';
    try {
      return await endpoint[method](erefs);
    } catch (error) {
      if (!isVatId(endpointId)) {
        // A remote is a separate kernel across a link that can drop messages,
        // so its protocol already has to tolerate one going missing — it
        // reconciles on the next incarnation change. Retrying instead would
        // starve the kernel: GC actions are selected ahead of all other work,
        // so a remote that keeps refusing (a full send queue, say) would be
        // handed the same item every crank and nothing else would ever run.
        this.#logger?.error(
          `Delivery of ${type} to remote ${endpointId} failed; the kernel has released ${JSON.stringify(live)} regardless:`,
          error,
        );
        return { didDelivery: endpointId };
      }
      // A vat is local and reliable, so a refusal means it is broken. Undo the
      // teardown rather than commit it: leaving the two disagreeing would have
      // the vat mint fresh krefs for objects the kernel thinks it let go of.
      // Aborting restores the entries and the action; terminating the vat is
      // what stops that restored action from being retried forever.
      this.#logger?.error(
        `Delivery of ${type} to ${endpointId} failed; rolling back the kernel's release of ${JSON.stringify(live)} and terminating it:`,
        error,
      );
      return {
        abort: true,
        terminate: {
          vatId: endpointId,
          reject: true,
          info: makeFatalKernelError(
            'INTERNAL_ERROR',
            `failed to accept ${type}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        },
      };
    }
  }

  /**
   * Deliver a 'bringOutYourDead' run queue item.
   *
   * @param item - The bringOutYourDead item to deliver.
   * @returns The crank outcome.
   */
  async #deliverBringOutYourDead(
    item: RunQueueItemBringOutYourDead,
  ): Promise<CrankResult | undefined> {
    const { endpointId } = item;
    this.#logger?.log(`@@@@ deliver ${endpointId} bringOutYourDead`);
    const endpoint = this.#getEndpoint(endpointId);
    const crankResult = await endpoint.deliverBringOutYourDead();
    return crankResult;
  }
}
