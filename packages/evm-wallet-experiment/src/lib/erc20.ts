import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbiParameters,
} from 'viem';

import type { Address, Execution, Hex } from '../types.ts';

const harden = globalThis.harden ?? (<T>(value: T): T => value);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Byte offset of the first argument in ABI-encoded calldata (after the 4-byte selector).
 */
export const FIRST_ARG_OFFSET = 4;

/**
 * Function selector for ERC-20 `transfer(address,uint256)`.
 */
export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb' as Hex;

/**
 * Function selector for ERC-20 `approve(address,uint256)`.
 */
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3' as Hex;

/**
 * Function selector for ERC-20 `allowance(address,address)`.
 */
export const ERC20_ALLOWANCE_SELECTOR = '0xdd62ed3e' as Hex;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encode calldata for ERC-20 `transfer(address,uint256)`.
 *
 * @param to - The recipient address.
 * @param amount - The token amount to transfer.
 * @returns The ABI-encoded calldata.
 */
export function encodeTransfer(to: Address, amount: bigint): Hex {
  const params = encodeAbiParameters(parseAbiParameters('address, uint256'), [
    to,
    amount,
  ]);
  return `${ERC20_TRANSFER_SELECTOR}${params.slice(2)}` as Hex;
}

/**
 * Encode calldata for ERC-20 `approve(address,uint256)`.
 *
 * @param spender - The spender address.
 * @param amount - The allowance amount.
 * @returns The ABI-encoded calldata.
 */
export function encodeApprove(spender: Address, amount: bigint): Hex {
  const params = encodeAbiParameters(parseAbiParameters('address, uint256'), [
    spender,
    amount,
  ]);
  return `${ERC20_APPROVE_SELECTOR}${params.slice(2)}` as Hex;
}

/**
 * Encode calldata for ERC-20 `allowance(address,address)`.
 *
 * @param owner - The token owner address.
 * @param spender - The spender address.
 * @returns The ABI-encoded calldata.
 */
export function encodeAllowance(owner: Address, spender: Address): Hex {
  const params = encodeAbiParameters(parseAbiParameters('address, address'), [
    owner,
    spender,
  ]);
  return `${ERC20_ALLOWANCE_SELECTOR}${params.slice(2)}` as Hex;
}

/**
 * Encode calldata for ERC-20 `balanceOf(address)`.
 *
 * @param owner - The account address.
 * @returns The ABI-encoded calldata.
 */
export function encodeBalanceOf(owner: Address): Hex {
  const selector = '0x70a08231' as Hex;
  const params = encodeAbiParameters(parseAbiParameters('address'), [owner]);
  return `${selector}${params.slice(2)}` as Hex;
}

/**
 * Encode calldata for ERC-20 `decimals()`.
 *
 * @returns The ABI-encoded calldata (just the selector).
 */
export function encodeDecimals(): Hex {
  return '0x313ce567' as Hex;
}

/**
 * Encode calldata for ERC-20 `symbol()`.
 *
 * @returns The ABI-encoded calldata (just the selector).
 */
export function encodeSymbol(): Hex {
  return '0x95d89b41' as Hex;
}

/**
 * Encode calldata for ERC-20 `name()`.
 *
 * @returns The ABI-encoded calldata (just the selector).
 */
