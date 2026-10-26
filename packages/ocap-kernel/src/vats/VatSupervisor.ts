import { makeLiveSlots as localMakeLiveSlots } from '@agoric/swingset-liveslots';
import type {
  VatDeliveryObject,
  VatSyscallObject,
  VatSyscallResult,
} from '@agoric/swingset-liveslots';
import { makeMarshal } from '@endo/marshal';
import type { CapData } from '@endo/marshal';
import {
  DuplicateEndowmentError,
  StreamReadError,
} from '@metamask/kernel-errors';
import type { PlatformFactory } from '@metamask/kernel-platforms';
import { RpcClient, RpcService } from '@metamask/kernel-rpc-methods';
import type { VatKVStore } from '@metamask/kernel-store';
import {
  mergeDisjointRecords,
  waitUntilQuiescent,
} from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import { serializeError } from '@metamask/rpc-errors';
import type { DuplexStream } from '@metamask/streams';
import { assert } from '@metamask/superstruct';
import {
  hasProperty,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from '@metamask/utils';

import { loadBundle } from './bundle-loader.ts';
import { createDefaultEndowments, VatEndowmentsStruct } from './endowments.ts';
import type { AllowedGlobalName, MakeAllowedGlobals } from './endowments.ts';
import { makeCaveatedFetch, makeHostCaveat } from './network-caveat.ts';
import type { FetchCapability } from './network-caveat.ts';
import { makeGCAndFinalize } from '../garbage-collection/gc-finalize.ts';
import { makeDummyMeterControl } from '../liveslots/meter-control.ts';
import { makeSupervisorSyscall } from '../liveslots/syscall.ts';
import type {
  DispatchFn,
  MakeLiveSlotsFn,
  GCTools,
} from '../liveslots/types.ts';
import { vatSyscallMethodSpecs, vatHandlers } from '../rpc/index.ts';
import { makeVatKVStore } from '../store/vat-kv-store.ts';
import type { VatConfig, VatDeliveryResult, VatId } from '../types.ts';
import { isVatConfig, coerceVatSyscallObject } from '../types.ts';

const makeLiveSlots: MakeLiveSlotsFn = localMakeLiveSlots;

export type FetchBlob = (bundleURL: string) => Promise<Response>;

type SupervisorRpcClient = Pick<
  RpcClient<typeof vatSyscallMethodSpecs>,
  'notify' | 'handleResponse'
>;

type SupervisorConstructorProps = {
  id: VatId;
  kernelStream: DuplexStream<JsonRpcMessage, JsonRpcMessage>;
  logger: Logger;
  makePlatform?: PlatformFactory;
  platformOptions?: Record<string, unknown>;
  vatPowers?: Record<string, unknown> | undefined;
  fetchBlob?: FetchBlob;
  makeAllowedGlobals?: MakeAllowedGlobals;
};

const marshal = makeMarshal(undefined, undefined, {
  serializeBodyFormat: 'smallcaps',
});

/**
 * Supervises a vat's execution, managing its lifecycle and communication with the kernel.
 */
export class VatSupervisor {
  /** The id of the vat being supervised */
  readonly id: VatId;

  /** Communications channel between this vat and the kernel */
  readonly #kernelStream: DuplexStream<JsonRpcMessage, JsonRpcMessage>;

  /** The logger for this vat */
  readonly #logger: Logger;

  /** RPC client for sending syscall requests to the kernel */
  readonly #rpcClient: SupervisorRpcClient;

  /** RPC service for handling requests from the kernel */
  readonly #rpcServer: RpcService<typeof vatHandlers>;

  /** Flag that the user code has been loaded */
  #loaded: boolean = false;

  /** Function to dispatch deliveries into liveslots */
  #dispatch: DispatchFn | null;

  /** In-memory KVStore cache for this vat. */
  #vatKVStore: VatKVStore | undefined;

  /** External capabilities for this vat. */
  readonly #vatPowers: Record<string, unknown>;

  /** Capability to fetch the bundle of code to run in this vat. */
  readonly #fetchBlob: FetchBlob;

  /** Function to create endowments for this vat. */
  readonly #makePlatform: PlatformFactory;

  /** Options to pass to the makePlatform function. */
  readonly #platformOptions: Record<string, unknown>;

  /** The set of globals that vats are allowed to request. */
  readonly #allowedGlobals: Record<string, unknown>;

  /**
   * Releases resources held by the endowment factories (e.g. pending timers,
   * open network connections). Invoked from {@link terminate} before closing
   * the kernel stream; failures are logged but do not prevent stream closure.
   */
  readonly #endowmentsTeardown: () => Promise<void>;

  /**
   * Promise of the in-flight termination, or `null` if not yet started.
   * Concurrent callers share this promise so they all await the same
   * teardown + stream-close completion rather than getting a premature
   * resolution from an early-return guard.
   */
  #terminationPromise: Promise<void> | null = null;

  /**
   * Construct a new VatSupervisor instance.
   *
   * @param params - Named constructor parameters.
   * @param params.id - The id of the vat being supervised.
   * @param params.kernelStream - Communications channel connected to the kernel.
   * @param params.logger - The logger for this vat.
   * @param params.vatPowers - The external capabilities for this vat.
   * @param params.fetchBlob - Function to fetch the user code bundle for this vat.
   * @param params.makePlatform - Function to create the platform for this vat.
   * @param params.platformOptions - Options to pass to the makePlatform function.
   * @param params.makeAllowedGlobals - Factory invoked exactly once at
   * construction to produce this vat's isolated endowments and an aggregate
   * teardown function. Defaults to {@link createDefaultEndowments}.
   */
  constructor({
    id,
    kernelStream,
    logger,
    vatPowers,
    makePlatform = () => {
      throw new Error('No platform capabilities provided');
    },
    platformOptions,
    fetchBlob,
    makeAllowedGlobals = createDefaultEndowments,
  }: SupervisorConstructorProps) {
    this.id = id;
    this.#kernelStream = kernelStream;
    this.#logger = logger;
    this.#vatPowers = vatPowers ?? {};
    this.#dispatch = null;
    const defaultFetchBlob: FetchBlob = async (bundleURL: string) =>
      await fetch(bundleURL, { cache: 'no-store' } as RequestInit);
    this.#fetchBlob = fetchBlob ?? defaultFetchBlob;
    this.#platformOptions = platformOptions ?? {};
    this.#makePlatform = makePlatform;
    const endowments = makeAllowedGlobals({
      logger: this.#logger.subLogger({ tags: ['endowments'] }),
    });
    // Defense in depth: custom `MakeAllowedGlobals` factories may return the
    // wrong shape (e.g., no `teardown` callable) — assert before use so the
    // failure surfaces at construction rather than during termination.
    assert(
      endowments,
      VatEndowmentsStruct,
      `makeAllowedGlobals returned an invalid VatEndowments value for vat "${id}"`,
    );
    // Defense in depth: custom `MakeAllowedGlobals` factories may skip hardening.
    this.#allowedGlobals = harden(endowments.globals);
    this.#endowmentsTeardown = endowments.teardown;

    this.#rpcClient = new RpcClient(
      vatSyscallMethodSpecs,
      async (request) => {
        await this.#kernelStream.write(request);
      },
      `${this.id}:`,
      this.#logger.subLogger({ tags: ['rpc-client'] }),
    );

    this.#rpcServer = new RpcService(vatHandlers, {
      initVat: this.#initVat.bind(this),
      handleDelivery: this.#deliver.bind(this),
    });

    Promise.all([
      this.#kernelStream.drain(this.#handleMessage.bind(this)),
    ]).catch(async (error) => {
      this.#logger.error(
        `Unexpected read error from VatSupervisor "${this.id}"`,
        error,
      );
      await this.terminate(new StreamReadError({ vatId: this.id }, error));
    });
  }

  /**
   * Terminate the VatSupervisor.
   *
   * Endowment teardown runs first so pending timers and other resources are
   * released before the kernel stream closes. Teardown failures are logged
   * but never block stream closure — the original `error` (if any) must
   * always reach the kernel. Subsequent calls share the first call's
   * termination promise, so every caller observes the same completion.
   *
   * @param error - The error to terminate the VatSupervisor with.
   * @returns A promise that resolves once the vat is fully shut down.
   */
  async terminate(error?: Error): Promise<void> {
    if (this.#terminationPromise) {
      return this.#terminationPromise;
    }
    this.#terminationPromise = this.#doTerminate(error);
    return this.#terminationPromise;
  }

  /**
   * Performs the actual termination work; referenced by {@link terminate}
   * via the shared promise guard.
   *
   * @param error - The error to terminate the VatSupervisor with.
   */
  async #doTerminate(error?: Error): Promise<void> {
    try {
      await this.#endowmentsTeardown();
    } catch (teardownError) {
      const message = `Endowment teardown failed during terminate of vat "${this.id}"`;
      if (teardownError instanceof AggregateError) {
        for (const subError of teardownError.errors) {
          this.#logger.error(message, subError);
        }
      } else {
        this.#logger.error(message, teardownError);
      }
    }
    await this.#kernelStream.end(error);
  }

  /**
   * Handle a message from the kernel.
   *
   * @param message - The vat message to handle.
   */
  async #handleMessage(message: JsonRpcMessage): Promise<void> {
    if (isJsonRpcResponse(message)) {
      this.#rpcClient.handleResponse(message.id as string, message);
    } else if (isJsonRpcRequest(message)) {
      try {
        this.#rpcServer.assertHasMethod(message.method);
        const result = await this.#rpcServer.execute(
          message.method,
          message.params,
        );
        await this.#kernelStream.write({
          id: message.id,
          result,
          jsonrpc: '2.0',
        });
      } catch (error) {
        await this.#kernelStream.write({
          id: message.id,
          error: serializeError(error),
          jsonrpc: '2.0',
        });
      }
    }
  }

  /**
   * Execute a syscall by sending it to the kernel. To support the synchronous
   * requirements of the liveslots interface, it optimistically assumes success;
   * errors will be dealt with at the end of the crank.
   *
   * @param vso - Descriptor of the syscall to be issued.
   *
   * @returns a syscall success result.
   */
  executeSyscall(vso: VatSyscallObject): VatSyscallResult {
    // IMPORTANT: Syscall architecture design explanation:
    // - Vats operate on an "optimistic execution" model - they send syscalls and continue execution
    //    without waiting for responses, assuming success.
    // - The Kernel processes syscalls synchronously on receipt and failures are caught in VatHandle.
    // - The vat is terminated and the crank is rolled back if a syscall fails.
    this.#rpcClient
      .notify('syscall', coerceVatSyscallObject(vso))
      // Just to please the linter (notifications never reject)
      .catch(() => undefined);
    return ['ok', null];
  }

  /**
   * Delivers a message to the vat and captures the result.
   *
   * @param params - The delivery object containing the message to deliver.
   * @returns A tuple indicating success or failure along with any error information.
   */
  async #deliver(params: VatDeliveryObject): Promise<VatDeliveryResult> {
    if (!this.#dispatch) {
      throw new Error(`cannot deliver before vat is loaded`);
    }

    let deliveryError: string | null = null;

    try {
      await this.#dispatch(harden(params));
    } catch (error) {
      // Handle delivery errors
      deliveryError = error instanceof Error ? error.message : String(error);
      this.#logger.error(`Delivery error in vat ${this.id}:`, deliveryError);
    }

    // oxlint-disable-next-line typescript/no-non-null-assertion
    return [this.#vatKVStore!.checkpoint(), deliveryError];
  }

  /**
   * Initialize the vat by loading its user code bundle and creating a liveslots
   * instance to manage it.
   *
   * @param vatConfig - Configuration object describing the vat to be intialized.
   * @param state - A Map representing the current persistent state of the vat.
   * @param allowedGlobalNames - Optional list of allowed global names to restrict the available endowments.
   * @returns a promise for a checkpoint of the new vat.
   */
  async #initVat(
    vatConfig: VatConfig,
    state: Map<string, string>,
    allowedGlobalNames: AllowedGlobalName[] | undefined,
  ): Promise<VatDeliveryResult> {
    if (this.#loaded) {
      throw Error(
        'VatSupervisor received initVat after user code already loaded',
      );
    }
    if (!isVatConfig(vatConfig)) {
      throw Error('VatSupervisor received initVat with bad config parameter');
    }
    // XXX TODO: this check can and should go away once we can handle `bundleName` and `sourceSpec` too
    if (!('bundleSpec' in vatConfig)) {
      throw Error(
        'for now, only bundleSpec is supported in vatConfig specifications',
      );
    }
    this.#loaded = true;

    this.#vatKVStore = makeVatKVStore(state);
    const syscall = makeSupervisorSyscall(
      this,
      this.#vatKVStore,
      this.#logger.subLogger({ tags: ['syscall'] }),
    );
    const liveSlotsOptions = {}; // XXX should be something more real

    const gcTools: GCTools = harden({
      WeakRef,
      FinalizationRegistry,
      waitUntilQuiescent,
      gcAndFinalize: makeGCAndFinalize(
        this.#logger.subLogger({ tags: ['gc'] }),
      ),
      meterControl: makeDummyMeterControl(),
    });

    const { bundleSpec, parameters, platformConfig, globals, network } =
      vatConfig;

    // If the kernel specified a restricted set of allowed global names,
    // filter the full allowlist down to only those names.
    const effectiveAllowedGlobals = allowedGlobalNames
      ? Object.fromEntries(
          allowedGlobalNames
            .filter((name) => hasProperty(this.#allowedGlobals, name))
            .map((name) => [name, this.#allowedGlobals[name]]),
        )
      : this.#allowedGlobals;

    // Build additional endowments from globals list
    const requestedGlobals: Record<string, unknown> = {};
    if (globals) {
      for (const name of globals) {
        if (hasProperty(effectiveAllowedGlobals, name)) {
          requestedGlobals[name] = effectiveAllowedGlobals[name];
        } else {
          throw new Error(
            `Vat "${this.id}" requested unknown global "${name}"`,
          );
        }
      }
    }

    // Post-wrap the Snaps-produced `fetch` with a per-vat host allowlist.
    // The factory itself takes no allowlist, so restriction is applied here
    // where `VatConfig.network.allowedHosts` is in scope. Requesting `fetch`
    // without an allowlist is rejected — there is no implicit-allow-all
    // pathway.
    if (hasProperty(requestedGlobals, 'fetch')) {
      const allowedHosts = network?.allowedHosts;
      if (!allowedHosts) {
        throw new Error(
          `Vat "${this.id}" requested "fetch" but no network.allowedHosts was specified`,
        );
      }
      requestedGlobals.fetch = makeCaveatedFetch(
        requestedGlobals.fetch as FetchCapability,
        makeHostCaveat([...allowedHosts]),
      );
    }

    const workerEndowments = {
      console: this.#logger.subLogger({ tags: ['console'] }),
      assert: globalThis.assert,
      ...requestedGlobals,
    };

    const platformEndowments = platformConfig
      ? await this.#makePlatform(platformConfig, this.#platformOptions)
      : {};

    const fetched = await this.#fetchBlob(bundleSpec);
    if (!fetched.ok) {
      throw Error(`fetch of user code ${bundleSpec} failed: ${fetched.status}`);
    }
    const bundleContent = await fetched.text();
    const buildVatNamespace = async (
      lsEndowments: Record<PropertyKey, unknown>,
      inescapableGlobalProperties: object,
    ): Promise<Record<string, unknown>> => {
      let endowments: object;
      try {
        // Ensure there are no endowment name collisions.
        endowments = mergeDisjointRecords(
          workerEndowments,
          platformEndowments,
          lsEndowments,
        );
      } catch (error) {
        // If the error is caused by a duplicate endowment name, throw a more specific error.
        if (error instanceof Error && error.cause) {
          const { collidingIndex, key } = error.cause as {
            collidingIndex: number;
            key: PropertyKey;
          };
          throw new DuplicateEndowmentError(String(key), collidingIndex === 1);
        }
        // Otherwise, just rethrow the error.
        throw error;
      }
      const vatNS = loadBundle(bundleContent, {
        endowments,
        inescapableGlobalProperties,
      });
      return vatNS;
    };

    const liveslots = makeLiveSlots(
      syscall,
      this.id,
      this.#vatPowers,
      liveSlotsOptions,
      gcTools,
      this.#logger.subLogger({ tags: ['liveslots'] }),
      buildVatNamespace,
    );

    this.#dispatch = liveslots.dispatch;
    const serParam = marshal.toCapData(harden(parameters)) as CapData<string>;

    return await this.#deliver(harden(['startVat', serParam]));
  }
}
