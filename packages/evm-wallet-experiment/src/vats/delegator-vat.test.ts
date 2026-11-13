import type { Baggage } from '@metamask/ocap-kernel';
import { describe, expect, it, vi } from 'vitest';

import type {
  Address,
  DelegationGrant,
  TransferNativeGrant,
  TransferFungibleGrant,
} from '../types.ts';
import { buildRootObject } from './delegator-vat.ts';
import { makeMockBaggage } from '../../test/helpers.ts';

vi.mock('@metamask/kernel-utils/exo', () => ({
  makeDefaultExo: (_name: string, methods: Record<string, unknown>) => methods,
}));

type DelegatorVat = {
  buildTransferNativeGrant(opts: {
    delegator: Address;
    delegate: Address;
    to?: Address;
    maxAmount?: bigint;
    totalLimit?: bigint;
    chainId: number;
  }): Promise<TransferNativeGrant>;
  buildTransferFungibleGrant(opts: {
    delegator: Address;
    delegate: Address;
    token: Address;
    to?: Address;
    totalLimit?: bigint;
    chainId: number;
  }): Promise<TransferFungibleGrant>;
  storeGrant(grant: DelegationGrant): Promise<void>;
  removeGrant(id: string): Promise<void>;
  listGrants(): Promise<DelegationGrant[]>;
};

const DELEGATOR = '0x1111111111111111111111111111111111111111' as Address;
const DELEGATE = '0x2222222222222222222222222222222222222222' as Address;
const TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const RECIPIENT = '0x4444444444444444444444444444444444444444' as Address;
const CHAIN_ID = 1;

function makeRoot() {
  const baggage = makeMockBaggage();
  const root = buildRootObject(
    undefined,
    undefined,
    baggage as unknown as Baggage,
  ) as unknown as DelegatorVat;
  return { root, baggage };
}

