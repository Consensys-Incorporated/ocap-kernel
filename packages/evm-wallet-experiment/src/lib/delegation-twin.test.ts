import { describe, expect, it, vi } from 'vitest';

import type {
  Address,
  DelegationGrant,
  Execution,
  Hex,
  TransferFungibleGrant,
  TransferNativeGrant,
} from '../types.ts';
import { makeDelegationTwin } from './delegation-twin.ts';
import type {
  TransferFungibleFacet,
  TransferNativeFacet,
} from './delegation-twin.ts';

let lastInterfaceGuard: unknown;

vi.mock('@metamask/kernel-utils/discoverable', () => ({
  makeDiscoverableExo: (
    _name: string,
    methods: Record<string, (...args: unknown[]) => unknown>,
    methodSchema: Record<string, unknown>,
    interfaceGuard?: unknown,
  ) => {
    lastInterfaceGuard = interfaceGuard;
    return {
      ...methods,
      __getDescription__: () => methodSchema,
    };
  },
}));

const ALICE = '0x1111111111111111111111111111111111111111' as Address;
const BOB = '0x2222222222222222222222222222222222222222' as Address;
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const TX_HASH =
  '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex;

const BASE_DELEGATION = {
  id: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  delegator: ALICE,
  delegate: BOB,
  authority:
    '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as Hex,
  caveats: [],
  salt: '0x01' as Hex,
  chainId: 11155111,
  status: 'signed' as const,
};

function makeTransferNativeGrant(opts?: {
  to?: Address;
  maxAmount?: bigint;
}): TransferNativeGrant {
  return {
    method: 'transferNative',
    delegation: BASE_DELEGATION,
    ...(opts?.to !== undefined && { to: opts.to }),
    ...(opts?.maxAmount !== undefined && { maxAmount: opts.maxAmount }),
  };
}

function makeTransferFungibleGrant(opts?: {
  to?: Address;
  totalLimit?: bigint;
}): TransferFungibleGrant {
  return {
    method: 'transferFungible',
    token: TOKEN,
    delegation: BASE_DELEGATION,
    ...(opts?.to !== undefined && { to: opts.to }),
    ...(opts?.totalLimit !== undefined && { totalLimit: opts.totalLimit }),
  };
}

