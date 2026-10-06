/**
 * Composable wallet-setup primitives for Docker E2E tests.
 *
 * Each function performs exactly one configuration step by calling into
 * a running kernel container via the CLI. All configuration decisions
 * are made by the caller — these helpers never branch or self-discover.
 */

import { setTimeout as delay } from 'node:timers/promises';

import { callVat, daemonExec, evmRpc, getServiceInfo } from './docker-exec.ts';
import type { ContractAddresses } from './docker-exec.ts';

const BUNDLE_BASE = 'file:///app/packages/evm-wallet-experiment/src/vats';

const ANVIL_FUNDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * Launch the wallet subcluster on a kernel service.
 *
 * @param service - The compose service name.
 * @param options - Subcluster configuration.
 * @param options.role - Whether this is a 'home' or 'away' coordinator.
 * @param options.contracts - Deployed contract addresses.
 * @param options.allowedHosts - Hostnames the provider vat may fetch from.
 * @returns The root coordinator kref (e.g. 'ko4').
 */
export function launchWalletSubcluster(
  service: string,
  options: {
    role: 'home' | 'away';
    contracts: ContractAddresses;
    allowedHosts: string[];
  },
): string {
  const { role, allowedHosts } = options;

  const coordinatorBundle =
    role === 'home'
      ? `${BUNDLE_BASE}/home-coordinator.bundle`
      : `${BUNDLE_BASE}/away-coordinator.bundle`;

  const auxiliaryVat =
    role === 'home'
      ? {
          delegator: {
            bundleSpec: `${BUNDLE_BASE}/delegator-vat.bundle`,
            globals: ['crypto'],
          },
        }
      : {
          redeemer: {
            bundleSpec: `${BUNDLE_BASE}/redeemer-vat.bundle`,
            globals: [],
          },
        };

  const config = {
    bootstrap: 'coordinator',
    forceReset: false,
    services: ['ocapURLIssuerService', 'ocapURLRedemptionService'],
    vats: {
      coordinator: {
        bundleSpec: coordinatorBundle,
        globals: ['Date', 'setTimeout'],
      },
      keyring: {
        bundleSpec: `${BUNDLE_BASE}/keyring-vat.bundle`,
        globals: ['crypto'],
      },
      provider: {
        bundleSpec: `${BUNDLE_BASE}/provider-vat.bundle`,
        globals: ['fetch', 'Request', 'Headers', 'Response'],
        network: { allowedHosts },
      },
      ...auxiliaryVat,
    },
  };

  const result = daemonExec(service, 'launchSubcluster', { config }) as {
    rootKref: string;
  };
  return result.rootKref;
}

/**
 * Initialize the keyring vat.
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 * @param options - Keyring type and seed material.
 * @returns The first account address.
 */
export function initKeyring(
  service: string,
  kref: string,
  options:
    | { type: 'srp'; mnemonic: string; addressIndex?: number }
    | { type: 'throwaway' },
): string {
  callVat(service, kref, 'initializeKeyring', [options]);

  const accounts = callVat(service, kref, 'getAccounts') as string[];
  return accounts[0] as string;
}

/**
 * Configure the EVM provider.
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 * @param options - Chain ID and RPC URL.
 * @param options.chainId - The EVM chain ID.
 * @param options.rpcUrl - The JSON-RPC endpoint URL.
 */
export function configureProvider(
  service: string,
  kref: string,
  options: { chainId: number; rpcUrl: string },
): void {
  callVat(service, kref, 'configureProvider', [options]);
}

/**
 * Configure the ERC-4337 bundler.
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 * @param options - Bundler URL, chain ID, entry point, and contract environment.
 * @param options.bundlerUrl - The ERC-4337 bundler endpoint.
 * @param options.chainId - The EVM chain ID.
 * @param options.entryPoint - The EntryPoint contract address.
 * @param options.environment - The full deployed contract addresses.
 */
export function configureBundler(
  service: string,
  kref: string,
  options: {
    bundlerUrl: string;
    chainId: number;
    entryPoint: string;
    environment: ContractAddresses;
  },
): void {
  callVat(service, kref, 'configureBundler', [options]);
}

