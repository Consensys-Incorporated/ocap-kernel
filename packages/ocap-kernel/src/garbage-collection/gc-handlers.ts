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
 * Refuse a GC syscall that names a kref twice: the first would retire it, and
 * the second fail to find it.
 *
 * @param krefs - The KRefs the syscall names.
 * @param issued - Who issued what, for the error.
 */
function checkDistinct(krefs: KRef[], issued: string): void {
  if (new Set(krefs).size !== krefs.length) {
    throw Error(`${issued} naming a kref twice`);
  }
}

/**
 * Check a 'retireImports' syscall before any of it is done.
 *
 * @param krefs - The KRefs of the imports to be retired.
 * @param endpointId - The endpoint doing the retiring.
 * @param kernelStore - The kernel store.
 * @throws If the endpoint may not retire them, which is its own fault.
 */
export function checkRetireImports(
  krefs: KRef[],
  endpointId: EndpointId,
  kernelStore: KernelStore,
): void {
  checkDistinct(krefs, `endpoint ${endpointId} issued retireImports`);
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
  checkRetireImports(krefs, endpointId, kernelStore);
  for (const kref of krefs) {
    // deleting the clist entry will decrement the recognizable count, but
    // not the reachable count (because it was unreachable, as we asserted)
    kernelStore.forgetKref(endpointId, kref);
  }
}

/**
 * Check a 'retireExports' or 'abandonExports' syscall before any of it is
 * done.
 *
 * @param krefs - The KRefs of the exports to be retired or abandoned.
 * @param checkReachable - If true, verify the object is not reachable
 *   (retire). If false, ignore reachability (abandon).
 * @param endpointId - The endpoint doing the operation.
 * @param kernelStore - The kernel store.
 * @throws If the endpoint may not retire or abandon them, which is its own
 * fault.
 */
export function checkExportCleanup(
  krefs: KRef[],
  checkReachable: boolean,
  endpointId: EndpointId,
  kernelStore: KernelStore,
): void {
  const action = checkReachable ? 'retire' : 'abandon';
  checkDistinct(krefs, `endpoint ${endpointId} issued ${action}Exports`);
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
  }
}

/**
 * Do the work of a 'retireExports' or 'abandonExports' syscall.
 *
 * @param krefs - The KRefs of the exports to be retired or abandoned.
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
  checkExportCleanup(krefs, checkReachable, endpointId, kernelStore);
  for (const kref of krefs) {
    kernelStore.forgetKref(endpointId, kref);
    kernelStore.orphanKernelObject(kref, endpointId);
  }
}
