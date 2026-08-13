import type {
  VatOneResolution,
  VatSyscallObject,
} from '@agoric/swingset-liveslots';
import { VatDeletedError, StreamReadError } from '@metamask/kernel-errors';
import { RpcClient, RpcService } from '@metamask/kernel-rpc-methods';
import type {
  ExtractParams,
  ExtractResult,
} from '@metamask/kernel-rpc-methods';
import type { VatStore } from '@metamask/kernel-store';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import { isJsonRpcNotification, isJsonRpcResponse } from '@metamask/utils';
import type { JsonRpcNotification, JsonRpcResponse } from '@metamask/utils';

import type { KernelQueue } from '../KernelQueue.ts';
import { makeFatalKernelError } from '../liveslots/kernel-marshal.ts';
import { vatMethodSpecs, vatSyscallHandlers } from '../rpc/index.ts';
import type { PingVatResult, VatMethod } from '../rpc/index.ts';
import type { KernelStore } from '../store/index.ts';
import type {
  EndpointMessage,
  VatId,
  VatConfig,
  ERef,
  CrankResult,
  VatDeliveryResult,
  EndpointHandle,
} from '../types.ts';
import type { AllowedGlobalName } from './endowments.ts';
import { VatSyscall } from './VatSyscall.ts';

type MessageFromVat = JsonRpcResponse | JsonRpcNotification;

type VatStream = DuplexStream<MessageFromVat, JsonRpcMessage>;

type VatConstructorProps = {
  vatId: VatId;
  vatConfig: VatConfig;
  vatStream: VatStream;
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
  /**
   * Called when this vat has failed in a way it cannot come back from, so the
   * manager can end it. See the drain handler in {@link VatHandle.make}.
   *
   * Handed the handle, because the failure can come before `make` has returned
   * it.
   */
  onCriticalFailure: (error: Error, vat: VatHandle) => void;
  logger?: Logger | undefined;
  allowedGlobalNames?: AllowedGlobalName[] | undefined;
};

/**
 * Handles communication with and lifecycle management of a vat.
 */
export class VatHandle implements EndpointHandle {
  /** The ID of the vat this is the VatHandle for */
  readonly vatId: VatId;

  /** Communications channel to and from the vat itself */
  readonly #vatStream: VatStream;

  /** The vat's configuration */
  readonly config: VatConfig;

  /** Logger for outputting messages (such as errors) to the console */
  readonly #logger: Logger | undefined;

  /** Optional list of allowed global names for vat endowments */
  readonly #allowedGlobalNames: AllowedGlobalName[] | undefined;

  /** Storage holding this vat's persistent state */
  readonly #vatStore: VatStore;

  /** The vat's syscall */
  readonly #vatSyscall: VatSyscall;

  /** Tells the manager this vat cannot be delivered to again */
  readonly #onCriticalFailure: (error: Error, vat: VatHandle) => void;

  readonly #rpcClient: RpcClient<typeof vatMethodSpecs>;

  readonly #rpcService: RpcService<typeof vatSyscallHandlers>;

