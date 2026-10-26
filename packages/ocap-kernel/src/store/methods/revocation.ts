import type { KRef } from '../../types.ts';
import type { StoreContext } from '../types.ts';
import { getBaseMethods } from './base.ts';
import { isPromiseRef } from '../utils/promise-ref.ts';

/**
 * Get the methods that provide functionality for managing object revocation.
 *
 * @param ctx - The store context.
 * @returns The revocation methods.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export const getRevocationMethods = (ctx: StoreContext) => {
  const { getRevokedKey } = getBaseMethods(ctx.kv);

  /**
   * Set the revoked flag for a kernel object.
   *
   * @param koId - The KRef of the kernel object to set the revoked flag for.
   * @param revoked - The value of the revoked flag.
   */
  function setRevoked(koId: KRef, revoked: boolean): void {
    if (revoked) {
      ctx.kv.set(getRevokedKey(koId), 'true');
    } else {
      ctx.kv.delete(getRevokedKey(koId));
    }
  }

  /**
   * Revoke a kernel object. Idempotent. Revoking promises is not supported.
   *
   * @param koId - The KRef of the kernel object to revoke.
   * @throws If the object is a promise or the koId is unknown.
   */
  function revoke(koId: KRef): void {
    if (isPromiseRef(koId)) {
      // Revoking a promise is not supported.
      throw Error(`cannot revoke promise ${koId}`);
    }
    // Set the revoked flag to true.
    setRevoked(koId, true);
  }

  /**
   * Check if a kernel object has been revoked.
   *
   * @param koId - The KRef of the kernel object of interest.
   * @returns True if the object is revoked, false otherwise.
   * @throws If the object is unknown and `throwIfUnknown` is true.
   */
  function isRevoked(koId: KRef): boolean {
    return Boolean(ctx.kv.get(getRevokedKey(koId)));
  }

  return {
    setRevoked,
    revoke,
    isRevoked,
  };
};