describe('makeDelegationTwin', () => {
  describe('transferNative twin', () => {
    it('exposes transferNative method', () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      const section = makeDelegationTwin({
        grant: makeTransferNativeGrant({ maxAmount: 10000n }),
        redeemFn,
      });
      expect(
        typeof (section.exo as Record<string, unknown>).transferNative,
      ).toBe('function');
    });

    it('builds correct Execution and calls redeemFn', async () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      const section = makeDelegationTwin({
        grant: makeTransferNativeGrant({ maxAmount: 10000n }),
        redeemFn,
      });
      const exo = section.exo as TransferNativeFacet & TransferFungibleFacet;

      const result = await exo.transferNative(BOB, 100n);
      expect(result).toBe(TX_HASH);
      expect(redeemFn).toHaveBeenCalledOnce();

      const execution = redeemFn.mock.calls[0]?.[0] as Execution;
      expect(execution.target).toBe(BOB);
      expect(execution.value).toBe('0x64');
      expect(execution.callData).toBe('0x');
    });

    it('rejects when maxAmount exceeded', async () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      const section = makeDelegationTwin({
        grant: makeTransferNativeGrant({ maxAmount: 100n }),
        redeemFn,
      });
      const exo = section.exo as TransferNativeFacet & TransferFungibleFacet;

      await expect(exo.transferNative(BOB, 101n)).rejects.toThrow(
        /exceeds limit/u,
      );
    });
  });

  describe('transferFungible twin', () => {
    it('normalizes checksummed token address to lowercase in section.token', () => {
      const CHECKSUMMED_TOKEN =
        '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as Address;
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      const section = makeDelegationTwin({
        grant: {
          method: 'transferFungible',
          token: CHECKSUMMED_TOKEN,
          delegation: BASE_DELEGATION,
          totalLimit: 1000n,
        },
        redeemFn,
      });
      expect(section).toHaveProperty('token', CHECKSUMMED_TOKEN.toLowerCase());
    });

    it('exposes transferFungible method', () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      const section = makeDelegationTwin({
        grant: makeTransferFungibleGrant({ totalLimit: 10000n }),
        redeemFn,
      });
      expect(
        typeof (section.exo as Record<string, unknown>).transferFungible,
      ).toBe('function');
    });

    it('tracks cumulative spend across calls', async () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      const section = makeDelegationTwin({
        grant: makeTransferFungibleGrant({ totalLimit: 1000n }),
        redeemFn,
      });
      const exo = section.exo as TransferNativeFacet & TransferFungibleFacet;

      await exo.transferFungible(TOKEN, BOB, 600n);
      await exo.transferFungible(TOKEN, BOB, 300n);
      await expect(exo.transferFungible(TOKEN, BOB, 200n)).rejects.toThrow(
        /Insufficient budget/u,
      );
    });

    it('does not commit on redeemFn failure', async () => {
      const redeemFn = vi.fn().mockRejectedValue(new Error('tx reverted'));
      const section = makeDelegationTwin({
        grant: makeTransferFungibleGrant({ totalLimit: 1000n }),
        redeemFn,
      });
      const exo = section.exo as TransferNativeFacet & TransferFungibleFacet;

      await expect(exo.transferFungible(TOKEN, BOB, 500n)).rejects.toThrow(
        'tx reverted',
      );
      redeemFn.mockResolvedValue(TX_HASH);
      const result = await exo.transferFungible(TOKEN, BOB, 1000n);
      expect(result).toBe(TX_HASH);
    });

    it('does not allow concurrent calls to exceed the budget', async () => {
      let resolveFirst!: (hash: Hex) => void;
      const redeemFn = vi
        .fn()
        .mockImplementationOnce(
          async () =>
            new Promise<Hex>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue(TX_HASH);

      const section = makeDelegationTwin({
        grant: makeTransferFungibleGrant({ totalLimit: 5n }),
        redeemFn,
      });
      const exo = section.exo as TransferNativeFacet & TransferFungibleFacet;

      const first = exo.transferFungible(TOKEN, BOB, 3n);
      await expect(exo.transferFungible(TOKEN, BOB, 3n)).rejects.toThrow(
        'Insufficient budget',
      );
      resolveFirst(TX_HASH);
      expect(await first).toBe(TX_HASH);
    });

    it('has no maxAmount limit when not specified', async () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      const section = makeDelegationTwin({
        grant: makeTransferFungibleGrant(),
        redeemFn,
      });
      const exo = section.exo as TransferNativeFacet & TransferFungibleFacet;

      // Very large amount — should succeed (no cap enforced locally)
      await exo.transferFungible(TOKEN, BOB, 10n ** 30n);
      expect(redeemFn).toHaveBeenCalledOnce();
    });
  });

  describe('discoverability', () => {
    it('returns method schemas from __getDescription__ for transferNative', () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      const section = makeDelegationTwin({
        grant: makeTransferNativeGrant({ maxAmount: 1000n }),
        redeemFn,
      });
      const exo = section.exo as Record<string, unknown>;

      const desc = (exo.__getDescription__ as () => Record<string, unknown>)();
      expect(desc).toHaveProperty('transferNative');
      expect(
        (desc.transferNative as Record<string, unknown>).description,
      ).toBeDefined();
    });

    it('returns method schemas from __getDescription__ for transferFungible', () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      const section = makeDelegationTwin({
        grant: makeTransferFungibleGrant({ totalLimit: 1000n }),
        redeemFn,
      });
      const exo = section.exo as Record<string, unknown>;

      const desc = (exo.__getDescription__ as () => Record<string, unknown>)();
      expect(desc).toHaveProperty('transferFungible');
      expect(
        (desc.transferFungible as Record<string, unknown>).description,
      ).toBeDefined();
    });
  });

  describe('interfaceGuard', () => {
    it('passes an InterfaceGuard to makeDiscoverableExo for transferNative', () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      makeDelegationTwin({
        grant: makeTransferNativeGrant({ maxAmount: 1000n }),
        redeemFn,
      });
      expect(lastInterfaceGuard).toBeDefined();
    });

    it('passes an InterfaceGuard to makeDiscoverableExo for transferFungible', () => {
      const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
      makeDelegationTwin({
        grant: makeTransferFungibleGrant({ totalLimit: 1000n }),
        redeemFn,
      });
      expect(lastInterfaceGuard).toBeDefined();
    });
  });

  describe('grant type narrowing', () => {
    it.each([
      ['transferNative', makeTransferNativeGrant(), 'transferNative'] as const,
      [
        'transferFungible',
        makeTransferFungibleGrant(),
        'transferFungible',
      ] as const,
    ])(
      'builds a %s twin exposing the %s method',
      (_label, grant: DelegationGrant, method) => {
        const redeemFn = vi.fn().mockResolvedValue(TX_HASH);
        const section = makeDelegationTwin({ grant, redeemFn });
        expect(typeof (section.exo as Record<string, unknown>)[method]).toBe(
          'function',
        );
      },
    );
  });
});
