import { makeFetch } from '@metamask/kernel-platforms';
import type { HttpCapability } from '@metamask/kernel-platforms';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Logger } from '@metamask/logger';
import type { Baggage } from '@metamask/ocap-kernel';
import { encodeAbiParameters, parseAbiParameters } from 'viem';

import { makeBundlerClient } from '../lib/bundler-client.ts';
import type { ViemBundlerClient } from '../lib/bundler-client.ts';
import { httpGetJson, makeProvider } from '../lib/provider.ts';
import type { Provider } from '../lib/provider.ts';
import type { Address, ChainConfig, Hex, UserOperation } from '../types.ts';

const harden = globalThis.harden ?? (<T>(value: T): T => value);

declare const http: HttpCapability | undefined;

/**
 * Function selector for EntryPoint.getNonce(address,uint192).
 */
const GET_NONCE_SELECTOR = '0x35567e1a' as Hex;

/**
 * Vat powers for the provider vat.
 */
type VatPowers = {
  logger?: Logger;
};

/**
 * Build the root object for the provider vat.
 *
 * The provider vat handles all Ethereum JSON-RPC communication.
 * It wraps the lib/provider module in an exo interface.
 *
 * @param _vatPowers - Special powers granted to this vat.
 * @param _parameters - Initialization parameters.
 * @param baggage - Root of vat's persistent state.
 * @returns The root object for the provider vat.
 */
