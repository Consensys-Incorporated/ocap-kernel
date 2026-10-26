import type { VatSyscallObject } from '@agoric/swingset-liveslots';
import type { CapData } from '@endo/marshal';

import {
  coerceEndpointMessage,
  isRemoteId,
  insistERef,
  insistRRef,
} from '../../types.ts';
import type {
  KernelMessage,
  KernelSyscallObject,
  KernelOneResolution,
  EndpointMessage,
  VatId,
  EndpointId,
  KRef,
  VRef,
  RRef,
  ERef,
} from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { getCListMethods } from './clist.ts';
import { getReachableMethods } from './reachable.ts';
import { getRefCountMethods } from './refcount.ts';
import { getVatMethods } from './vat.ts';
import { Fail, assert } from '../../utils/assert.ts';

/**
 * Create a translator object that provides functionality for translating
 * references and messages between kernel and endpoint spaces.
 *
 * @param ctx - The store context.
 * @returns A translator object that maps various kernel data structures
 * onto `kv`.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getTranslators(ctx: StoreContext) {
  const { krefToEref, erefToKref, allocateErefForKref } = getCListMethods(ctx);
  const { setReachableFlag } = getReachableMethods(ctx);
  const { kernelRefExists } = getRefCountMethods(ctx);
  const { exportFromEndpoint } = getVatMethods(ctx);

  /**
   * Reverse the direction indicator in an RRef.
   *
   * @param rref - The ref in question.
   *
   * @returns a copy of `rref` with '+'/'-' changed to '-'/'+'.
   */
  function invertRRef(rref: RRef): RRef {
    // oxlint-disable-next-line require-unicode-regexp
    const parts = rref.match(/^(r[op])([-+])(\d+)$/);
    assert(parts?.length === 4);
    return `${parts[1]}${parts[2] === '+' ? '-' : '+'}${parts[3]}` as RRef;
  }

  /**
   * Translate a reference from kernel space into endpoint space.
   *
   * Translating is how the kernel hands an endpoint a reference, so it also
   * re-establishes reachability: a vat given an object it previously dropped
   * holds it live again. Garbage collection deliveries must not do this, and
   * don't — they map through `krefsToErefs`, which never touches the flag.
   *
   * @param endpointId - The endpoint for whom translation is desired.
   * @param kref - The KRef of the entity of interest.
   * @param importIfNeeded - If true, allocate a new clist entry if necessary;
   *   if false, require that such an entry already exist.
   *
   * @returns the ERef corresponding to `kref` in `endpointId`.
   */
  function translateRefKtoE(
    endpointId: EndpointId,
    kref: KRef,
    importIfNeeded: boolean,
  ): ERef {
    let eref = krefToEref(endpointId, kref);
    if (!eref) {
      if (importIfNeeded) {
        // A kref the kernel has already deleted must not acquire a new c-list
        // entry: the entry would be a legitimate holder for the resurrected
        // count, so even the audit would endorse it. `incrementRefCount`
        // refuses that increment too; checking here refuses before an eref is
        // allocated, and says what was attempted. Reached by redeeming an ocap
        // URL issued for an object that has since been collected.
        kernelRefExists(kref) ||
          Fail`cannot import deleted kref ${kref} into ${endpointId}`;
        eref = allocateErefForKref(endpointId, kref);
      } else {
        throw Fail`unmapped kref ${kref} endpoint=${endpointId}`;
      }
    }
    setReachableFlag(endpointId, kref);
    if (isRemoteId(endpointId)) {
      // The import/export relationship between a vat and the kernel is
      // asymmetric -- the vat always exports to the kernel and imports from the
      // kernel. This is reflected in the string encoding of a VRef, where a '+'
      // indicates an export (vat to kernel) and a '-' indicates an import
      // (kernel to vat).  However, the relationship between two remotes is
      // symmetric -- an export from one is an import to the other and vice
      // versa. We thus require a convention for interpreting an RRef's
      // directionality encoding to break the symmetry. The trick (courtesy of
      // Brian Warner) is to always interpet an RRef in the context of the
      // receiving endpoint.  This means that when communicating an RRef (which
      // is implied by the fact that we're using a KtoE translation) we need to
      // flip the polarity of the character that encodes the import/export
      // direction to convert it from the sender's frame of reference to the
      // receiver's.
      //
      // Care must be taken when using these reference translation functions for
      // something other than communications (debugging or logging, say), since
      // whereas for a VRef the functional composition KtoE(EtoK(ref)) is an
      // identity function, for an RRef it is not, because KtoE reverses the
      // polarity of the RRef but EtoK doesn't.
      insistRRef(eref);
      eref = invertRRef(eref);
    }
    return eref;
  }

  /**
   * Translate a capdata object from kernel space into endpoint space.
   *
   * @param endpointId - The endpoint for whom translation is desired.
   * @param capdata - The object to be translated.
   *
   * @returns a translated copy of `capdata` intelligible to `endpointId`.
   */
  function translateCapDataKtoE(
    endpointId: EndpointId,
    capdata: CapData<KRef>,
  ): CapData<ERef> {
    const slots: ERef[] = [];
    for (const slot of capdata.slots) {
      slots.push(translateRefKtoE(endpointId, slot, true));
    }
    return { body: capdata.body, slots };
  }

  /**
   * Translate a message from kernel space into endpoint space.
   *
   * @param endpointId - The endpoint for whom translation is desired.
   * @param message - The message to be translated.
   *
   * @returns a translated copy of `message` intelligible to `endpointId`.
   */
  function translateMessageKtoE(
    endpointId: EndpointId,
    message: KernelMessage,
  ): EndpointMessage {
    const methargs = translateCapDataKtoE(endpointId, message.methargs);
    if (typeof message.result === 'string') {
      const result = translateRefKtoE(endpointId, message.result, true);
      return { methargs, result };
    }
    if (message.result === null) {
      return { methargs, result: null };
    }
    return { methargs };
  }

  /**
   * Translate a reference from endpoint space into kernel space.
   *
   * @param endpointId - The endpoint for whom translation is desired.
   * @param eref - The ERef of the entity of interest.
   *
   * @returns the KRef corresponding to `eref` in this endpoint.
   */
  function translateRefEtoK(endpointId: EndpointId, eref: ERef): KRef {
    let kref = erefToKref(endpointId, eref);
    kref ??= exportFromEndpoint(endpointId, eref);
    return kref;
  }

  /**
   * Translate a capdata object from endpoint space into kernel space.
   *
   * @param endpointId - The endpoint for whom translation is desired.
   * @param capdata - The object to be translated.
   *
   * @returns a translated copy of `capdata` intelligible to the kernel.
   */
  function translateCapDataEtoK(
    endpointId: EndpointId,
    capdata: CapData<ERef>,
  ): CapData<KRef> {
    const slots: KRef[] = [];
    for (const slot of capdata.slots) {
      slots.push(translateRefEtoK(endpointId, slot));
    }
    return { body: capdata.body, slots };
  }

  /**
   * Translate a message from endpoint space into kernel space.
   *
   * @param endpointId - The endpoint for whom translation is desired.
   * @param message - The message to be translated.
   *
   * @returns a translated copy of `message` intelligible to the kernel.
   */
  function translateMessageEtoK(
    endpointId: EndpointId,
    message: EndpointMessage,
  ): KernelMessage {
    const methargs = translateCapDataEtoK(endpointId, message.methargs);
    if (typeof message.result !== 'string') {
      throw TypeError(`message result must be a string`);
    }
    insistERef(message.result);
    const result = translateRefEtoK(endpointId, message.result);
    return { methargs, result };
  }

  /**
   * Translate a syscall from vat space into kernel space.
   *
   * @param vatId - The vat for whom translation is desired.
   * @param vso - The syscall object to be translated.
   *
   * @returns a translated copy of `vso` intelligible to the kernel.
   */
  function translateSyscallVtoK(
    vatId: VatId,
    vso: VatSyscallObject,
  ): KernelSyscallObject {
    switch (vso[0]) {
      case 'send': {
        const [, target, message] = vso;
        insistERef(target);
        return [
          'send',
          translateRefEtoK(vatId, target),
          translateMessageEtoK(vatId, coerceEndpointMessage(message)),
        ];
      }
      case 'subscribe': {
        const [, promise] = vso;
        insistERef(promise);
        return ['subscribe', translateRefEtoK(vatId, promise)];
      }
      case 'resolve': {
        const [, resolutions] = vso;
        const kResolutions: KernelOneResolution[] = resolutions.map(
          (resolution) => {
            const [vpid, rejected, data] = resolution;
            insistERef(vpid);
            return [
              translateRefEtoK(vatId, vpid),
              rejected,
              translateCapDataEtoK(vatId, data as CapData<VRef>),
            ];
          },
        );
        return ['resolve', kResolutions];
      }
      case 'exit': {
        const [, isFailure, info] = vso;
        return [
          'exit',
          isFailure,
          translateCapDataEtoK(vatId, info as CapData<VRef>),
        ];
      }
      case 'dropImports':
      case 'retireImports':
      case 'retireExports':
      case 'abandonExports': {
        const [op, vrefs] = vso;
        const krefs = vrefs.map((ref) => {
          insistERef(ref);
          return translateRefEtoK(vatId, ref);
        });
        return [op, krefs];
      }
      case 'callNow':
      case 'vatstoreGet':
      case 'vatstoreGetNextKey':
      case 'vatstoreSet':
      case 'vatstoreDelete': {
        const [op] = vso;
        throw Error(`vat ${vatId} issued invalid syscall ${op}`);
      }
      default: {
        // Compile-time exhaustiveness check
        // oxlint-disable-next-line typescript/restrict-template-expressions
        throw Error(`vat ${vatId} issued unknown syscall ${vso[0]}`);
      }
    }
  }

  return {
    translateRefEtoK,
    translateRefKtoE,
    translateCapDataKtoE,
    translateCapDataEtoK,
    translateMessageKtoE,
    translateMessageEtoK,
    translateSyscallVtoK,
    invertRRef,
  };
}
