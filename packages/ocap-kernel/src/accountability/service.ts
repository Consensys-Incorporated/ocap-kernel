import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import { assert, boolean, exactOptional, object } from '@metamask/superstruct';

import type { AccountabilityRecord, TrackOptions } from './types.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import { krefOf } from '../liveslots/kernel-marshal.ts';
import type { SlotValue } from '../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../store/index.ts';
import { isPromiseRef } from '../store/utils/promise-ref.ts';
import type { KRef, Sender } from '../types.ts';

const TrackOptionsStruct = object({
  recordArgs: exactOptional(boolean()),
});

/** Who is calling, as the kernel saw it, not as the caller says. */
export type Caller = { caller: Sender };

/**
 * The kernel service through which a holder of an object asks for a record of
 * what is done with it, and reads the record back. Its methods take the
 * caller first, supplied by the kernel; a vat calls them without it.
 *
 * The caller's identity is for the record, not for deciding who may do what.
 * Nothing here changes who may send what to whom.
 */
export type AccountabilityService = {
  /**
   * Start recording every message delivered to an object and every time it is
   * carried to an endpoint, in this kernel. Any holder may ask; the object
   * stays tracked until every holder that asked has untracked it, or it is
   * collected.
   */
  track(caller: Caller, obj: SlotValue, options?: TrackOptions): Promise<void>;
  /** Withdraw this caller's tracking of an object. */
  untrack(caller: Caller, obj: SlotValue): Promise<void>;
  /**
   * Read the records about an object. The owner sees every record; another
   * holder sees only its own chain of custody and the deliveries it sent.
   */
  history(caller: Caller, obj: SlotValue): Promise<AccountabilityRecord[]>;
};

/**
 * Get the kref of an object a vat passed as an argument.
 *
 * @param obj - The argument.
 * @returns The kref.
 */
function objectKrefOf(obj: SlotValue): KRef {
  let kref: KRef;
  try {
    kref = krefOf(obj);
  } catch {
    throw Error('Argument must be a remotable');
  }
  if (isPromiseRef(kref)) {
    throw Error('Argument must be an object, not a promise');
  }
  return kref;
}

/**
 * Make the accountability kernel service.
 *
 * Each method does its reading or writing once no crank is open: a method is
 * invoked in a turn of its own, during or after the crank that delivered the
 * call, and a write made into that crank would be lost with it if it aborted.
 *
 * @param options - Options bag.
 * @param options.kernelStore - The kernel's store.
 * @param options.kernelQueue - The kernel's run queue.
 * @returns The service.
 */
export function makeAccountabilityService({
  kernelStore,
  kernelQueue,
}: {
  kernelStore: KernelStore;
  kernelQueue: KernelQueue;
}): AccountabilityService {
  return makeDefaultExo('accountabilityService', {
    async track(
      { caller }: Caller,
      obj: SlotValue,
      options: TrackOptions = {},
    ): Promise<void> {
      const kref = objectKrefOf(obj);
      assert(options, TrackOptionsStruct);
      await kernelQueue.writeOutsideCrank(() =>
        kernelStore.trackObject(kref, caller, options),
      );
    },

    async untrack({ caller }: Caller, obj: SlotValue): Promise<void> {
      const kref = objectKrefOf(obj);
      await kernelQueue.writeOutsideCrank(() => {
        kernelStore.untrackObject(kref, caller);
      });
    },

    async history(
      { caller }: Caller,
      obj: SlotValue,
    ): Promise<AccountabilityRecord[]> {
      const kref = objectKrefOf(obj);
      return kernelQueue.writeOutsideCrank(() =>
        harden(
          kernelStore.getAccountabilityRecords(
            kernelStore.getOwner(kref) === caller
              ? { kref }
              : { kref, involving: caller },
          ),
        ),
      );
    },
  });
}
