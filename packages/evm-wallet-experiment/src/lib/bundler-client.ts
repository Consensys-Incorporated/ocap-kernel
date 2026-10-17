/**
 * Bundler client using raw fetch for ERC-4337 interactions.
 *
 * @module lib/bundler-client
 */

import type { Address, Hex } from '../types.ts';

const harden = globalThis.harden ?? (<T>(value: T): T => value);

/**
 * Configuration for the bundler client.
 */
export type BundlerClientConfig = {
  bundlerUrl: string;
  rpcUrl?: string;
  chainId: number;
  apiKey?: string;
};

/**
 * Result from a paymaster sponsorship request.
 */
export type PaymasterSponsorResult = {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
};

/**
 * UserOperation type for ERC-4337 v0.7 (simplified for bundler RPC).
 */
type UserOp07 = Record<string, unknown>;

/**
 * Receipt returned by the bundler for a submitted UserOperation.
 */
export type UserOpReceiptResult = {
  receipt: { transactionHash: Hex; blockNumber: Hex; status: Hex };
  success: boolean;
  userOpHash: Hex;
};

/**
 * Gas price recommendation from the bundler (e.g. Pimlico).
 */
export type GasPriceResult = {
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
};

/**
 * A bundler client with ERC-4337 capabilities.
 */
export type ViemBundlerClient = {
  sendUserOperation: (options: {
    userOp: UserOp07;
    entryPointAddress: Address;
  }) => Promise<Hex>;
  estimateUserOperationGas: (options: {
    userOp: Partial<UserOp07>;
    entryPointAddress: Address;
  }) => Promise<{
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
  }>;
  sponsorUserOperation: (options: {
    userOp: Partial<UserOp07>;
    entryPointAddress: Address;
    context?: Record<string, unknown>;
  }) => Promise<PaymasterSponsorResult>;
  getUserOperationGasPrice: () => Promise<{
    slow: GasPriceResult;
    standard: GasPriceResult;
    fast: GasPriceResult;
  }>;
  getUserOperationReceipt: (hash: Hex) => Promise<UserOpReceiptResult | null>;
  waitForUserOperationReceipt: (options: {
    hash: Hex;
    pollingInterval?: number;
    timeout?: number;
  }) => Promise<UserOpReceiptResult>;
};

const BUNDLER_MAX_RETRIES = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

const hasTimers = typeof globalThis.setTimeout === 'function';

/**
 * Send a JSON-RPC request to the bundler with retries.
 *
 * @param options - Options.
 * @param options.fetchFn - The `fetch` to send it with.
 * @param options.bundlerUrl - The bundler RPC URL.
 * @param options.method - The JSON-RPC method.
 * @param options.params - The method parameters.
 * @param options.counter - Monotonic counter for JSON-RPC request IDs.
 * @param options.counter.value - The current count, incremented on each call.
 * @returns The JSON-RPC result.
 */
