import { getBaseMethods } from './base.ts';
import type { VatId, RemoteId, EndpointId } from '../../types.ts';
import type { StoreContext } from '../types.ts';

/**
 * Create a store for allocating IDs.
 *
 * @param ctx - The store context.
 * @returns The ID store.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getIdMethods(ctx: StoreContext) {
  const { kv } = ctx;
  const { incCounter } = getBaseMethods(kv);

  /**
   * Obtain an ID for a new vat.
   *
   * @returns The next VatID use.
   */
  function getNextVatId(): VatId {
    return `v${incCounter(ctx.nextVatId)}` as VatId;
  }

  /**
   * Obtain an ID for a new remote connection.
   *
   * @returns The next remote ID use.
   */
  function getNextRemoteId(): RemoteId {
    return `r${incCounter(ctx.nextRemoteId)}` as RemoteId;
  }

  /**
   * Initialize persistent state for a new endpoint.
   *
   * @param endpointId - The ID of the endpoint being added.
   */
  function initEndpoint(endpointId: EndpointId): void {
    kv.set(`e.nextPromiseId.${endpointId}`, '1');
    kv.set(`e.nextObjectId.${endpointId}`, '1');
  }

  return {
    getNextVatId,
    getNextRemoteId,
    initEndpoint,
  };
}