/**
 * Create a smart account (7702 or hybrid).
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 * @param options - Chain ID and optional implementation type.
 * @param options.chainId - The EVM chain ID.
 * @param options.implementation - The smart account implementation (e.g. 'stateless7702').
 * @returns The smart account details.
 */
export function createSmartAccount(
  service: string,
  kref: string,
  options: { chainId: number; implementation?: string },
): { address: string; factory?: string; factoryData?: string } {
  return callVat(service, kref, 'createSmartAccount', [options]) as {
    address: string;
    factory?: string;
    factoryData?: string;
  };
}

/**
 * Issue an OCAP URL for peer connection.
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 * @returns The OCAP URL string.
 */
export function issueOcapUrl(service: string, kref: string): string {
  return callVat(service, kref, 'issueOcapUrl', []) as string;
}

/**
 * Connect to a peer via OCAP URL.
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 * @param ocapUrl - The OCAP URL to connect to.
 */
export function connectToPeer(
  service: string,
  kref: string,
  ocapUrl: string,
): void {
  callVat(service, kref, 'connectToPeer', [ocapUrl]);
}

/**
 * Poll until the coordinator reports a peer wallet (matches setup-away.sh step 9).
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 * @param options - Optional timeout and poll interval.
 * @param options.timeoutMs - Max wait in milliseconds (default 60_000).
 * @param options.pollMs - Delay between polls (default 1000).
 */
export async function waitForPeerWallet(
  service: string,
  kref: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const pollMs = options?.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const caps = callVat(service, kref, 'getCapabilities') as {
      hasPeerWallet?: boolean;
    };
    if (caps.hasPeerWallet) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Peer wallet not connected after ${timeoutMs}ms (${service})`,
      );
    }
    await delay(pollMs);
  }
}

/**
 * Re-fetch and cache peer accounts (setup-away.sh step 9b).
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 */
export function refreshPeerAccounts(service: string, kref: string): void {
  callVat(service, kref, 'refreshPeerAccounts', []);
}

/**
 * Send this device's delegate address to the connected peer (setup-away.sh step 9c).
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 * @param address - Delegate address (0x-prefixed) to register on the home wallet.
 */
export function sendDelegateAddressToPeer(
  service: string,
  kref: string,
  address: string,
): void {
  callVat(service, kref, 'sendDelegateAddressToPeer', [address]);
}

/**
 * Post-connect steps from setup-away.sh: wait for peer, cache accounts, register delegate on home.
 *
 * @param service - The compose service name.
 * @param kref - The coordinator kref.
 * @param delegateForHome - Smart account address when configured, else the away EOA (peer-relay).
 */
export async function finalizeAwayPeerSetup(
  service: string,
  kref: string,
  delegateForHome: string,
): Promise<void> {
  await waitForPeerWallet(service, kref);
  refreshPeerAccounts(service, kref);
  sendDelegateAddressToPeer(service, kref, delegateForHome);
}

/**
 * Register location hints for a remote peer on a kernel service.
 *
 * @param service - The compose service name.
 * @param peerId - The remote peer's ID.
 * @param hints - Multiaddr strings for the remote peer.
 */
export function registerLocationHints(
  service: string,
  peerId: string,
  hints: string[],
): void {
  daemonExec(service, 'registerLocationHints', { peerId, hints });
}

/**
 * Fund an address from Anvil's pre-funded account #0.
 *
 * @param address - The address to fund.
 * @param ethAmount - Amount in ETH.
 */
export async function fundAddress(
  address: string,
  ethAmount: number,
): Promise<void> {
  const weiHex = `0x${BigInt(Math.round(ethAmount * 1e18)).toString(16)}`;
  await evmRpc('eth_sendTransaction', [
    { from: ANVIL_FUNDER, to: address, value: weiHex },
  ]);
}

/**
 * Pre-deploy a smart account via its factory contract.
 *
 * @param factory - The factory contract address.
 * @param factoryData - The encoded factory call data.
 */
export async function preDeploySmartAccount(
  factory: string,
  factoryData: string,
): Promise<void> {
  await evmRpc('eth_sendTransaction', [
    { from: ANVIL_FUNDER, to: factory, data: factoryData, gas: '0x1000000' },
  ]);
}

export { getServiceInfo };
export type { ContractAddresses };
