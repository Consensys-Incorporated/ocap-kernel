import type { Logger } from '@metamask/logger';

import { makeIOListenerService } from './io-service.ts';
import type { IOListener, IOListenerFactory } from './types.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import type { KernelService } from '../KernelServiceManager.ts';
import type { IOConfig, KRef } from '../types.ts';

type RegisterService = (
  name: string,
  service: object,
  options?: { systemOnly?: boolean },
) => KernelService;
type UnregisterService = (name: string) => void;
type RegisterAnonymous = (service: object, label: string) => KRef;
type ReleaseAnonymous = (kref: KRef) => void;

type IOManagerOptions = {
  factory: IOListenerFactory;
  kernelQueue: KernelQueue;
  registerService: RegisterService;
  unregisterService: UnregisterService;
  registerAnonymous: RegisterAnonymous;
  releaseAnonymous: ReleaseAnonymous;
  logger?: Logger;
};

type SubclusterIOState = {
  listeners: Map<string, IOListener>;
  serviceNames: string[];
  /** Krefs of connections accepted from this subcluster's listeners. */
  connectionKrefs: Set<KRef>;
};

/**
 * Manages IO listener lifecycle, creating listeners at subcluster launch
 * and destroying them — along with any connections accepted from them — at
 * termination.
 */
export class IOManager {
  readonly #factory: IOListenerFactory;

  readonly #kernelQueue: KernelQueue;

  readonly #registerService: RegisterService;

  readonly #unregisterService: UnregisterService;

  readonly #registerAnonymous: RegisterAnonymous;

  readonly #releaseAnonymous: ReleaseAnonymous;

  readonly #logger: Logger | undefined;

  /** IO state indexed by subcluster ID */
  readonly #subclusters: Map<string, SubclusterIOState> = new Map();

  /**
   * Creates a new IOManager instance.
   *
   * @param options - Constructor options.
   * @param options.factory - Factory for creating IO listeners.
   * @param options.kernelQueue - The kernel's queue.
   * @param options.registerService - Function to register a kernel service.
   * @param options.unregisterService - Function to unregister a kernel service.
   * @param options.registerAnonymous - Function to host an accepted
   * connection as a kernel object reachable only by reference.
   * @param options.releaseAnonymous - Function to release a hosted connection.
   * @param options.logger - Optional logger for diagnostics.
   */
  constructor({
    factory,
    kernelQueue,
    registerService,
    unregisterService,
    registerAnonymous,
    releaseAnonymous,
    logger,
  }: IOManagerOptions) {
    this.#factory = factory;
    this.#kernelQueue = kernelQueue;
    this.#registerService = registerService;
    this.#unregisterService = unregisterService;
    this.#registerAnonymous = registerAnonymous;
    this.#releaseAnonymous = releaseAnonymous;
    this.#logger = logger;
    harden(this);
  }

  /**
   * Create IO listeners for a subcluster and register them as kernel services.
   * This and {@link destroyChannels} run inside a launch's or a termination's
   * crank and write the store directly. A listener service acts from outside
   * the run loop, so each of its writes takes an inbox crank.
   *
   * @param subclusterId - The ID of the subcluster.
   * @param ioConfig - The IO configuration map from listener names to configs.
   */
  async createChannels(
    subclusterId: string,
    ioConfig: Record<string, IOConfig>,
  ): Promise<void> {
    const listeners = new Map<string, IOListener>();
    const serviceNames: string[] = [];
    const connectionKrefs = new Set<KRef>();

    for (const [name, config] of Object.entries(ioConfig)) {
      const serviceName = `io:${subclusterId}:${name}`;
      try {
        const listener = await this.#factory(name, config);
        listeners.set(name, listener);

        const service = makeIOListenerService(serviceName, listener, config, {
          register: async (connection, label) =>
            this.#kernelQueue.enqueueInbox('host an IO connection', () => {
              const state = this.#subclusters.get(subclusterId);
              if (state?.connectionKrefs !== connectionKrefs) {
                // Destroyed while this waited for its crank, so nothing
                // would release the connection.
                return {
                  failure: new Error(
                    `IO listener "${serviceName}" is gone; connection "${label}" was not hosted`,
                  ),
                };
              }
              const kref = this.#registerAnonymous(connection, label);
              connectionKrefs.add(kref);
              return { value: kref };
            }),
          release: async (kref) =>
            this.#kernelQueue.enqueueInbox('release an IO connection', () => {
              connectionKrefs.delete(kref);
              this.#releaseAnonymous(kref);
              return { value: undefined };
            }),
        });
        this.#registerService(serviceName, service);
        serviceNames.push(serviceName);

        this.#logger?.info(
          `Created IO listener "${name}" for subcluster ${subclusterId}`,
        );
      } catch (error) {
        // Clean up anything we already created before re-throwing
        await this.#closeListeners(listeners);
        for (const registeredName of serviceNames) {
          try {
            this.#unregisterService(registeredName);
          } catch (unregisterError) {
            this.#logger?.error(
              `Error unregistering IO service "${registeredName}":`,
              unregisterError,
            );
          }
        }
        throw error;
      }
    }

    this.#subclusters.set(subclusterId, {
      listeners,
      serviceNames,
      connectionKrefs,
    });
  }

  /**
   * Destroy IO listeners for a subcluster, unregister their services, and
   * release any connections still accepted from them.
   *
   * @param subclusterId - The ID of the subcluster.
   */
  async destroyChannels(subclusterId: string): Promise<void> {
    const state = this.#subclusters.get(subclusterId);
    if (!state) {
      return;
    }

    for (const name of state.serviceNames) {
      try {
        this.#unregisterService(name);
      } catch (error) {
        this.#logger?.error(`Error unregistering IO service "${name}":`, error);
      }
    }

    // Closing a listener closes its connections at the transport level;
    // stop hosting them so their krefs don't outlive the subcluster.
    await this.#closeListeners(state.listeners);
    for (const kref of state.connectionKrefs) {
      this.#releaseAnonymous(kref);
    }
    state.connectionKrefs.clear();
    this.#subclusters.delete(subclusterId);

    this.#logger?.info(`Destroyed IO listeners for subcluster ${subclusterId}`);
  }

  /**
   * Destroy all IO listeners across all subclusters.
   * Used during kernel reset to ensure nothing is leaked.
   */
  async destroyAllChannels(): Promise<void> {
    for (const subclusterId of [...this.#subclusters.keys()]) {
      await this.destroyChannels(subclusterId);
    }
  }

  /**
   * Close all listeners in a map, logging errors.
   *
   * @param listeners - The listeners to close.
   */
  async #closeListeners(listeners: Map<string, IOListener>): Promise<void> {
    for (const [name, listener] of listeners) {
      try {
        await listener.close();
      } catch (error) {
        this.#logger?.error(`Error closing IO listener "${name}":`, error);
      }
    }
  }
}
harden(IOManager);
