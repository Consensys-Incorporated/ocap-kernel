import { E } from '@endo/eventual-send';
import type { ExpectedKernelErrorCode } from '@metamask/kernel-errors';
import type { Logger } from '@metamask/logger';

import type { KernelQueue } from './KernelQueue.ts';
import { kser, kunser, makeKernelError } from './liveslots/kernel-marshal.ts';
import type { KernelStore } from './store/index.ts';
import type { KRef, KernelMessage } from './types.ts';
import { assert } from './utils/assert.ts';

export type KernelService = {
  /**
   * The service's name. For services registered with
   * `registerKernelServiceObject` this is the key vats name in their
   * cluster config's `services` list, and it is unique. For objects
   * registered with `registerAnonymousKernelObject` it is only a
   * diagnostic label: those objects are deliberately absent from the
   * name index and need not be unique.
   */
  name: string;
  kref: KRef;
  service: object;
  systemOnly: boolean;
};

type KernelServiceManagerConstructorProps = {
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
  logger?: Logger;
};

/**
 * Manages kernel services registration and invocation.
 */
export class KernelServiceManager {
  /** Storage holding the kernel's persistent state */
  readonly #kernelStore: KernelStore;

  /** The kernel's run queue */
  readonly #kernelQueue: KernelQueue;

  /** Logger for outputting messages to the console */
  readonly #logger: Logger | undefined;

  /** Objects providing custom or kernel-privileged services to vats, indexed by name */
  readonly #kernelServicesByName: Map<string, KernelService> = new Map();

  /** Objects providing custom or kernel-privileged services to vats, indexed by kref */
  readonly #kernelServicesByObject: Map<KRef, KernelService> = new Map();

  /**
   * Creates a new KernelServiceManager instance.
   *
   * @param options - Constructor options.
   * @param options.kernelStore - The kernel's persistent state store.
   * @param options.kernelQueue - The kernel's message queue for scheduling deliveries.
   * @param options.logger - Logger instance for debugging and diagnostics.
   */
  constructor({
    kernelStore,
    kernelQueue,
    logger,
  }: KernelServiceManagerConstructorProps) {
    this.#kernelStore = kernelStore;
    this.#kernelQueue = kernelQueue;
    this.#logger = logger;
  }

  /**
   * Register a kernel service object.
   *
   * @param name - The name of the service.
   * @param service - The service object.
   * @param options - Registration options.
   * @param options.systemOnly - Whether the service is only available to system
   * subclusters. Defaults to `false`.
   * @returns The registered kernel service with its kref.
   */
  registerKernelServiceObject(
    name: string,
    service: object,
    { systemOnly = false }: { systemOnly?: boolean } = {},
  ): KernelService {
    if (this.#kernelServicesByName.has(name)) {
      throw new Error(`Kernel service "${name}" is already registered`);
    }
    let kref = this.#kernelStore.getKernelServiceKref(name);
    if (!kref) {
      kref = this.#kernelStore.initKernelObject('kernel');
      this.#kernelStore.setKernelServiceKref(name, kref);
      this.#kernelStore.pinObject(kref);
    }
    const kernelService = { name, kref, service, systemOnly };
    this.#kernelServicesByName.set(name, kernelService);
    this.#kernelServicesByObject.set(kref, kernelService);
    return kernelService;
  }

  /**
   * Unregister a kernel service object by name.
   *
   * @param name - The name of the service to unregister.
   */
  unregisterKernelServiceObject(name: string): void {
    const service = this.#kernelServicesByName.get(name);
    if (!service) {
      return;
    }
    this.#kernelServicesByName.delete(name);
    this.#kernelServicesByObject.delete(service.kref);
    this.#kernelStore.unpinObject(service.kref);
    this.#kernelStore.deleteKernelServiceKref(name);
  }

