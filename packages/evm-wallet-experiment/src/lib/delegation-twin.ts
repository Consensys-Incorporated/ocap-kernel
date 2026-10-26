import { M } from '@endo/patterns';
import { makeDiscoverableExo } from '@metamask/kernel-utils/discoverable';

import { encodeTransfer } from './erc20.ts';
import { METHOD_CATALOG } from './method-catalog.ts';
import type { Address, DelegationGrant, Execution, Hex } from '../types.ts';

export type TransferNativeFacet = {
  transferNative: (to: Address, amount: bigint) => Promise<Hex>;
};

export type TransferFungibleFacet = {
  transferFungible: (
    token: Address,
    to: Address,
    amount: bigint,
  ) => Promise<Hex>;
};

export type DelegationSection =
  | { exo: TransferNativeFacet; method: 'transferNative' }
  | {
      exo: TransferFungibleFacet;
      method: 'transferFungible';
      token: Address;
    };

type DelegationTwinOptions = {
  grant: DelegationGrant;
  redeemFn: (execution: Execution) => Promise<Hex>;
};

/**
 * Build a DelegationSection for a delegation grant.
 * The resulting exo exposes the method covered by the grant, enforcing
 * local guards and (for transferFungible) a local budget tracker.
 *
 * @param options - Twin construction options.
 * @param options.grant - The semantic delegation grant to wrap.
 * @param options.redeemFn - Submits an Execution to the delegation framework.
 * @returns A DelegationSection wrapping the delegation exo.
 */
export function makeDelegationTwin(
  options: DelegationTwinOptions,
): DelegationSection {
  const { grant, redeemFn } = options;
  const { delegation } = grant;
  const idPrefix = delegation.id.slice(0, 12);

  if (grant.method === 'transferNative') {
    const { to } = grant;
    // maxAmount may arrive as a string when the grant crosses a JSON boundary
    // (e.g. CLI args or test helpers). Normalize to bigint so M.lte() and the
    // method body comparison work correctly regardless of the source.
    const maxAmount =
      grant.maxAmount === undefined ? undefined : BigInt(grant.maxAmount);
    const totalLimit =
      grant.totalLimit === undefined ? undefined : BigInt(grant.totalLimit);

    const toGuard = to === undefined ? M.string() : M.eq(to);
    const amountGuard = maxAmount === undefined ? M.bigint() : M.lte(maxAmount);

    const interfaceGuard = M.interface(
      `DelegationTwin:transferNative:${idPrefix}`,
      {
        transferNative: M.callWhen(toGuard, amountGuard).returns(M.string()),
      },
      { defaultGuards: 'passable' },
    );

    let spent = 0n;
    const cumulativeMax = totalLimit ?? 2n ** 256n - 1n;

    const exo = makeDiscoverableExo(
      `DelegationTwin:transferNative:${idPrefix}`,
      {
        async transferNative(recipient: Address, amount: bigint): Promise<Hex> {
          if (maxAmount !== undefined && amount > maxAmount) {
            throw new Error(`Amount ${amount} exceeds limit ${maxAmount}`);
          }
          if (amount > cumulativeMax - spent) {
            throw new Error(
              `Insufficient budget: requested ${amount}, remaining ${cumulativeMax - spent}`,
            );
          }

          // Reserve before the await so concurrent calls see the updated budget.
          spent += amount;

          const execution: Execution = {
            target: recipient,
            value: `0x${amount.toString(16)}`,
            callData: '0x' as Hex,
          };

          try {
            return await redeemFn(execution);
          } catch (error) {
            // Roll back on redeemFn failure.
            spent -= amount;
            throw error;
          }
        },
      },
      { transferNative: METHOD_CATALOG.transferNative },
      interfaceGuard,
    );

    return { exo, method: 'transferNative' };
  }

  // transferFungible — normalize token address to lowercase for consistent matching.
  const { to } = grant;
  const token = grant.token.toLowerCase() as Address;
  // totalLimit may arrive as a string when the grant crosses a JSON boundary.
  // Normalize to bigint so arithmetic comparisons work correctly.
  const totalLimit =
    grant.totalLimit === undefined ? undefined : BigInt(grant.totalLimit);

  let spent = 0n;
  const max = totalLimit ?? 2n ** 256n - 1n;

  const toGuard = to === undefined ? M.string() : M.eq(to);

  const interfaceGuard = M.interface(
    `DelegationTwin:transferFungible:${idPrefix}`,
    {
      transferFungible: M.callWhen(M.eq(token), toGuard, M.bigint()).returns(
        M.string(),
      ),
    },
    { defaultGuards: 'passable' },
  );

  const exo = makeDiscoverableExo(
    `DelegationTwin:transferFungible:${idPrefix}`,
    {
      async transferFungible(
        tokenAddress: Address,
        recipient: Address,
        amount: bigint,
      ): Promise<Hex> {
        if (amount > max - spent) {
          throw new Error(
            `Insufficient budget: requested ${amount}, remaining ${max - spent}`,
          );
        }

        // Reserve before the await so concurrent calls see the updated budget.
        spent += amount;

        const execution: Execution = {
          target: tokenAddress,
          value: '0x0' as Hex,
          callData: encodeTransfer(recipient, amount),
        };

        try {
          return await redeemFn(execution);
        } catch (error) {
          // Roll back on redeemFn failure.
          spent -= amount;
          throw error;
        }
      },
    },
    { transferFungible: METHOD_CATALOG.transferFungible },
    interfaceGuard,
  );

  return { exo, method: 'transferFungible', token };
}
