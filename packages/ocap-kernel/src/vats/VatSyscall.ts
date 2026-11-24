import type {
  VatSyscallObject,
  VatSyscallResult,
} from '@agoric/swingset-liveslots';
import type { CapData } from '@endo/marshal';
import type { FatalKernelErrorCode } from '@metamask/kernel-errors';
import { Logger } from '@metamask/logger';

import { nextHop, traceOfDelivery } from '../accountability/trace.ts';
import type { TraceContext } from '../accountability/types.ts';
import {
  performDropImports,
  performRetireImports,
  performExportCleanup,
} from '../garbage-collection/gc-handlers.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import { makeFatalKernelError } from '../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../store/index.ts';
import { isStoreFault } from '../store/utils/store-fault.ts';
import type {
  Cause,
  KernelSyscallObject,
  KernelMessage,
  KernelOneResolution,
  VatId,
  KRef,
} from '../types.ts';

type VatSyscallProps = {
  vatId: VatId;
  kernelQueue: KernelQueue;
  kernelStore: KernelStore;
  logger?: Logger | undefined;
};

/**
 * A VatSyscall is a class that handles syscalls from a vat.
 *
 * This class is responsible for handling syscalls from a vat, including
 * sending messages, resolving promises, and dropping imports.
 */
export class VatSyscall {
  /** The ID of the vat */
  readonly vatId: VatId;

  /** The kernel's run queue */
  readonly #kernelQueue: KernelQueue;

  /** The kernel's store */
  readonly #kernelStore: KernelStore;

  /** Logger for outputting messages (such as errors) to the console */
  readonly #logger: Logger | undefined;

  /** The illegal syscall that was received */
  illegalSyscall: { vatId: VatId; info: CapData<KRef> } | undefined;

  /**
   * Whether a delivery to the vat is in flight, which makes a syscall part
   * of the vat's answer to it, on its cause and its trace. A syscall at any
   * other time is the vat's own doing between deliveries, whatever crank
   * happens to be open.
   */
  delivering = false;

  /** The error when delivery failed */
  deliveryError: string | undefined;

  /** The termination request that was received from the vat with syscall.exit() */
  vatRequestedTermination: { reject: boolean; info: CapData<KRef> } | undefined;

  /** Set once the kernel has let go of the worker these syscalls come from. */
  retired: boolean = false;

  /**
   * Construct a new VatSyscall instance.
   *
   * @param props - The properties for the VatSyscall.
   * @param props.vatId - The ID of the vat.
   * @param props.kernelQueue - The kernel's run queue.
   * @param props.kernelStore - The kernel's store.
   * @param props.logger - The logger for the VatSyscall.
   */
  constructor({ vatId, kernelQueue, kernelStore, logger }: VatSyscallProps) {
    this.vatId = vatId;
    this.#kernelQueue = kernelQueue;
    this.#kernelStore = kernelStore;
    this.#logger = logger;
  }