  /**
   * Register a kernel-hosted object reachable *only* by reference.
   *
   * Unlike `registerKernelServiceObject`, this enters the object in the
   * by-kref routing table but deliberately not in the name index, so it
   * has no name in the global service namespace and cannot be requested
   * via a cluster config's `services` list. The only way to obtain one
   * is to be handed the reference, which is what makes it suitable for
   * per-session objects such as an accepted IO connection: authority is
   * conveyed by an unforgeable reference rather than by a string that
   * anything able to name it could use.
   *
   * The returned kref is meant to be passed to `kslot()` so a kernel
   * service method can return the object to a vat, which receives it as
   * an ordinary Presence.
   *
   * The object is pinned, so it stays alive until
   * `releaseAnonymousKernelObject` is called; the registrar owns that
   * lifetime.
   *
   * @param service - The object to host.
   * @param label - A diagnostic label. Need not be unique; it is never
   * used for lookup.
   * @returns The kref of the newly hosted object.
   */
  registerAnonymousKernelObject(service: object, label: string): KRef {
    const kref = this.#kernelStore.initKernelObject('kernel');
    this.#kernelStore.pinObject(kref);
    // Recorded persistently so `releaseAbandonedAnonymousKernelObjects` can
    // find it after a restart. The routing entry below is in-memory only,
    // and an anonymous object has no name to be re-registered under, so one
    // that outlives its incarnation is unreachable yet still pinned.
    this.#kernelStore.addAnonymousKernelObject(kref);
    this.#kernelServicesByObject.set(kref, {
      name: label,
      kref,
      service,
      systemOnly: false,
    });
    return kref;
  }

  /**
   * Discard anonymous kernel objects left behind by a previous incarnation.
   *
   * These exist to host things that cannot outlive the process — an accepted
   * socket connection, say — so any that survived a restart are garbage, and
   * harmful if left: still pinned, so they accumulate with every restart.
   *
   * Note what this does *not* guarantee. The kernel object is deleted only
   * once nothing references it, so a survivor that a vat import or a still
   * queued message holds keeps its `'kernel'` owner, and a delivery to it
   * still routes to `invokeKernelService`. That case is made survivable there,
   * by rejecting the caller's promise rather than throwing, and not here.
   *
   * Runs before the run queue starts, so the unpinning is complete before
   * anything can address one of these krefs.
   *
   * @returns The number of objects discarded.
   */
  releaseAbandonedAnonymousKernelObjects(): number {
    const abandoned = this.#kernelStore
      .getAnonymousKernelObjects()
      .filter((kref) => !this.#kernelServicesByObject.has(kref));
    for (const kref of abandoned) {
      this.#kernelStore.unpinObject(kref);
      const { reachable, recognizable } =
        this.#kernelStore.getObjectRefCount(kref);
      if (reachable === 0 && recognizable === 0) {
        this.#kernelStore.deleteKernelObject(kref);
      }
      this.#kernelStore.removeAnonymousKernelObject(kref);
    }
    return abandoned.length;
  }

  /**
   * Release an object registered with `registerAnonymousKernelObject`,
   * unpinning it and removing it from the routing table. Idempotent, and
   * safe to call for a kref that was never registered.
   *
   * The kernel object itself is deleted here once nothing references it,
   * rather than being left to `collectGarbage`, which skips kernel-owned
   * objects.
   *
   * @param kref - The kref of the object to release.
   */
  releaseAnonymousKernelObject(kref: KRef): void {
    if (!this.#kernelServicesByObject.delete(kref)) {
      return;
    }
    this.#kernelStore.unpinObject(kref);
    const { reachable, recognizable } =
      this.#kernelStore.getObjectRefCount(kref);
    if (reachable === 0 && recognizable === 0) {
      this.#kernelStore.deleteKernelObject(kref);
    }
    this.#kernelStore.removeAnonymousKernelObject(kref);
  }

  /**
   * Get a kernel service by name.
   *
   * @param name - The name of the service.
   * @returns The kernel service or undefined if not found.
   */
  getKernelService(name: string): KernelService | undefined {
    return this.#kernelServicesByName.get(name);
  }

  /**
   * Get a kernel service by its kref.
   *
   * @param kref - The kref of the service.
   * @returns The kernel service or undefined if not found.
   */
  getKernelServiceByKref(kref: KRef): KernelService | undefined {
    return this.#kernelServicesByObject.get(kref);
  }

  /**
   * Check if a kref refers to a kernel service.
   *
   * @param kref - The kref to check.
   * @returns True if the kref refers to a kernel service, false otherwise.
   */
  isKernelService(kref: KRef): boolean {
    return this.#kernelServicesByObject.has(kref);
  }

  /**
   * Invoke a kernel service.
   *
   * This method does NOT await the service method result. Instead, it uses
   * promise chaining to resolve the kernel promise when the method eventually
   * completes. This allows service methods to use `waitForCrank()` without
   * causing deadlock - the crank can complete, and the resolution happens
   * in a future turn of the event loop.
   *
   * @param target - The target kref of the service.
   * @param message - The message to invoke the service with.
   */
  invokeKernelService(target: KRef, message: KernelMessage): void {
    const kernelService = this.#kernelServicesByObject.get(target);
    if (!kernelService) {
      // Reachable, and not necessarily a kernel bug: an anonymous kernel
      // object hosts something that cannot outlive the process, such as an
      // accepted socket connection. A vat holding one across a restart, or a
      // message to one still sitting in the run queue from the previous
      // incarnation, arrives here with nothing registered.
      //
      // Rejecting rather than throwing is the point. A throw escapes the
      // crank and takes the run loop with it, so one unreachable reference
      // becomes a dead kernel — and the sweep in `Kernel.#init` cannot
      // prevent that on its own, since the object survives with its `kernel`
      // owner intact whenever a vat import or queued message still
      // references it. This mirrors what `KernelRouter` already does for a
      // delivery whose endpoint has vanished.
      this.#failMessage(
        message.result,
        'ENDPOINT_UNREACHABLE',
        `No registered service for ${target}`,
      );
      return;
    }
    const { methargs, result } = message;
    const [method, args] = kunser(methargs) as [string, unknown[]];
    assert.typeof(method, 'string');
    assert(Array.isArray(args));

    // Use E() so this works for both local objects and remote presences
    // (CapTP proxies whose methods aren't enumerable).
    // Call the method without awaiting. This allows the crank to complete
    // even if the method internally waits for the crank to end.
    try {
      const service = kernelService.service as Record<
        string,
        (...methodArgs: unknown[]) => unknown
      >;
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const resultPromise = E(service)[method]!(...args);
      Promise.resolve(resultPromise)
        .then((resultValue) => {
          if (result) {
            this.#kernelQueue.resolvePromises('kernel', [
              [result, false, kser(resultValue)],
            ]);
          }
          return undefined;
        })
        .catch((problem: unknown) => {
          this.#failMessage(result, 'DELIVERY_FAILED', problem);
        });
    } catch (syncError) {
      // Handle synchronous errors thrown before returning a Promise
      this.#failMessage(result, 'DELIVERY_FAILED', syncError);
    }
  }

  /**
   * Report a failed kernel service message by rejecting the caller's result
   * promise. A message sent with no result promise has nobody to report to,
   * so the problem is logged instead.
   *
   * @param result - The kref of the message's result promise, if it has one.
   * @param code - The kernel error code to report to the caller.
   * @param problem - The error or description of what went wrong.
   */
  #failMessage(
    result: KRef | null | undefined,
    code: ExpectedKernelErrorCode,
    problem: unknown,
  ): void {
    if (result) {
      const detail =
        problem instanceof Error ? problem.message : String(problem);
      this.#kernelQueue.resolvePromises('kernel', [
        [result, true, makeKernelError(code, detail)],
      ]);
    } else {
      this.#logger?.error('Error in kernel service method:', problem);
    }
  }
}
