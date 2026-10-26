import type { WalletCaller } from '../daemon.ts';
import type { OpenClawPluginApi, ToolResponse } from '../types.ts';
import {
  NATIVE_ETH,
  NATIVE_TOKENS_BY_CHAIN,
  errorMessage,
  formatTxResult,
  makeError,
  makeText,
  parseDecimalAmount,
  resolveToken,
  resolveTransactionResult,
} from '../utils.ts';

/**
 * Resolve a swap token parameter to an address, decimals, and symbol.
 * Handles native tokens as a special case, checking against the chain's
 * native token to avoid resolving e.g. "BNB" as native on Ethereum.
 *
 * @param token - Token address or symbol.
 * @param wallet - Wallet caller function.
 * @param chainId - Current chain ID for native token resolution.
 * @returns The resolved token details, or an error object.
 */
async function resolveSwapToken(
  token: string,
  wallet: WalletCaller,
  chainId: number,
): Promise<
  { address: string; decimals: number; symbol: string } | { error: string }
> {
  const nativeSymbols = NATIVE_TOKENS_BY_CHAIN[chainId] ?? ['ETH'];
  const primaryNative = nativeSymbols[0] ?? 'ETH';
  if (token === NATIVE_ETH || nativeSymbols.includes(token.toUpperCase())) {
    return { address: NATIVE_ETH, decimals: 18, symbol: primaryNative };
  }

  let resolved: { address: string; symbol?: string };
  try {
    resolved = await resolveToken({ token, wallet });
  } catch (error: unknown) {
    return { error: errorMessage(error) };
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = (await wallet('getTokenMetadata', [
      { token: resolved.address },
    ])) as Record<string, unknown>;
  } catch (error: unknown) {
    return {
      error: `Could not fetch metadata for ${token}: ${errorMessage(error)}`,
    };
  }

  if (typeof metadata?.decimals !== 'number') {
    return { error: `Could not determine decimals for ${token}.` };
  }

  return {
    address: resolved.address,
    decimals: metadata.decimals,
    symbol: typeof metadata?.symbol === 'string' ? metadata.symbol : token,
  };
}

/**
 * Register token swap tools: quote and execute.
 *
 * @param api - The OpenClaw plugin API.
 * @param wallet - Wallet caller function.
 */
