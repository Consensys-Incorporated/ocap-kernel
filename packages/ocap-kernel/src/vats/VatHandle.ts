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
  logger?: Logger | undefined;
  allowedGlobalNames?: AllowedGlobalName[] | undefined;
  /** Called when the channel ends before `terminate` or `expectClose`. */
  onStreamFailure: (error: Error) => void;
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

  /** Told when the channel ends before `terminate` or `expectClose` */
  readonly #onStreamFailure: (error: Error) => void;

  /** Whether the kernel is closing the channel itself */
  #closing: boolean = false;

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
   * @param params.logger - Optional logger for error and diagnostic output.
   * @param params.allowedGlobalNames - Optional list of allowed global names for vat endowments.
   * @param params.onStreamFailure - Called when the channel ends before
   * `terminate` or `expectClose`.
   */
  // eslint-disable-next-line no-restricted-syntax
  private constructor({
    vatId,
    vatConfig,
    vatStream,
    kernelStore,
    kernelQueue,
    logger,
    allowedGlobalNames,
    onStreamFailure,
  }: VatConstructorProps) {
    this.vatId = vatId;
    this.config = vatConfig;
    this.#logger = logger;
    this.#allowedGlobalNames = allowedGlobalNames;
    this.#vatStream = vatStream;
    this.#onStreamFailure = onStreamFailure;
    this.#vatStore = kernelStore.makeVatStore(vatId);
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
    this.#vatStream
      .drain(this.#handleMessage.bind(this))
      .then(() => {
        // A runtime may close an exited worker's channel rather than fail it,
        // so a clean end is a lost vat too.
        this.#reportStreamFailure(new Error('vat channel closed'));
        return undefined;
      })
      .catch((error: Error) => {
        this.#reportStreamFailure(error);
      });

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
   * Fail the commands waiting on a channel that has gone, and tell the
   * manager, unless `terminate` or `expectClose` came first.
   *
   * @param error - What the channel ended with.
   */
  #reportStreamFailure(error: Error): void {
    if (this.#closing) {
      return;
    }
    const streamError = new StreamReadError(
      { vatId: this.vatId },
      { cause: error },
    );
    // Here, not left to the manager, which ignores a handle it does not hold:
    // one still shaking hands, or one a termination or restart has let go.
    this.#rpcClient.rejectAll(streamError);
    try {
      this.#onStreamFailure(streamError);
    } catch (reportError) {
      this.#logger?.error(
        `Failed to report the dead channel of vat ${this.vatId}`,
        reportError,
      );
    }
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
   * Treat the channel's end as the kernel's own doing, for a kernel about to
   * stop every worker. A command still waiting is left waiting rather than
   * failed, so the crank that sent it never commits and its item is delivered
   * again on the next start.
   */
  expectClose(): void {
    this.#closing = true;
  }

  /**
   * Closes this handle's channel to the vat worker. The store side of a vat's
   * death is `VatManager`'s.
   *
   * @param terminating - If true, the vat is being killed permanently.
   * @param error - The error to terminate the vat with.
   */
  async terminate(terminating: boolean, error?: Error): Promise<void> {
    this.#closing = true;
    if (terminating) {
      // Before `end`, which may never settle.
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