describe('delegator-vat', () => {
  describe('buildTransferNativeGrant', () => {
    it('returns a grant with method transferNative', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      expect(grant.method).toBe('transferNative');
    });

    it('sets delegator and delegate on the delegation', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      expect(grant.delegation.delegator).toBe(DELEGATOR);
      expect(grant.delegation.delegate).toBe(DELEGATE);
      expect(grant.delegation.chainId).toBe(CHAIN_ID);
    });

    it('does not include to when not provided', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      expect(grant.to).toBeUndefined();
    });

    it('includes to when provided', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        to: RECIPIENT,
        chainId: CHAIN_ID,
      });
      expect(grant.to).toBe(RECIPIENT);
    });

    it('does not include maxAmount when not provided', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      expect(grant.maxAmount).toBeUndefined();
    });

    it('includes maxAmount when provided', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        maxAmount: 500n,
        chainId: CHAIN_ID,
      });
      expect(grant.maxAmount).toBe(500n);
    });

    it('has no caveats when no to or maxAmount', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      expect(grant.delegation.caveats).toHaveLength(0);
    });

    it('has allowedTargets caveat when to is provided', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        to: RECIPIENT,
        chainId: CHAIN_ID,
      });
      const types = grant.delegation.caveats.map((caveat) => caveat.type);
      expect(types).toContain('allowedTargets');
      expect(types).not.toContain('valueLte');
    });

    it('has valueLte caveat when maxAmount is provided', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        maxAmount: 1000n,
        chainId: CHAIN_ID,
      });
      const types = grant.delegation.caveats.map((caveat) => caveat.type);
      expect(types).toContain('valueLte');
      expect(types).not.toContain('allowedTargets');
    });

    it('has both allowedTargets and valueLte caveats when to and maxAmount are provided', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        to: RECIPIENT,
        maxAmount: 1000n,
        chainId: CHAIN_ID,
      });
      const types = grant.delegation.caveats.map((caveat) => caveat.type);
      expect(types).toContain('allowedTargets');
      expect(types).toContain('valueLte');
    });
  });

  describe('buildTransferFungibleGrant', () => {
    it('returns a grant with method transferFungible', async () => {
      const { root } = makeRoot();
      const grant: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          chainId: CHAIN_ID,
        });
      expect(grant.method).toBe('transferFungible');
    });

    it('sets token, delegator, delegate, and chainId', async () => {
      const { root } = makeRoot();
      const grant: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          chainId: CHAIN_ID,
        });
      expect(grant.token).toBe(TOKEN);
      expect(grant.delegation.delegator).toBe(DELEGATOR);
      expect(grant.delegation.delegate).toBe(DELEGATE);
      expect(grant.delegation.chainId).toBe(CHAIN_ID);
    });

    it('always has allowedTargets and allowedMethods caveats', async () => {
      const { root } = makeRoot();
      const grant: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          chainId: CHAIN_ID,
        });
      const types = grant.delegation.caveats.map((caveat) => caveat.type);
      expect(types).toContain('allowedTargets');
      expect(types).toContain('allowedMethods');
    });

    it('does not include erc20TransferAmount caveat when maxAmount is not provided', async () => {
      const { root } = makeRoot();
      const grant: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          chainId: CHAIN_ID,
        });
      const types = grant.delegation.caveats.map((caveat) => caveat.type);
      expect(types).not.toContain('erc20TransferAmount');
    });

    it('includes erc20TransferAmount caveat when totalLimit is provided', async () => {
      const { root } = makeRoot();
      const grant: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          totalLimit: 5000n,
          chainId: CHAIN_ID,
        });
      const types = grant.delegation.caveats.map((caveat) => caveat.type);
      expect(types).toContain('erc20TransferAmount');
      expect(grant.totalLimit).toBe(5000n);
    });

    it('does not include allowedCalldata caveat when to is not provided', async () => {
      const { root } = makeRoot();
      const grant: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          chainId: CHAIN_ID,
        });
      const types = grant.delegation.caveats.map((caveat) => caveat.type);
      expect(types).not.toContain('allowedCalldata');
    });

    it('includes allowedCalldata caveat when to is provided', async () => {
      const { root } = makeRoot();
      const grant: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          to: RECIPIENT,
          chainId: CHAIN_ID,
        });
      const types = grant.delegation.caveats.map((caveat) => caveat.type);
      expect(types).toContain('allowedCalldata');
      expect(grant.to).toBe(RECIPIENT);
    });

    it('includes all caveats when to and totalLimit are provided', async () => {
      const { root } = makeRoot();
      const grant: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          to: RECIPIENT,
          totalLimit: 5000n,
          chainId: CHAIN_ID,
        });
      const types = grant.delegation.caveats.map((caveat) => caveat.type);
      expect(types).toContain('allowedTargets');
      expect(types).toContain('allowedMethods');
      expect(types).toContain('erc20TransferAmount');
      expect(types).toContain('allowedCalldata');
    });
  });

  describe('storeGrant and listGrants', () => {
    it('returns empty array when no grants stored', async () => {
      const { root } = makeRoot();
      const grants = await root.listGrants();
      expect(grants).toStrictEqual([]);
    });

    it('stored grant appears in listGrants', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      await root.storeGrant(grant);
      const grants = await root.listGrants();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toStrictEqual(grant);
    });

    it('multiple stored grants all appear in listGrants', async () => {
      const { root } = makeRoot();
      const grant1: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      const grant2: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          chainId: CHAIN_ID,
        });
      await root.storeGrant(grant1);
      await root.storeGrant(grant2);
      const grants = await root.listGrants();
      expect(grants).toHaveLength(2);
    });
  });

  describe('removeGrant', () => {
    it('removed grant no longer appears in listGrants', async () => {
      const { root } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      await root.storeGrant(grant);
      await root.removeGrant(grant.delegation.id);
      const grants = await root.listGrants();
      expect(grants).toStrictEqual([]);
    });

    it('removing one grant leaves others intact', async () => {
      const { root } = makeRoot();
      const grant1: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      const grant2: TransferFungibleGrant =
        await root.buildTransferFungibleGrant({
          delegator: DELEGATOR,
          delegate: DELEGATE,
          token: TOKEN,
          chainId: CHAIN_ID,
        });
      await root.storeGrant(grant1);
      await root.storeGrant(grant2);
      await root.removeGrant(grant1.delegation.id);
      const grants = await root.listGrants();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toStrictEqual(grant2);
    });
  });

  describe('baggage persistence', () => {
    it('restores grants after second buildRootObject call with same baggage', async () => {
      const { root, baggage } = makeRoot();
      const grant: TransferNativeGrant = await root.buildTransferNativeGrant({
        delegator: DELEGATOR,
        delegate: DELEGATE,
        chainId: CHAIN_ID,
      });
      await root.storeGrant(grant);

      const restoredRoot = buildRootObject(
        undefined,
        undefined,
        baggage as unknown as Baggage,
      ) as unknown as DelegatorVat;
      const grants = await restoredRoot.listGrants();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toStrictEqual(grant);
    });
  });
});