export function registerSwapTools(
  api: OpenClawPluginApi,
  wallet: WalletCaller,
): void {
  // -- wallet_swap_quote ----------------------------------------------------

  api.registerTool({
    name: 'wallet_swap_quote',
    label: 'Swap quote',
    description:
      'Get a token swap quote without executing. Shows expected output amount, aggregator, and gas estimate. Accepts contract addresses or token symbols (e.g. "USDC", "ETH").',
    parameters: {
      type: 'object',
      properties: {
        srcToken: {
          type: 'string',
          description:
            'Source token address (0x...) or symbol (e.g. "USDC", "ETH")',
        },
        destToken: {
          type: 'string',
          description:
            'Destination token address (0x...) or symbol (e.g. "WETH", "DAI")',
        },
        amount: {
          type: 'string',
          description:
            'Amount of source token as a decimal string (e.g. "100.5")',
        },
        slippage: {
          type: 'number',
          description: 'Slippage tolerance % (default: 1)',
        },
      },
      required: ['srcToken', 'destToken', 'amount'],
    },
    async execute(
      _id: string,
      params: {
        srcToken: string;
        destToken: string;
        amount: string;
        slippage?: number;
      },
    ): Promise<ToolResponse> {
      const slippage = params.slippage ?? 1;
      if (slippage < 0.1 || slippage > 50) {
        return makeError('Slippage must be between 0.1% and 50%.');
      }

      try {
        const caps = (await wallet('getCapabilities', [], 10_000)) as Record<
          string,
          unknown
        >;
        const chainId = typeof caps?.chainId === 'number' ? caps.chainId : 0;
        if (chainId === 0) {
          return makeError(
            'Could not determine chain ID. Configure the provider before swapping.',
          );
        }

        const src = await resolveSwapToken(params.srcToken, wallet, chainId);
        if ('error' in src) {
          return makeError(src.error);
        }

        const dest = await resolveSwapToken(params.destToken, wallet, chainId);
        if ('error' in dest) {
          return makeError(dest.error);
        }

        const rawAmount = parseDecimalAmount(params.amount, src.decimals);
        if (rawAmount <= 0n) {
          return makeError('Amount must be greater than zero.');
        }

        const quote = (await wallet('getSwapQuote', [
          {
            srcToken: src.address,
            destToken: dest.address,
            srcAmount: `0x${rawAmount.toString(16)}`,
            slippage,
          },
        ])) as Record<string, unknown>;

        // Extract typed fields from the quote response
        const qDestAmount =
          typeof quote.destinationAmount === 'string'
            ? quote.destinationAmount
            : '0';
        const qAggregator =
          typeof quote.aggregator === 'string' ? quote.aggregator : 'unknown';
        const qGasEstimate =
          typeof quote.gasEstimate === 'string' ? quote.gasEstimate : 'unknown';
        const qRefreshSeconds =
          typeof quote.quoteRefreshSeconds === 'number'
            ? String(quote.quoteRefreshSeconds)
            : '?';

        // Format output amount
        const destRaw = BigInt(qDestAmount);
        const destWhole = destRaw / 10n ** BigInt(dest.decimals);
        const destFrac = destRaw % 10n ** BigInt(dest.decimals);
        const destFracStr = destFrac
          .toString()
          .padStart(dest.decimals, '0')
          .replace(/0+$/u, '');
        const destFormatted = destFracStr
          ? `${String(destWhole)}.${destFracStr}`
          : String(destWhole);

        const lines = [
          `Swap ${params.amount} ${src.symbol} -> ${destFormatted} ${dest.symbol}`,
          `Aggregator: ${qAggregator}`,
          `Gas estimate: ${qGasEstimate}`,
          `Slippage: ${String(slippage)}%`,
          `Quote valid for: ${qRefreshSeconds}s`,
        ];
        if (quote.approvalNeeded) {
          lines.push('Token approval required before swap.');
        }

        return makeText(lines.join('\n'));
      } catch (error: unknown) {
        return makeError(`Swap quote failed: ${errorMessage(error)}`);
      }
    },
  });

  // -- wallet_swap ----------------------------------------------------------

  api.registerTool({
    name: 'wallet_swap',
    label: 'Swap tokens',
    description:
      'Execute a token swap. Handles approval and swap in sequence. Accepts contract addresses or token symbols (e.g. "USDC", "ETH").',
    parameters: {
      type: 'object',
      properties: {
        srcToken: {
          type: 'string',
          description:
            'Source token address (0x...) or symbol (e.g. "USDC", "ETH")',
        },
        destToken: {
          type: 'string',
          description:
            'Destination token address (0x...) or symbol (e.g. "WETH", "DAI")',
        },
        amount: {
          type: 'string',
          description:
            'Amount of source token as a decimal string (e.g. "100.5")',
        },
        slippage: {
          type: 'number',
          description: 'Slippage tolerance % (default: 1)',
        },
      },
      required: ['srcToken', 'destToken', 'amount'],
    },
    async execute(
      _id: string,
      params: {
        srcToken: string;
        destToken: string;
        amount: string;
        slippage?: number;
      },
    ): Promise<ToolResponse> {
      const slippage = params.slippage ?? 1;
      if (slippage < 0.1 || slippage > 50) {
        return makeError('Slippage must be between 0.1% and 50%.');
      }

      try {
        const caps = (await wallet('getCapabilities', [], 10_000)) as Record<
          string,
          unknown
        >;
        const chainId = typeof caps?.chainId === 'number' ? caps.chainId : 0;
        if (chainId === 0) {
          return makeError(
            'Could not determine chain ID. Configure the provider before swapping.',
          );
        }

        const src = await resolveSwapToken(params.srcToken, wallet, chainId);
        if ('error' in src) {
          return makeError(src.error);
        }

        const dest = await resolveSwapToken(params.destToken, wallet, chainId);
        if ('error' in dest) {
          return makeError(dest.error);
        }

        const rawAmount = parseDecimalAmount(params.amount, src.decimals);
        if (rawAmount <= 0n) {
          return makeError('Amount must be greater than zero.');
        }

        const result = (await wallet('swapTokens', [
          {
            srcToken: src.address,
            destToken: dest.address,
            srcAmount: `0x${rawAmount.toString(16)}`,
            slippage,
          },
        ])) as Record<string, unknown>;

        const rAggregator =
          typeof result.aggregator === 'string' ? result.aggregator : 'unknown';

        const parts: string[] = [
          `Swapped ${params.amount} ${src.symbol} for ${dest.symbol} via ${rAggregator}`,
        ];

        if (typeof result.approvalTxHash === 'string') {
          const approvalResult = await resolveTransactionResult({
            hash: result.approvalTxHash,
            wallet,
          });
          parts.push(formatTxResult(approvalResult, 'Approval transaction:'));
        }

        if (typeof result.swapTxHash === 'string') {
          const swapResult = await resolveTransactionResult({
            hash: result.swapTxHash,
            wallet,
          });
          parts.push(formatTxResult(swapResult, 'Swap transaction:'));
        }

        return makeText(parts.join('\n'));
      } catch (error: unknown) {
        return makeError(`Swap failed: ${errorMessage(error)}`);
      }
    },
  });
}