async function bundlerRpc({
  fetchFn,
  bundlerUrl,
  method,
  params,
  counter,
}: {
  fetchFn: typeof fetch;
  bundlerUrl: string;
  method: string;
  params: unknown[];
  counter: { value: number };
}): Promise<unknown> {
  counter.value += 1;
  const id = counter.value;

  if (!hasTimers) {
    return bundlerRpcOnce({ fetchFn, bundlerUrl, id, method, params });
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= BUNDLER_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 500 * 2 ** (attempt - 1)),
      );
    }
    try {
      return await bundlerRpcOnce({ fetchFn, bundlerUrl, id, method, params });
    } catch (error: unknown) {
      const { status } = error as { status?: number };
      if (status && RETRYABLE_STATUS_CODES.has(status)) {
        lastError = error as Error;
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error('Bundler RPC failed after retries');
}

/**
 * Send a single JSON-RPC request to the bundler (no retries).
 *
 * @param options - Options.
 * @param options.fetchFn - The `fetch` to send it with.
 * @param options.bundlerUrl - The bundler RPC URL.
 * @param options.id - The JSON-RPC request ID.
 * @param options.method - The JSON-RPC method.
 * @param options.params - The method parameters.
 * @returns The JSON-RPC result.
 */
async function bundlerRpcOnce({
  fetchFn,
  bundlerUrl,
  id,
  method,
  params,
}: {
  fetchFn: typeof fetch;
  bundlerUrl: string;
  id: number;
  method: string;
  params: unknown[];
}): Promise<unknown> {
  const response = await fetchFn(bundlerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  if (!response.ok) {
    const error = new Error(
      `Bundler RPC failed: ${response.status} ${response.statusText}`,
    );
    Object.assign(error, { status: response.status });
    throw error;
  }

  const json = (await response.json()) as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };

  if (json.error) {
    const detail = json.error.data
      ? ` (${JSON.stringify(json.error.data)})`
      : '';
    throw new Error(
      `Bundler RPC error ${json.error.code}: ${json.error.message}${detail}`,
    );
  }

  return json.result;
}

/**
 * Create a bundler client for ERC-4337 operations.
 *
 * @param config - Bundler configuration.
 * @param fetchFn - The `fetch` to send requests with.
 * @returns A bundler client with ERC-4337 actions.
 */
export function makeBundlerClient(
  config: BundlerClientConfig,
  fetchFn: typeof fetch,
): ViemBundlerClient {
  const bundlerUrl = config.apiKey
    ? `${config.bundlerUrl}?apikey=${config.apiKey}`
    : config.bundlerUrl;

  // Monotonic counter for JSON-RPC request IDs, scoped to this client instance.
  const requestCounter = { value: 0 };
  const call = async (method: string, params: unknown[]): Promise<unknown> =>
    bundlerRpc({
      fetchFn,
      bundlerUrl,
      method,
      params,
      counter: requestCounter,
    });

  return harden({
    async sendUserOperation(options: {
      userOp: UserOp07;
      entryPointAddress: Address;
    }): Promise<Hex> {
      return (await call('eth_sendUserOperation', [
        options.userOp,
        options.entryPointAddress,
      ])) as Hex;
    },

    async estimateUserOperationGas(options: {
      userOp: Partial<UserOp07>;
      entryPointAddress: Address;
    }): Promise<{
      callGasLimit: bigint;
      verificationGasLimit: bigint;
      preVerificationGas: bigint;
    }> {
      const result = (await call('eth_estimateUserOperationGas', [
        options.userOp,
        options.entryPointAddress,
      ])) as {
        callGasLimit: Hex;
        verificationGasLimit: Hex;
        preVerificationGas: Hex;
      };
      return {
        callGasLimit: BigInt(result.callGasLimit),
        verificationGasLimit: BigInt(result.verificationGasLimit),
        preVerificationGas: BigInt(result.preVerificationGas),
      };
    },

    async sponsorUserOperation(options: {
      userOp: Partial<UserOp07>;
      entryPointAddress: Address;
      context?: Record<string, unknown>;
    }): Promise<PaymasterSponsorResult> {
      return (await call('pm_sponsorUserOperation', [
        options.userOp,
        options.entryPointAddress,
        options.context ?? {},
      ])) as PaymasterSponsorResult;
    },

    async getUserOperationGasPrice(): Promise<{
      slow: GasPriceResult;
      standard: GasPriceResult;
      fast: GasPriceResult;
    }> {
      return (await call('pimlico_getUserOperationGasPrice', [])) as {
        slow: GasPriceResult;
        standard: GasPriceResult;
        fast: GasPriceResult;
      };
    },

    async getUserOperationReceipt(
      hash: Hex,
    ): Promise<UserOpReceiptResult | null> {
      const result = (await call('eth_getUserOperationReceipt', [hash])) as
        | UserOpReceiptResult
        | undefined;
      return result ?? null;
    },

    async waitForUserOperationReceipt(options: {
      hash: Hex;
      pollingInterval?: number;
      timeout?: number;
    }): Promise<UserOpReceiptResult> {
      if (!hasTimers) {
        throw new Error(
          'waitForUserOperationReceipt requires timer support ' +
            "(add 'setTimeout' and 'Date' to this vat's globals in cluster-config.ts)",
        );
      }
      const { pollingInterval = 2000, timeout = 60000 } = options;
      const deadline = Date.now() + timeout;

      while (Date.now() < deadline) {
        const receipt = (await call('eth_getUserOperationReceipt', [
          options.hash,
        ])) as UserOpReceiptResult | undefined;
        if (receipt !== null && receipt !== undefined) {
          return receipt;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, pollingInterval),
        );
      }
      throw new Error(
        `UserOperation ${options.hash} not included after ${timeout}ms`,
      );
    },
  });
}
