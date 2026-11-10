import type { WalletCaller } from './daemon.ts';
import { resolveTokenParam } from './token-resolver.ts';
import type { ToolResponse } from './types.ts';

export const ETH_ADDRESS_RE = /^0x[\da-f]{40}$/iu;
export const HEX_VALUE_RE = /^0x[\da-f]+$/iu;
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

/**
 * Native token symbols for each supported chain.
 * Only the chain's own native token(s) should resolve to the zero address.
 * Polygon accepts both "POL" (current) and "MATIC" (legacy).
 */
export const NATIVE_TOKENS_BY_CHAIN: Record<number, string[]> = {
  1: ['ETH'],
  10: ['ETH'],
  56: ['BNB'],
  137: ['POL', 'MATIC'],
  8453: ['ETH'],
  42161: ['ETH'],
  59144: ['ETH'],
  11155111: ['ETH'],
};

const BLOCK_EXPLORER_URLS: Record<number, string> = {
  1: 'https://etherscan.io',
  10: 'https://optimistic.etherscan.io',
  56: 'https://bscscan.com',
  137: 'https://polygonscan.com',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  59144: 'https://lineascan.build',
  11155111: 'https://sepolia.etherscan.io',
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Format an error response for the plugin.
 *
 * @param text - The error message text.
 * @returns A plugin tool response containing the error.
 */
export function makeError(text: string): ToolResponse {
  return {
    content: [{ type: 'text' as const, text: `Error: ${text}` }],
    details: undefined,
  };
}

/**
 * Format a successful text response.
 *
 * @param text - The response text.
 * @returns A plugin tool response.
 */
export function makeText(text: string): ToolResponse {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

/**
 * Convert a decoded wallet result into text for tool responses.
 *
 * @param value - The decoded result.
 * @returns A string suitable for tool output.
 */
export function formatToolResult(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Extract error message from an unknown error value.
 *
 * @param error - The caught error.
 * @returns The error message string.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Amount parsing
// ---------------------------------------------------------------------------

/**
 * Convert a decimal ETH or token amount to a BigInt raw value.
 *
 * @param amount - Decimal amount string (e.g. "0.08", "100.5").
 * @param decimals - Number of decimal places.
 * @returns The raw BigInt value.
 */
export function parseDecimalAmount(amount: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(amount);
  if (!match) {
    throw new Error(
      'Amount must be a plain decimal string without signs, exponents, or extra punctuation.',
    );
  }

  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(
      `Amount has too many decimal places; this asset supports at most ${String(decimals)}.`,
    );
  }

  const paddedFrac = frac.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFrac || '0');
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a token parameter (address or symbol) using wallet chain context.
 *
 * @param options - Resolution options.
 * @param options.token - Token address or symbol/name.
 * @param options.wallet - Wallet caller for chain ID lookup.
 * @returns The resolved address and metadata.
 */
export async function resolveToken(options: {
  token: string;
  wallet: WalletCaller;
}): Promise<{
  address: string;
  resolved: boolean;
  name?: string;
  symbol?: string;
}> {
  if (ETH_ADDRESS_RE.test(options.token)) {
    return { address: options.token, resolved: false };
  }
  const caps = (await options.wallet('getCapabilities', [], 10_000)) as Record<
    string,
    unknown
  >;
  const chainId = typeof caps?.chainId === 'number' ? caps.chainId : 0;
  if (chainId === 0) {
    throw new Error(
      'Could not determine chain ID. Provide the token contract address directly.',
    );
  }
  return resolveTokenParam({ token: options.token, chainId });
}

// ---------------------------------------------------------------------------
// Transaction result resolution
// ---------------------------------------------------------------------------

type TransactionResult = {
  txHash?: string | undefined;
  userOpHash?: string | undefined;
  explorerUrl: string;
  pendingUserOp: boolean;
};

/**
 * Extract the mined transaction hash from a UserOp receipt result.
 *
 * @param userOpReceipt - The raw receipt response.
 * @returns The mined transaction hash, if present.
 */
function getUserOpTransactionHash(userOpReceipt: unknown): string | undefined {
  if (!userOpReceipt || typeof userOpReceipt !== 'object') {
    return undefined;
  }

  const { receipt } = userOpReceipt as {
    receipt?: { transactionHash?: unknown };
  };
  return typeof receipt?.transactionHash === 'string'
    ? receipt.transactionHash
    : undefined;
}

/**
 * Try to resolve a pending UserOp to its eventual transaction hash.
 *
 * @param options - Resolution options.
 * @param options.hash - The UserOp hash to resolve.
 * @param options.wallet - Wallet caller.
 * @returns Resolution details for the pending UserOp.
 */
async function resolvePendingUserOp(options: {
  hash: string;
  wallet: WalletCaller;
}): Promise<{ txHash?: string; userOpHash: string; pendingUserOp: boolean }> {
  const { hash, wallet } = options;

  try {
    const userOpReceipt = await wallet(
      'waitForUserOpReceipt',
      [{ userOpHash: hash, pollIntervalMs: 3000, timeoutMs: 45000 }],
      50_000,
    );
    const txHash = getUserOpTransactionHash(userOpReceipt);

    if (txHash) {
      return { txHash, userOpHash: hash, pendingUserOp: false };
    }
  } catch (error: unknown) {
    // oxlint-disable-next-line no-console
    console.warn(
      'UserOp receipt resolution failed:',
      error instanceof Error ? error.message : error,
    );
  }

  return { userOpHash: hash, pendingUserOp: true };
}

/**
 * Resolve a transaction hash to an on-chain tx hash with explorer link.
 * Best-effort — returns the raw hash on failure.
 *
 * @param options - Resolution options.
 * @param options.hash - The initial hash (may be a UserOp hash).
 * @param options.wallet - Wallet caller.
 * @returns Resolved transaction details.
 */
export async function resolveTransactionResult(options: {
  hash: string;
  wallet: WalletCaller;
}): Promise<TransactionResult> {
  const { hash, wallet } = options;
  let txHash: string | undefined;
  let userOpHash: string | undefined;
  let explorerUrl = '';
  let pendingUserOp = false;

  try {
    const [caps, receipt] = await Promise.all([
      wallet('getCapabilities', [], 10_000) as Promise<Record<string, unknown>>,
      wallet('getTransactionReceipt', [hash], 30_000) as Promise<Record<
        string,
        unknown
      > | null>,
    ]);

    if (receipt) {
      if (typeof receipt.txHash === 'string') {
        txHash = receipt.txHash;
      }
      if (typeof receipt.userOpHash === 'string') {
        userOpHash = receipt.userOpHash;
      }
    } else {
      const pendingResult = await resolvePendingUserOp({ hash, wallet });
      txHash = pendingResult.txHash;
      userOpHash = pendingResult.userOpHash;
      pendingUserOp = pendingResult.pendingUserOp;
    }

    const chainId = typeof caps?.chainId === 'number' ? caps.chainId : 0;
    const baseUrl = BLOCK_EXPLORER_URLS[chainId] ?? '';
    if (baseUrl && txHash) {
      explorerUrl = `${baseUrl}/tx/${txHash}`;
    }
  } catch (error: unknown) {
    // oxlint-disable-next-line no-console
    console.warn(
      'Transaction result resolution failed:',
      error instanceof Error ? error.message : error,
    );
  }

  if (!txHash && !userOpHash) {
    txHash = hash;
  }

  return { txHash, userOpHash, explorerUrl, pendingUserOp };
}

/**
 * Format a transaction result into lines of text.
 *
 * @param result - The resolved transaction result.
 * @param result.txHash - The transaction hash, when known.
 * @param result.userOpHash - The UserOp hash, if applicable.
 * @param result.explorerUrl - Block explorer URL.
 * @param result.pendingUserOp - Whether the UserOp is still pending resolution.
 * @param prefix - Optional prefix line (e.g. "Sent 100 USDC to 0x...").
 * @returns Formatted text.
 */
export function formatTxResult(
  result: {
    txHash?: string | undefined;
    userOpHash?: string | undefined;
    explorerUrl: string;
    pendingUserOp: boolean;
  },
  prefix?: string,
): string {
  const parts: string[] = [];
  if (prefix) {
    parts.push(prefix);
  }
  if (result.txHash) {
    parts.push(`Transaction hash: ${result.txHash}`);
  }
  if (result.explorerUrl) {
    parts.push(`Explorer: ${result.explorerUrl}`);
  }
  if (result.userOpHash) {
    parts.push(`UserOp hash: ${result.userOpHash}`);
  }
  if (result.pendingUserOp) {
    parts.push('Waiting for on-chain transaction hash.');
  }
  return parts.length > 0 ? parts.join('\n') : 'Transaction submitted.';
}