export function encodeName(): Hex {
  return '0x06fdde03' as Hex;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode calldata from an ERC-20 `transfer(address,uint256)` call.
 *
 * @param data - The full calldata (selector + params).
 * @returns The decoded recipient and amount.
 */
export function decodeTransferCalldata(data: Hex): {
  to: Address;
  amount: bigint;
} {
  const selector = data.slice(0, 10).toLowerCase();
  if (selector !== ERC20_TRANSFER_SELECTOR) {
    throw new Error(
      `Expected transfer selector ${ERC20_TRANSFER_SELECTOR}, got ${selector}`,
    );
  }
  const params = `0x${data.slice(10)}` as const;
  const [to, amount] = decodeAbiParameters(
    parseAbiParameters('address, uint256'),
    params,
  );
  return { to, amount };
}

/**
 * Check if calldata is an ERC-20 `transfer(address,uint256)` call.
 *
 * @param data - The calldata to check.
 * @returns True if the selector matches `transfer(address,uint256)`.
 */
export function isErc20TransferCalldata(data: Hex): boolean {
  return (
    data.length >= 10 &&
    data.slice(0, 10).toLowerCase() === ERC20_TRANSFER_SELECTOR
  );
}

/**
 * Assert that an ABI-encoded result is non-empty.
 *
 * @param result - The hex result to check.
 * @param method - The ERC-20 method name (for error messages).
 */
function assertNonEmptyResult(result: Hex, method: string): void {
  if (result === '0x' || result.length < 66) {
    throw new Error(
      `${method}() returned empty or too-short response: ${result}`,
    );
  }
}

/**
 * Decode an ABI-encoded string, falling back to bytes32 for non-standard
 * tokens (e.g. MKR, SAI) that return raw bytes32 instead of a dynamic string.
 *
 * @param result - The hex result to decode.
 * @returns The decoded string.
 */
function decodeStringOrBytes32(result: Hex): string {
  try {
    const [value] = decodeAbiParameters(parseAbiParameters('string'), result);
    return value;
  } catch {
    // Fallback: some tokens return bytes32 instead of string
    const [raw] = decodeAbiParameters(parseAbiParameters('bytes32'), result);
    // raw is a 0x-prefixed hex string; convert to UTF-8 and trim null bytes
    const rawHex = String(raw).slice(2);
    const chars: number[] = [];
    for (let i = 0; i < rawHex.length; i += 2) {
      const byte = parseInt(rawHex.slice(i, i + 2), 16);
      if (byte === 0) {
        break;
      }
      chars.push(byte);
    }
    return String.fromCharCode(...chars);
  }
}

/**
 * Decode an `allowance` return value.
 *
 * @param result - The raw ABI-encoded result from `eth_call`.
 * @returns The allowance as a bigint.
 */
export function decodeAllowanceResult(result: Hex): bigint {
  assertNonEmptyResult(result, 'allowance');
  const [allowance] = decodeAbiParameters(
    parseAbiParameters('uint256'),
    result,
  );
  return allowance;
}

/**
 * Decode a `balanceOf` return value.
 *
 * @param result - The raw ABI-encoded result from `eth_call`.
 * @returns The balance as a bigint.
 */
export function decodeBalanceOfResult(result: Hex): bigint {
  assertNonEmptyResult(result, 'balanceOf');
  const [balance] = decodeAbiParameters(parseAbiParameters('uint256'), result);
  return balance;
}

/**
 * Decode a `decimals` return value.
 *
 * @param result - The raw ABI-encoded result from `eth_call`.
 * @returns The number of decimals.
 */
export function decodeDecimalsResult(result: Hex): number {
  assertNonEmptyResult(result, 'decimals');
  const [decimals] = decodeAbiParameters(parseAbiParameters('uint8'), result);
  return Number(decimals);
}

/**
 * Decode a `symbol` return value.
 * Handles both standard ABI-encoded string returns and non-standard
 * bytes32 returns (used by tokens like MKR, SAI).
 *
 * @param result - The raw ABI-encoded result from `eth_call`.
 * @returns The token symbol.
 */
export function decodeSymbolResult(result: Hex): string {
  assertNonEmptyResult(result, 'symbol');
  return decodeStringOrBytes32(result);
}

/**
 * Decode a `name` return value.
 * Handles both standard ABI-encoded string returns and non-standard
 * bytes32 returns (used by tokens like MKR, SAI).
 *
 * @param result - The raw ABI-encoded result from `eth_call`.
 * @returns The token name.
 */
export function decodeNameResult(result: Hex): string {
  assertNonEmptyResult(result, 'name');
  return decodeStringOrBytes32(result);
}

// ---------------------------------------------------------------------------
// Execution builder
// ---------------------------------------------------------------------------

/**
 * Build an `Execution` struct for an ERC-20 token transfer,
 * ready to pass to `redeemDelegation`.
 *
 * @param options - Transfer options.
 * @param options.token - The ERC-20 token contract address.
 * @param options.to - The recipient address.
 * @param options.amount - The token amount to transfer.
 * @returns An Execution struct targeting the token contract.
 */
export function makeErc20TransferExecution(options: {
  token: Address;
  to: Address;
  amount: bigint;
}): Execution {
  return harden({
    target: options.token,
    value: '0x0' as Hex,
    callData: encodeTransfer(options.to, options.amount),
  });
}
