import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Address, Hex } from '../types.ts';
import {
  ERC20_ALLOWANCE_SELECTOR,
  ERC20_APPROVE_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  decodeAllowanceResult,
  decodeBalanceOfResult,
  decodeDecimalsResult,
  decodeNameResult,
  decodeSymbolResult,
  decodeTransferCalldata,
  encodeAllowance,
  encodeApprove,
  encodeBalanceOf,
  encodeDecimals,
  encodeName,
  encodeSymbol,
  encodeTransfer,
  isErc20TransferCalldata,
  makeErc20TransferExecution,
} from './erc20.ts';

const ALICE = '0x1111111111111111111111111111111111111111' as Address;
const BOB = '0x2222222222222222222222222222222222222222' as Address;
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;

describe('erc20', () => {
  describe('encodeTransfer', () => {
    it('produces calldata with the transfer selector', () => {
      const data = encodeTransfer(ALICE, 1000n);
      expect(data.slice(0, 10).toLowerCase()).toBe(ERC20_TRANSFER_SELECTOR);
    });

    it('encodes zero amount', () => {
      const data = encodeTransfer(ALICE, 0n);
      expect(data.slice(0, 10).toLowerCase()).toBe(ERC20_TRANSFER_SELECTOR);
      const decoded = decodeTransferCalldata(data);
      expect(decoded.amount).toBe(0n);
    });

    it('encodes max uint256', () => {
      const maxUint256 = 2n ** 256n - 1n;
      const data = encodeTransfer(ALICE, maxUint256);
      const decoded = decodeTransferCalldata(data);
      expect(decoded.amount).toBe(maxUint256);
    });
  });

  describe('encodeApprove', () => {
    it('produces calldata with the approve selector', () => {
      const data = encodeApprove(ALICE, 500n);
      expect(data.slice(0, 10).toLowerCase()).toBe(ERC20_APPROVE_SELECTOR);
    });

    it('encodes the correct spender and amount', () => {
      const data = encodeApprove(BOB, 42000n);
      // Decode the params portion (skip 4-byte selector)
      const params = `0x${data.slice(10)}` as const;
      const [spender, amount] = decodeAbiParameters(
        parseAbiParameters('address, uint256'),
        params,
      );
      expect((spender as string).toLowerCase()).toBe(BOB.toLowerCase());
      expect(amount).toBe(42000n);
    });
  });

  describe('encodeBalanceOf', () => {
    it('produces calldata with the balanceOf selector', () => {
      const data = encodeBalanceOf(ALICE);
      expect(data.slice(0, 10).toLowerCase()).toBe('0x70a08231');
    });
  });

  describe('encodeDecimals', () => {
    it('returns the decimals selector', () => {
      expect(encodeDecimals()).toBe('0x313ce567');
    });
  });

  describe('encodeSymbol', () => {
    it('returns the symbol selector', () => {
      expect(encodeSymbol()).toBe('0x95d89b41');
    });
  });

  describe('encodeName', () => {
    it('returns the name selector', () => {
      expect(encodeName()).toBe('0x06fdde03');
    });
  });

  describe('decodeTransferCalldata', () => {
    it('round-trips with encodeTransfer', () => {
      const data = encodeTransfer(BOB, 42000n);
      const decoded = decodeTransferCalldata(data);
      expect(decoded.to.toLowerCase()).toBe(BOB.toLowerCase());
      expect(decoded.amount).toBe(42000n);
    });

    it('throws for non-transfer selector', () => {
      const approveData = encodeApprove(ALICE, 100n);
      expect(() => decodeTransferCalldata(approveData)).toThrow(
        /Expected transfer selector/u,
      );
    });

    it('throws for short calldata', () => {
      expect(() => decodeTransferCalldata('0xa9059cbb' as Hex)).toThrow(
        /ABI/iu,
      );
    });
  });

  describe('isErc20TransferCalldata', () => {
    it('returns true for transfer calldata', () => {
      const data = encodeTransfer(ALICE, 100n);
      expect(isErc20TransferCalldata(data)).toBe(true);
    });

    it('returns false for approve calldata', () => {
      const data = encodeApprove(ALICE, 100n);
      expect(isErc20TransferCalldata(data)).toBe(false);
    });

    it('returns false for short data', () => {
      expect(isErc20TransferCalldata('0x1234' as Hex)).toBe(false);
    });

    it('returns false for empty data', () => {
      expect(isErc20TransferCalldata('0x' as Hex)).toBe(false);
    });
  });

  describe('decodeBalanceOfResult', () => {
    it('decodes zero balance', () => {
      const result =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;
      expect(decodeBalanceOfResult(result)).toBe(0n);
    });

    it('decodes non-zero balance', () => {
      // 1000000 = 0xF4240
      const result =
        '0x00000000000000000000000000000000000000000000000000000000000f4240' as Hex;
      expect(decodeBalanceOfResult(result)).toBe(1000000n);
    });

    it('throws for empty response', () => {
      expect(() => decodeBalanceOfResult('0x' as Hex)).toThrow(
        /balanceOf\(\) returned empty/u,
      );
    });
  });

  describe('decodeDecimalsResult', () => {
    it('decodes 18 decimals', () => {
      const result =
        '0x0000000000000000000000000000000000000000000000000000000000000012' as Hex;
      expect(decodeDecimalsResult(result)).toBe(18);
    });

    it('decodes 6 decimals', () => {
      const result =
        '0x0000000000000000000000000000000000000000000000000000000000000006' as Hex;
      expect(decodeDecimalsResult(result)).toBe(6);
    });
  });

  describe('decodeSymbolResult', () => {
    it('decodes a standard ABI-encoded string', () => {
      // ABI-encoded string "USDC"
      const result = [
        '0x',
        '0000000000000000000000000000000000000000000000000000000000000020', // offset
        '0000000000000000000000000000000000000000000000000000000000000004', // length 4
        '5553444300000000000000000000000000000000000000000000000000000000', // "USDC"
      ].join('') as Hex;
      expect(decodeSymbolResult(result)).toBe('USDC');
    });

    it('decodes a bytes32 return (non-standard tokens like MKR)', () => {
      // MKR returns bytes32: "MKR\0\0..."
      const result =
        '0x4d4b520000000000000000000000000000000000000000000000000000000000' as Hex;
      expect(decodeSymbolResult(result)).toBe('MKR');
    });

    it('throws for empty response', () => {
      expect(() => decodeSymbolResult('0x' as Hex)).toThrow(
        /symbol\(\) returned empty/u,
      );
    });
  });

  describe('decodeNameResult', () => {
    it('decodes a standard ABI-encoded string', () => {
      // ABI-encoded string "USD Coin"
      const result = [
        '0x',
        '0000000000000000000000000000000000000000000000000000000000000020', // offset
        '0000000000000000000000000000000000000000000000000000000000000008', // length 8
        '55534420436f696e000000000000000000000000000000000000000000000000', // "USD Coin"
      ].join('') as Hex;
      expect(decodeNameResult(result)).toBe('USD Coin');
    });

    it('decodes a bytes32 return (non-standard tokens like MKR)', () => {
      // "Maker" as bytes32
      const result =
        '0x4d616b6572000000000000000000000000000000000000000000000000000000' as Hex;
      expect(decodeNameResult(result)).toBe('Maker');
    });

    it('throws for empty response', () => {
      expect(() => decodeNameResult('0x' as Hex)).toThrow(
        /name\(\) returned empty/u,
      );
    });
  });

  describe('encodeAllowance', () => {
    it('produces calldata with the allowance selector', () => {
      const data = encodeAllowance(ALICE, BOB);
      expect(data.slice(0, 10).toLowerCase()).toBe(ERC20_ALLOWANCE_SELECTOR);
    });

    it('encodes the correct owner and spender', () => {
      const data = encodeAllowance(ALICE, BOB);
      const params = `0x${data.slice(10)}` as const;
      const [owner, spender] = decodeAbiParameters(
        parseAbiParameters('address, address'),
        params,
      );
      expect((owner as string).toLowerCase()).toBe(ALICE.toLowerCase());
      expect((spender as string).toLowerCase()).toBe(BOB.toLowerCase());
    });
  });

  describe('decodeAllowanceResult', () => {
    it('decodes zero allowance', () => {
      const result =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;
      expect(decodeAllowanceResult(result)).toBe(0n);
    });

    it('decodes non-zero allowance', () => {
      const result =
        '0x00000000000000000000000000000000000000000000000000000000000f4240' as Hex;
      expect(decodeAllowanceResult(result)).toBe(1000000n);
    });

    it('decodes max uint256 (unlimited approval)', () => {
      const result =
        '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as Hex;
      expect(decodeAllowanceResult(result)).toBe(2n ** 256n - 1n);
    });

    it('throws for empty response', () => {
      expect(() => decodeAllowanceResult('0x' as Hex)).toThrow(
        /allowance\(\) returned empty/u,
      );
    });
  });

  describe('makeErc20TransferExecution', () => {
    it('builds a correct Execution struct', () => {
      const execution = makeErc20TransferExecution({
        token: TOKEN,
        to: BOB,
        amount: 5000n,
      });
      expect(execution).toStrictEqual({
        target: TOKEN,
        value: '0x0',
        callData: encodeTransfer(BOB, 5000n),
      });
    });

    it('produces calldata that decodes correctly', () => {
      const execution = makeErc20TransferExecution({
        token: TOKEN,
        to: ALICE,
        amount: 999n,
      });
      const decoded = decodeTransferCalldata(execution.callData);
      expect(decoded.to.toLowerCase()).toBe(ALICE.toLowerCase());
      expect(decoded.amount).toBe(999n);
    });
  });
});