  /**
   * Handle a 'send' syscall from the vat. During a crank, the send is
   * buffered and flushed on crank completion. Before the run loop starts there
   * is no crank, and the send is enqueued at once.
   *
   * @param target - The target of the message send.
   * @param message - The message that was sent.
   * @param scheduledIn - The crank whose delivery scheduled the callback the
   * send was issued from, if the supervisor said.
   */
  #handleSyscallSend(
    target: KRef,
    message: KernelMessage,
    scheduledIn: number | undefined,
  ): void {
    const immediate = !this.#kernelStore.isInCrank();
    this.#kernelQueue.enqueueSend(target, message, {
      sender: this.vatId,
      immediate,
      ...this.#context(scheduledIn),
    });
  }

  /**
   * Handle a 'resolve' syscall from the vat. During a crank, notifications
   * are buffered and flushed on crank completion. Before the run loop starts
   * there is no crank, and they are enqueued at once.
   *
   * @param resolutions - One or more promise resolutions.
   * @param scheduledIn - The crank whose delivery scheduled the callback the
   * resolution was issued from, if the supervisor said.
   */
  #handleSyscallResolve(
    resolutions: KernelOneResolution[],
    scheduledIn: number | undefined,
  ): void {
    const immediate = !this.#kernelStore.isInCrank();
    const { trace } = this.#context(scheduledIn);
    this.#kernelQueue.resolvePromises(this.vatId, resolutions, {
      immediate,
      ...(trace === undefined ? {} : { trace }),
    });
  }

  /**
   * What a send or resolution carries as its cause and trace. During a
   * delivery to the vat: that delivery's crank, and its trace by default.
   * Between deliveries, when the supervisor says which crank's delivery
   * scheduled the callback it came from: that crank, on the supervisor's
   * word, and the delivery's trace, one hop on, where the kernel recorded
   * one; a crank the kernel has not run yet is not taken. Otherwise no cause
   * and no trace, whatever crank happens to be open.
   *
   * @param scheduledIn - The crank the supervisor named, if any.
   * @returns The cause, and the trace where it is not the default.
   */
  #context(scheduledIn: number | undefined): {
    cause: Cause;
    trace?: TraceContext | null;
  } {
    if (this.delivering) {
      return { cause: this.#kernelStore.getCrankNumber() };
    }
    if (
      scheduledIn === undefined ||
      !Number.isInteger(scheduledIn) ||
      scheduledIn < 1 ||
      scheduledIn > this.#kernelStore.getCrankNumber()
    ) {
      return { cause: 'async', trace: null };
    }
    return {
      cause: { crankNumber: scheduledIn, witness: 'liveslots' },
      trace:
        nextHop(
          traceOfDelivery({
            kernelStore: this.#kernelStore,
            endpoint: this.vatId,
            crank: scheduledIn,
          }),
        ) ?? null,
    };
  }

  /**
   * Handle a 'subscribe' syscall from the vat.
   *
   * @param kpid - The KRef of the promise being subscribed to.
   */
  #handleSyscallSubscribe(kpid: KRef): void {
    const kp = this.#kernelStore.getKernelPromise(kpid);
    if (kp.state === 'unresolved') {
      this.#kernelStore.addPromiseSubscriber(this.vatId, kpid);
    } else {
      const immediate = !this.#kernelStore.isInCrank();
      this.#kernelQueue.enqueueNotify(this.vatId, kpid, immediate);
    }
  }

  /**
   * Handle a 'dropImports' syscall from the vat.
   *
   * @param krefs - The KRefs of the imports to be dropped.
   */
  #handleSyscallDropImports(krefs: KRef[]): void {
    performDropImports(krefs, this.vatId, this.#kernelStore);
  }

  /**
   * Handle a 'retireImports' syscall from the vat.
   *
   * @param krefs - The KRefs of the imports to be retired.
   */
  #handleSyscallRetireImports(krefs: KRef[]): void {
    performRetireImports(krefs, this.vatId, this.#kernelStore);
  }

  /**
   * Handle retiring or abandoning exports syscall from the vat.
   *
   * @param krefs - The KRefs of the exports to be retired/abandoned.
   * @param checkReachable - If true, verify the object is not reachable
   *   (retire). If false, ignore reachability (abandon).
   */
  #handleSyscallExportCleanup(krefs: KRef[], checkReachable: boolean): void {
    performExportCleanup(krefs, checkReachable, this.vatId, this.#kernelStore);

    // XXX This log output is only here for the benefit of a couple of the
    // tests.  Arguably, those tests should be revised not to need it, but for now...
    const action = checkReachable ? 'retire' : 'abandon';
    for (const kref of krefs) {
      this.#logger?.debug(`${action}Exports: deleted object ${kref}`);
    }
  }

  /**
   * Handle a syscall from the vat. A store fault stops the kernel, and anything
   * else is taken for the vat's fault. SwingSet stops the kernel on any failure past
   * translation, but our translation checks less than SwingSet's, so a vat's
   * own mistake can get that far.
   *
   * @param vso - The syscall that was received.
   * @param scheduledIn - For a syscall issued from a callback the vat
   * scheduled during a delivery, the crank of that delivery, as the
   * supervisor says.
   * @returns The result of the syscall.
   */
  handleSyscall(
    vso: VatSyscallObject,
    scheduledIn?: number | undefined,
  ): VatSyscallResult {
    try {
      this.illegalSyscall = undefined;
      this.vatRequestedTermination = undefined;

      // This is a safety check - this case should never happen
      if (!this.#kernelStore.isVatActive(this.vatId)) {
        this.#recordVatFatalSyscall(
          'ILLEGAL_SYSCALL',
          'Syscall from inactive vat',
        );
        return harden(['error', 'vat not found']);
      }

      const kso: KernelSyscallObject = this.#kernelStore.translateSyscallVtoK(
        this.vatId,
        vso,
      );
      const [op] = kso;
      const { vatId } = this;
      switch (op) {
        case 'send': {
          const [, target, message] = kso;
          this.#logger?.log(
            `@@@@ ${vatId} syscall send ${target}<-${JSON.stringify(message)}`,
          );
          this.#handleSyscallSend(target, message, scheduledIn);
          break;
        }
        case 'subscribe': {
          const [, promise] = kso;
          this.#logger?.log(`@@@@ ${vatId} syscall subscribe ${promise}`);
          this.#handleSyscallSubscribe(promise);
          break;
        }
        case 'resolve': {
          const [, resolutions] = kso;
          this.#logger?.log(
            `@@@@ ${vatId} syscall resolve ${JSON.stringify(resolutions)}`,
          );
          this.#handleSyscallResolve(resolutions, scheduledIn);
          break;
        }
        case 'exit': {
          const [, isFailure, info] = kso;
          this.#logger?.log(
            `@@@@ ${vatId} syscall exit fail=${isFailure} ${JSON.stringify(info)}`,
          );
          this.vatRequestedTermination = { reject: isFailure, info };
          break;
        }
        case 'dropImports': {
          const [, krefs] = kso;
          this.#logger?.log(
            `@@@@ ${vatId} syscall dropImports ${JSON.stringify(krefs)}`,
          );
          this.#handleSyscallDropImports(krefs);
          break;
        }
        case 'retireImports': {
          const [, krefs] = kso;
          this.#logger?.log(
            `@@@@ ${vatId} syscall retireImports ${JSON.stringify(krefs)}`,
          );
          this.#handleSyscallRetireImports(krefs);
          break;
        }
        case 'retireExports': {
          const [, krefs] = kso;
          this.#logger?.log(
            `@@@@ ${vatId} syscall retireExports ${JSON.stringify(krefs)}`,
          );
          this.#handleSyscallExportCleanup(krefs, true);
          break;
        }
        case 'abandonExports': {
          const [, krefs] = kso;
          this.#logger?.log(
            `@@@@ ${vatId} syscall abandonExports ${JSON.stringify(krefs)}`,
          );
          this.#handleSyscallExportCleanup(krefs, false);
          break;
        }
        default:
          // Compile-time exhaustiveness check
          // oxlint-disable-next-line typescript/restrict-template-expressions
          this.#logger?.warn(`vat ${vatId} issued unknown syscall ${op} `, vso);
          break;
      }
      return harden(['ok', null]);
    } catch (error) {
      // Returned, not thrown: in a delivery this runs in the drain of the vat's
      // channel, where a throw reads as the channel lost, and as inbox work a
      // throw kills the run loop.
      if (isStoreFault(error)) {
        const panic = this.#kernelQueue.panic(
          `syscall ${vso[0]} from vat ${this.vatId} failed`,
          error,
        );
        this.#logger?.error(panic.message, error);
        return harden(['error', panic.message]);
      }
      this.#logger?.error(`Fatal syscall error in vat ${this.vatId}`, error);
      this.#recordVatFatalSyscall(
        'ILLEGAL_SYSCALL',
        'Syscall translation error: prepare to die',
      );
      return harden([
        'error',
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }

  /**
   * Take a syscall the vat made outside its own delivery, from a timer or a
   * fetch callback. The run loop applies it in a crank of its own, ahead of
   * the vat's next delivery, and terminates the vat there if the syscall is
   * illegal or an exit.
   *
   * @param vso - The syscall that was received.
   * @param scheduledIn - The crank of the delivery that scheduled the
   * callback, as the supervisor says, if it did.
   */
  handleLateSyscall(
    vso: VatSyscallObject,
    scheduledIn?: number | undefined,
  ): void {
    const { vatId } = this;
    this.#kernelQueue
      .enqueueInbox(`apply a syscall from vat ${vatId}`, () => {
        // Terminated or restarted while the syscall waited its turn.
        if (this.retired || !this.#kernelStore.isVatActive(vatId)) {
          this.#logger?.debug(
            `Dropped syscall ${vso[0]} from vat ${vatId}, which is gone`,
          );
          return { value: undefined };
        }
        this.handleSyscall(vso, scheduledIn);
        if (this.illegalSyscall) {
          const { info } = this.illegalSyscall;
          return {
            failure: Error(`Illegal syscall ${vso[0]} from vat ${vatId}`),
            abort: true,
            terminate: { vatId, reject: true, info },
          };
        }
        if (this.vatRequestedTermination) {
          return {
            value: undefined,
            terminate: { vatId, ...this.vatRequestedTermination },
          };
        }
        return { value: undefined };
      })
      .catch((error) => {
        this.#logger?.error(
          `Syscall ${vso[0]} from vat ${vatId}, made outside a delivery, was not applied`,
          error,
        );
      });
  }

  /**
   * Log a fatal syscall error and set the illegalSyscall property.
   *
   * @param code - The fatal kernel error code.
   * @param detail - A human-readable description of the error.
   */
  #recordVatFatalSyscall(code: FatalKernelErrorCode, detail: string): void {
    this.illegalSyscall = {
      vatId: this.vatId,
      info: makeFatalKernelError(code, detail),
    };
  }
}