  /**
   * Construct a new VatHandle instance.
   *
   * @param params - Named constructor parameters.
   * @param params.vatId - Our vat ID.
   * @param params.vatConfig - The configuration for this vat.
   * @param params.vatStream - Communications channel connected to the vat worker.
   * @param params.kernelStore - The kernel's persistent state store.
   * @param params.kernelQueue - The kernel's queue.
   * @param params.onCriticalFailure - Called when the vat has failed unrecoverably.
   * @param params.logger - Optional logger for error and diagnostic output.
   * @param params.allowedGlobalNames - Optional list of allowed global names for vat endowments.
   */
  // eslint-disable-next-line no-restricted-syntax
  private constructor({
    vatId,
    vatConfig,
    vatStream,
    kernelStore,
    kernelQueue,
    onCriticalFailure,
    logger,
    allowedGlobalNames,
  }: VatConstructorProps) {
    this.vatId = vatId;
    this.config = vatConfig;
    this.#logger = logger;
    this.#allowedGlobalNames = allowedGlobalNames;
    this.#vatStream = vatStream;
    this.#vatStore = kernelStore.makeVatStore(vatId);
    this.#onCriticalFailure = onCriticalFailure;
    this.#vatSyscall = new VatSyscall({
      vatId,
      kernelQueue,
      kernelStore,
      logger: this.#logger?.subLogger({ tags: ['syscall'] }),
    });

    this.#rpcClient = new RpcClient(
      vatMethodSpecs,
      async (request) => {
        await this.#vatStream.write(request);
      },
      `${this.vatId}:`,
    );
    this.#rpcService = new RpcService(vatSyscallHandlers, {
      handleSyscall: (params) => {
        this.#vatSyscall.handleSyscall(params as VatSyscallObject);
      },
    });
  }

  /**
   * Create a new VatHandle instance.
   *
   * @param params - Named constructor parameters.
   * @param params.vatId - Our vat ID.
   * @param params.vatConfig - The configuration for this vat.
   * @param params.vatStream - Communications channel connected to the vat worker.
   * @param params.kernelStore - The kernel's persistent state store.
   * @param params.kernelQueue - The kernel's queue.
   * @param params.onCriticalFailure - Called when the vat has failed unrecoverably.
   * @param params.logger - Optional logger for error and diagnostic output.
   * @returns A promise for the new VatHandle instance.
   */
  static async make(params: VatConstructorProps): Promise<VatHandle> {
    const vat = new VatHandle(params);
    const [, deliveryError] = await vat.#init();
    if (deliveryError) {
      throw new Error(
        `Failed to initialize vat ${vat.vatId}: ${deliveryError}`,
      );
    }
    return vat;
  }

  /**
   * Initializes the vat.
   *
   * @returns A promise for the vat's initial delivery result.
   */
  async #init(): Promise<VatDeliveryResult> {
    Promise.all([this.#vatStream.drain(this.#handleMessage.bind(this))]).catch(
      (error) => {
        this.#logger?.error(`Unexpected read error`, error);
        // Handed to the manager rather than torn down here. A handle that
        // retires itself leaves the manager still holding it and the store
        // still calling the vat live, so the next delivery is handed to a
        // worker that cannot answer and the crank never completes. Only the
        // manager can put the vat's death on record.
        this.#onCriticalFailure(
          new StreamReadError({ vatId: this.vatId }, error),
          this,
        );
      },
    );

    return await this.sendVatCommand({
      method: 'initVat',
      params: {
        vatConfig: this.config,
        state: this.#vatStore.getKVData(),
        ...(this.#allowedGlobalNames
          ? { allowedGlobalNames: this.#allowedGlobalNames }
          : {}),
      },
    });
  }

  /**
   * Ping the vat.
   *
   * @returns A promise that resolves to the result of the ping.
   */
  async ping(): Promise<PingVatResult> {
    return await this.sendVatCommand({
      method: 'ping',
      params: [],
    });
  }

  /**
   * Handle a message from the vat.
   *
   * @param message - The message to handle.
   * @param message.id - The id of the message.
   * @param message.payload - The payload (i.e., the message itself) to handle.
   */
  async #handleMessage(message: JsonRpcMessage): Promise<void> {
    if (isJsonRpcResponse(message)) {
      this.#rpcClient.handleResponse(message.id as string, message);
    } else if (isJsonRpcNotification(message)) {
      this.#rpcService.assertHasMethod(message.method);
      await this.#rpcService.execute(message.method, message.params);
    } else {
      // We don't expect any JSON-RPC requests from the vat, but the stream may permit them
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Received unexpected message: ${message}`);
    }
  }

  /**
   * Make a 'message' delivery to the vat.
   *
   * @param target - The VRef of the object to which the message is addressed.
   * @param message - The message to deliver.
   * @returns The crank result.
   */
  async deliverMessage(
    target: ERef,
    message: EndpointMessage,
  ): Promise<CrankResult> {
    await this.sendVatCommand({
      method: 'deliver',
      params: ['message', target, message],
    });
    return this.#getDeliveryCrankResult();
  }

  /**
   * Make a 'notify' delivery to the vat.
   *
   * @param resolutions - One or more promise resolutions to deliver.
   * @returns The crank result.
   */
  async deliverNotify(resolutions: VatOneResolution[]): Promise<CrankResult> {
    await this.sendVatCommand({
      method: 'deliver',
      params: ['notify', resolutions],
    });
    return this.#getDeliveryCrankResult();
  }

  /**
   * Make a 'dropExports' delivery to the vat.
   *
   * @param vrefs - The VRefs of the exports to be dropped.
   * @returns The crank result.
   */
  async deliverDropExports(vrefs: ERef[]): Promise<CrankResult> {
    await this.sendVatCommand({
      method: 'deliver',
      params: ['dropExports', vrefs],
    });
    return this.#getDeliveryCrankResult();
  }

  /**
   * Make a 'retireExports' delivery to the vat.
   *
   * @param vrefs - The VRefs of the exports to be retired.
   * @returns The crank result.
   */
  async deliverRetireExports(vrefs: ERef[]): Promise<CrankResult> {
    await this.sendVatCommand({
      method: 'deliver',
      params: ['retireExports', vrefs],
    });
    return this.#getDeliveryCrankResult();
  }

  /**
   * Make a 'retireImports' delivery to the vat.
   *
   * @param vrefs - The VRefs of the imports to be retired.
   * @returns The crank result.
   */
  async deliverRetireImports(vrefs: ERef[]): Promise<CrankResult> {
    await this.sendVatCommand({
      method: 'deliver',
      params: ['retireImports', vrefs],
    });
    return this.#getDeliveryCrankResult();
  }

  /**
   * Make a 'bringOutYourDead' delivery to the vat.
   *
   * @returns The crank result.
   */
  async deliverBringOutYourDead(): Promise<CrankResult> {
    await this.sendVatCommand({
      method: 'deliver',
      params: ['bringOutYourDead'],
    });
    return this.#getDeliveryCrankResult();
  }

  /**
   * Closes this handle's channel to the vat worker.
   *
   * Only the handle's own business: the store side of a vat's death belongs to
   * `VatManager.#retireVat`, which writes it in one synchronous step. Split that
   * way because the two have opposite failure requirements — ending a stream can
   * fail and it does not matter, since the worker is already being killed, while
   * a store left half-told about a vat is a state nothing recovers from.
   *
   * @param terminating - If true, the vat is being killed permanently, so
   *   callers waiting on a command it will never answer are told now.
   * @param error - The error to terminate the vat with.
   */
  async terminate(terminating: boolean, error?: Error): Promise<void> {
    if (terminating) {
      // Ahead of the stream, so a stream that refuses to close does not leave
      // these callers waiting on a worker that is already dead.
      this.#rpcClient.rejectAll(error ?? new VatDeletedError(this.vatId));
    }
    await this.#vatStream.end(error);
  }

  /**
   * Send a command into the vat.
   *
   * @param payload - The payload of the command.
   * @param payload.method - The method to call.
   * @param payload.params - The parameters to pass to the method.
   * @returns A promise that resolves the response to the command.
   */
  async sendVatCommand<Method extends VatMethod>({
    method,
    params,
  }: {
    method: Method;
    params: ExtractParams<Method, typeof vatMethodSpecs>;
  }): Promise<ExtractResult<Method, typeof vatMethodSpecs>> {
    const result = await this.#rpcClient.call(method, params);
    if (method === 'initVat' || method === 'deliver') {
      const [[sets, deletes], deliveryError] = result as VatDeliveryResult;
      this.#vatSyscall.deliveryError = deliveryError ?? undefined;
      const noErrors = !deliveryError && !this.#vatSyscall.illegalSyscall;
      // On errors, we neither update this vat's KV data nor rollback previous changes.
      // This is safe because vats are always terminated when errors occur
      // and they have their own databases, which are deleted when the vat is terminated.
      // The main kernel database will be rolled back.
      if (noErrors) {
        this.#vatStore.updateKVData(sets, deletes);
      }
    }
    return result;
  }

  /**
   * Get the crank outcome for a given checkpoint result.
   *
   * @returns The crank outcome.
   */
  async #getDeliveryCrankResult(): Promise<CrankResult> {
    const results: CrankResult = {
      didDelivery: this.vatId,
    };

    // These conditionals express a priority order: the consequences of an
    // illegal syscall take precedence over a vat requesting termination, etc.
    if (this.#vatSyscall.illegalSyscall) {
      results.abort = true;
      const { info } = this.#vatSyscall.illegalSyscall;
      // TODO: For now, vat errors both rewind changes and terminate the vat.
      // Some day, they might rewind changes and retry the syscall.
      // We should terminate the vat only after a certain # of failed retries.
      results.terminate = { vatId: this.vatId, reject: true, info };
    } else if (this.#vatSyscall.deliveryError) {
      results.abort = true;
      const info = makeFatalKernelError(
        'INTERNAL_ERROR',
        this.#vatSyscall.deliveryError,
      );
      results.terminate = { vatId: this.vatId, reject: true, info };
    } else if (this.#vatSyscall.vatRequestedTermination) {
      if (this.#vatSyscall.vatRequestedTermination.reject) {
        results.abort = true; // vatPowers.exitWithFailure wants rewind
      }
      results.terminate = {
        vatId: this.vatId,
        ...this.#vatSyscall.vatRequestedTermination,
      };
    }

    return harden(results);
  }
}
