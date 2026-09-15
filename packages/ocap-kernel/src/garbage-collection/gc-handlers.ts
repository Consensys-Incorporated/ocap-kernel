import type { KernelStore } from '../store/index.ts';
import { parseRef } from '../store/utils/parse-ref.ts';
import type { KRef, EndpointId } from '../types.ts';

/**
 * Do the work of a 'dropImports' syscall.
 *
 * @param krefs - The KRefs of the imports to be dropped.
 * @param endpointId - The endpoint doing the dropping.
 * @param kernelStore - The kernel store.
 */
export function performDropImports(
  krefs: KRef[],
  endpointId: EndpointId,
  kernelStore: KernelStore,
): void {
  for (const kref of krefs) {
    /*
    const { isPromise } = parseRef(kref);
    if (isPromise) {
      throw Error(
        `endpoint ${endpointId} issued invalid dropImports for ${kref}`,
      );
    }
    */
    kernelStore.clearReachableFlag(endpointId, kref);
  }
}

/**
 * Do the work of a 'retireImports' syscall.
 *
 * @param krefs - The KRefs of the imports to be retired.
 * @param endpointId - The endpoint doing the retiring.
 * @param kernelStore - The kernel store.
 */
export function performRetireImports(
  krefs: KRef[],
  endpointId: EndpointId,
  kernelStore: KernelStore,
): void {
  for (const kref of krefs) {
    const { isPromise } = parseRef(kref);
    if (isPromise) {
      throw Error(
        `endpoint ${endpointId} issued invalid retireImports for ${kref}`,
      );
    }
    if (kernelStore.getReachableFlag(endpointId, kref)) {
      throw Error(`retireImports but ${kref} is still reachable`);
    }
    // deleting the clist entry will decrement the recognizable count, but
    // not the reachable count (because it was unreachable, as we asserted)
    kernelStore.forgetKref(endpointId, kref);
  }
}

/**
 * Do the work of a 'dropExports' or 'abandonExports' syscall.
 *
 * @param krefs - The KRefs of the exports to be dropped or abandoned.
 * @param checkReachable - If true, verify the object is not reachable
 *   (retire). If false, ignore reachability (abandon).
 * @param endpointId - The endpoint doing the operation.
 * @param kernelStore - The kernel store.
 */
export function performExportCleanup(
  krefs: KRef[],
  checkReachable: boolean,
  endpointId: EndpointId,
  kernelStore: KernelStore,
): void {
  const action = checkReachable ? 'retire' : 'abandon';
  for (const kref of krefs) {
    const { isPromise } = parseRef(kref);
    if (isPromise) {
      throw Error(
        `endpoint ${endpointId} issued invalid ${action}Exports for ${kref}`,
      );
    }
    // `translateSyscallVtoK` maps import and export refs alike, so nothing
    // below required the named ref to be an export at all.
    const owner = kernelStore.getOwner(kref);
    if (owner !== undefined && owner !== endpointId) {
      throw Error(
        `endpoint ${endpointId} issued ${action}Exports for ${kref}, which is owned by ${owner}`,
      );
    }
    const eref = kernelStore.krefToEref(endpointId, kref);
    if (eref === undefined || parseRef(eref).direction !== 'export') {
      throw Error(
        `endpoint ${endpointId} issued ${action}Exports for ${kref}, which it does not export`,
      );
    }
    if (checkReachable) {
      if (kernelStore.getReachableFlag(endpointId, kref)) {
        throw Error(`${action}Exports but ${kref} is still reachable`);
      }
    }
    kernelStore.forgetKref(endpointId, kref);
    kernelStore.orphanKernelObject(kref, endpointId);
  }
}