export function buildRootObject(
  _vatPowers: VatPowers,
  _parameters: unknown,
  baggage: Baggage,
): object {
  // `typeof`, because an ungranted endowment is an undeclared global.
  const vatFetch: typeof fetch =
    typeof http === 'undefined'
      ? harden(async () => {
          throw new Error('The provider vat was granted no http capability');
        })
      : makeFetch(http);

  let provider: Provider | undefined;
  let bundlerClient: ViemBundlerClient | undefined;

  // Restore provider from persisted chain config
  if (baggage.has('chainConfig')) {
    const chainConfig = baggage.get('chainConfig') as ChainConfig;
    provider = makeProvider(chainConfig, vatFetch);
  }

  // Restore bundler client from persisted config
  if (baggage.has('bundlerConfig')) {
    const config = baggage.get('bundlerConfig') as {
      bundlerUrl: string;
      chainId: number;
    };
    bundlerClient = makeBundlerClient(
      { bundlerUrl: config.bundlerUrl, chainId: config.chainId },
      vatFetch,
    );
  }

  /**
   * Get the pre-configured bundler client.
   *
   * @returns A bundler client.
   */
  function getBundlerClient(): ViemBundlerClient {
    if (bundlerClient) {
      return bundlerClient;
    }
    throw new Error(
      'Bundler client not configured. Call configureBundler() first.',
    );
  }

  return makeDefaultExo('walletProvider', {
    async bootstrap(): Promise<void> {
      // No services needed for the provider vat
    },

    async configure(chainConfig: ChainConfig): Promise<void> {
      provider = makeProvider(chainConfig, vatFetch);

      const hardenedConfig = harden({ ...chainConfig });
      if (baggage.has('chainConfig')) {
        baggage.set('chainConfig', hardenedConfig);
      } else {
        baggage.init('chainConfig', hardenedConfig);
      }
    },

    async configureBundler(config: {
      bundlerUrl: string;
      chainId: number;
    }): Promise<void> {
      bundlerClient = makeBundlerClient(
        { bundlerUrl: config.bundlerUrl, chainId: config.chainId },
        vatFetch,
      );

      const hardenedBundlerConfig = harden({ ...config });
      if (baggage.has('bundlerConfig')) {
        baggage.set('bundlerConfig', hardenedBundlerConfig);
      } else {
        baggage.init('bundlerConfig', hardenedBundlerConfig);
      }
    },

    async request(method: string, params?: unknown[]): Promise<unknown> {
      if (!provider) {
        throw new Error('Provider not configured');
      }
      return provider.request(method, params);
    },

    async broadcastTransaction(signedTx: Hex): Promise<Hex> {
      if (!provider) {
        throw new Error('Provider not configured');
      }
      return provider.broadcastTransaction(signedTx);
    },

    async getBalance(address: Address): Promise<string> {
      if (!provider) {
        throw new Error('Provider not configured');
      }
      return provider.getBalance(address);
    },

    async getChainId(): Promise<number> {
      if (!provider) {
        throw new Error('Provider not configured');
      }
      return provider.getChainId();
    },

    async getNonce(address: Address): Promise<number> {
      if (!provider) {
        throw new Error('Provider not configured');
      }
      return provider.getNonce(address);
    },

    async submitUserOp(options: {
      bundlerUrl: string;
      entryPoint: Hex;
      userOp: UserOperation;
    }): Promise<Hex> {
      const client = getBundlerClient();
      return client.sendUserOperation({
        userOp: options.userOp as never,
        entryPointAddress: options.entryPoint,
      });
    },

    async estimateUserOpGas(options: {
      bundlerUrl: string;
      entryPoint: Hex;
      userOp: UserOperation;
    }): Promise<{
      callGasLimit: Hex;
      verificationGasLimit: Hex;
      preVerificationGas: Hex;
    }> {
      const client = getBundlerClient();
      const estimate = await client.estimateUserOperationGas({
        userOp: options.userOp as never,
        entryPointAddress: options.entryPoint,
      });
      return {
        callGasLimit: `0x${estimate.callGasLimit.toString(16)}`,
        verificationGasLimit: `0x${estimate.verificationGasLimit.toString(16)}`,
        preVerificationGas: `0x${estimate.preVerificationGas.toString(16)}`,
      };
    },

    async sponsorUserOp(options: {
      bundlerUrl: string;
      entryPoint: Hex;
      userOp: UserOperation;
      context?: Record<string, unknown>;
    }): Promise<{
      paymaster: Address;
      paymasterData: Hex;
      paymasterVerificationGasLimit: Hex;
      paymasterPostOpGasLimit: Hex;
      callGasLimit: Hex;
      verificationGasLimit: Hex;
      preVerificationGas: Hex;
    }> {
      const client = getBundlerClient();
      return client.sponsorUserOperation({
        userOp: options.userOp as never,
        entryPointAddress: options.entryPoint,
        ...(options.context === undefined ? {} : { context: options.context }),
      });
    },

    async getUserOperationGasPrice(): Promise<{
      fast: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
    }> {
      const client = getBundlerClient();
      return client.getUserOperationGasPrice();
    },

    async getEntryPointNonce(options: {
      entryPoint: Address;
      sender: Address;
      key?: Hex;
    }): Promise<Hex> {
      if (!provider) {
        throw new Error('Provider not configured');
      }
      const encoded = encodeAbiParameters(
        parseAbiParameters('address, uint192'),
        [options.sender, options.key ? BigInt(options.key) : 0n],
      );
      const callData = (GET_NONCE_SELECTOR + encoded.slice(2)) as Hex;

      const result = await provider.request('eth_call', [
        { to: options.entryPoint, data: callData },
        'latest',
      ]);
      return result as Hex;
    },

    async getUserOpReceipt(options: {
      bundlerUrl: string;
      userOpHash: Hex;
    }): Promise<unknown> {
      const client = getBundlerClient();
      return client.getUserOperationReceipt(options.userOpHash);
    },

    async httpGetJson(url: string): Promise<unknown> {
      return httpGetJson(url, vatFetch);
    },

    async getGasFees(): Promise<{
      maxFeePerGas: Hex;
      maxPriorityFeePerGas: Hex;
    }> {
      if (!provider) {
        throw new Error('Provider not configured');
      }
      const [block, priorityFee] = await Promise.all([
        provider.request('eth_getBlockByNumber', ['latest', false]),
        provider
          .request('eth_maxPriorityFeePerGas', [])
          .catch((error: unknown) => {
            const message = String((error as Error).message ?? error);
            // JSON-RPC -32601 = method not found. Expected on non-EIP-1559 chains.
            if (message.includes('-32601')) {
              return '0x3b9aca00';
            }
            throw new Error(`Failed to get priority fee: ${message}`);
          }),
      ]);
      // Validate RPC response shape before using it
      const blockObj = block as Record<string, unknown> | null;
      if (
        !blockObj ||
        typeof blockObj !== 'object' ||
        typeof blockObj.baseFeePerGas !== 'string'
      ) {
        throw new Error(
          'Invalid block response: missing or malformed baseFeePerGas',
        );
      }
      const baseFee = BigInt(blockObj.baseFeePerGas);
      const priority = BigInt(priorityFee as string);
      // maxFeePerGas = 2 * baseFee + maxPriorityFeePerGas (standard EIP-1559 heuristic)
      const maxFee = baseFee * 2n + priority;
      return {
        maxFeePerGas: `0x${maxFee.toString(16)}`,
        maxPriorityFeePerGas: `0x${priority.toString(16)}`,
      };
    },
  });
}
