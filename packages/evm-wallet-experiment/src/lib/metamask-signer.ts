/**
 * MetaMask SDK signing adapter.
 *
 * Proxies signing requests to MetaMask (extension or mobile) via the
 * MetaMask SDK. This allows the home kernel to use MetaMask as its
 * signing backend instead of managing keys locally.
 *
 * Usage:
 * ```ts
 * const signer = await connectMetaMaskSigner({
 *   dappMetadata: { name: 'OCAP Wallet', url: 'https://ocap.metamask.io' },
 *   infuraAPIKey: 'YOUR_KEY',
 * });
 * const accounts = await signer.getAccounts();
 * const signature = await signer.signTypedData(typedData, accounts[0]);
 * signer.disconnect();
 * ```
 */

import { MetaMaskSDK } from '@metamask/sdk';

import type {
  Address,
  Eip712TypedData,
  Hex,
  TransactionRequest,
} from '../types.ts';

const harden = globalThis.harden ?? (<T>(value: T): T => value);

/**
 * An Ethereum provider with the standard request method.
 */
export type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/**
 * Options for connecting to MetaMask via the SDK.
 */
export type MetaMaskSignerOptions = {
  dappMetadata?: { name: string; url?: string; iconUrl?: string };
  infuraAPIKey?: string;
};

/**
 * A signing adapter backed by an Ethereum provider (e.g., MetaMask).
 */
export type MetaMaskSigner = {
  getAccounts: () => Promise<Address[]>;
  signTypedData: (data: Eip712TypedData, from: Address) => Promise<Hex>;
  signMessage: (message: string, from: Address) => Promise<Hex>;
  signTransaction: (tx: TransactionRequest) => Promise<Hex>;
  disconnect: () => void;
  provider: EthereumProvider;
};

/**
 * Create a signing adapter from an Ethereum provider.
 *
 * This is the low-level factory that wraps any EIP-1193 provider.
 * Use `connectMetaMaskSigner` for the MetaMask SDK convenience wrapper.
 *
 * @param provider - An EIP-1193 compatible provider.
 * @param options - Options.
 * @param options.disconnect - Optional cleanup function called on disconnect.
 * @returns A signing adapter.
 */
export function makeProviderSigner(
  provider: EthereumProvider,
  options: { disconnect?: () => void } = {},
): MetaMaskSigner {
  let cachedAccounts: Address[] | undefined;

  return harden({
    provider,

    async getAccounts(): Promise<Address[]> {
      const cached = cachedAccounts;
      if (cached) {
        return cached;
      }
      const accounts = (await provider.request({
        method: 'eth_requestAccounts',
      })) as string[];
      const result = accounts.map((a) => a.toLowerCase() as Address);
      cachedAccounts = result;
      return result;
    },

    async signTypedData(data: Eip712TypedData, from: Address): Promise<Hex> {
      // MetaMask Mobile requires EIP712Domain to be explicitly listed in the
      // types field. Without it, the domain separator is computed as empty,
      // producing invalid signatures.
      const domain = (data.domain ?? {}) as Record<string, unknown>;
      const domainTypes: { name: string; type: string }[] = [];
      if (domain.name !== undefined) {
        domainTypes.push({ name: 'name', type: 'string' });
      }
      if (domain.version !== undefined) {
        domainTypes.push({ name: 'version', type: 'string' });
      }
      if (domain.chainId !== undefined) {
        domainTypes.push({ name: 'chainId', type: 'uint256' });
      }
      if (domain.verifyingContract !== undefined) {
        domainTypes.push({ name: 'verifyingContract', type: 'address' });
      }
      if (domain.salt !== undefined) {
        domainTypes.push({ name: 'salt', type: 'bytes32' });
      }

      const enrichedData = {
        ...data,
        types: {
          EIP712Domain: domainTypes,
          ...data.types,
        },
      };

      // EIP-712 typed data may contain BigInt values (e.g. salt).
      // JSON.stringify cannot handle BigInt, so we convert them to hex strings.
      const replacer = (_key: string, value: unknown): unknown =>
        typeof value === 'bigint' ? `0x${value.toString(16)}` : value;
      const result = await provider.request({
        method: 'eth_signTypedData_v4',
        params: [from, JSON.stringify(enrichedData, replacer)],
      });
      return result as Hex;
    },

    async signMessage(message: string, from: Address): Promise<Hex> {
      const result = await provider.request({
        method: 'personal_sign',
        params: [message, from],
      });
      return result as Hex;
    },

    async signTransaction(tx: TransactionRequest): Promise<Hex> {
      const result = await provider.request({
        method: 'eth_signTransaction',
        params: [tx],
      });
      return result as Hex;
    },

    disconnect(): void {
      cachedAccounts = undefined;
      options.disconnect?.();
    },
  });
}

/**
 * Connect to MetaMask via the SDK and return a signing adapter.
 *
 * @param options - Connection options.
 * @returns A MetaMask-backed signing adapter.
 */
export async function connectMetaMaskSigner(
  options: MetaMaskSignerOptions = {},
): Promise<MetaMaskSigner> {
  const sdk = new MetaMaskSDK({
    dappMetadata: options.dappMetadata ?? {
      name: 'OCAP Wallet',
    },
    ...(options.infuraAPIKey ? { infuraAPIKey: options.infuraAPIKey } : {}),
  });

  await sdk.connect();
  const provider = sdk.getProvider();

  if (!provider) {
    throw new Error('MetaMask SDK provider not found');
  }

  return makeProviderSigner(provider as EthereumProvider, {
    disconnect: () => {
      sdk.terminate().catch(() => undefined);
    },
  });
}
