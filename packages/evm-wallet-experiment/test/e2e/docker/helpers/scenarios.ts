/**
 * Named scenario compositions for Docker E2E tests.
 *
 * Each function is a flat sequence of wallet-setup primitives. The caller
 * chooses which scenario to run — no branching happens here.
 */

import { dockerE2eHomeSrpAddressIndex } from './docker-e2e-kernel-services.ts';
import type {
  DockerE2eKernelMode,
  DockerKernelServicePair,
} from './docker-e2e-kernel-services.ts';
import {
  configureBundler,
  configureProvider,
  connectToPeer,
  createSmartAccount,
  finalizeAwayPeerSetup,
  fundAddress,
  getServiceInfo,
  initKeyring,
  issueOcapUrl,
  launchWalletSubcluster,
  preDeploySmartAccount,
  registerLocationHints,
} from './wallet-setup.ts';
import type { ContractAddresses } from './wallet-setup.ts';

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';

const CHAIN_ID = 31337;
const EVM_RPC_URL = 'http://evm:8545';
const BUNDLER_URL = 'http://bundler:4337';
// Hostnames only: the provider vat's `http` config names hosts, not ports.
const ALLOWED_HOSTS = ['evm', 'bundler'];

export type HomeResult = {
  kref: string;
  peerId: string;
  listenAddresses: string[];
  ocapUrl: string;
  address: string;
  smartAccountAddress: string;
};

export type AwayResult = {
  kref: string;
  delegateAddress: string;
  smartAccountAddress?: string;
};

export type { DockerKernelServicePair };

/**
 * Address to pass as `delegate` when calling `buildTransferNativeGrant` or
 * `buildTransferFungibleGrant`.
 *
 * DelegationManager.redeemDelegations requires `delegations[0].delegate == msg.sender`
 * (unless delegate is `ANY_DELEGATE`). Away wallets with a bundler redeem with
 * `msg.sender` = their smart account. Peer-relay redeems on the home device, so
 * `msg.sender` is the home smart account — the on-chain delegate must match that.
 *
 * @param options - Named parameters.
 * @param options.delegationMode - `bundler-7702`, `bundler-hybrid`, or `peer-relay`.
 * @param options.home - Home wallet setup result.
 * @param options.away - Away wallet setup result.
 * @returns The `delegate` field for grant creation.
 */
export function resolveOnChainDelegateAddress(options: {
  delegationMode: string;
  home: HomeResult;
  away: AwayResult;
}): string {
  if (options.delegationMode === 'peer-relay') {
    return options.home.smartAccountAddress;
  }
  return options.away.smartAccountAddress ?? options.away.delegateAddress;
}

/**
 * Set up the home kernel with a full wallet: SRP keyring, provider,
 * bundler, 7702 smart account, and an OCAP URL for peer connection.
 *
 * @param services - Compose service names for this DELEGATION_MODE pair.
 * @param contracts - Deployed contract addresses from the EVM container.
 * @param options - Per-pair key material (parallel stacks need distinct home EOAs).
 * @param options.delegationMode - Kernel pair and HD index for the home SRP account.
 * @returns Home wallet info needed by away setup and tests.
 */
export function setupHome(
  services: DockerKernelServicePair,
  contracts: ContractAddresses,
  options: { delegationMode: DockerE2eKernelMode },
): HomeResult {
  const info = getServiceInfo(services.home);

  const kref = launchWalletSubcluster(services.home, {
    role: 'home',
    contracts,
    allowedHosts: ALLOWED_HOSTS,
  });

  const homeSrpAddressIndex = dockerE2eHomeSrpAddressIndex(
    options.delegationMode,
  );

  const address = initKeyring(services.home, kref, {
    type: 'srp',
    mnemonic: TEST_MNEMONIC,
    addressIndex: homeSrpAddressIndex,
  });

  configureProvider(services.home, kref, {
    chainId: CHAIN_ID,
    rpcUrl: EVM_RPC_URL,
  });

  configureBundler(services.home, kref, {
    bundlerUrl: BUNDLER_URL,
    chainId: CHAIN_ID,
    entryPoint: contracts.EntryPoint,
    environment: contracts,
  });

  const { address: smartAccountAddress } = createSmartAccount(
    services.home,
    kref,
    {
      chainId: CHAIN_ID,
      implementation: 'stateless7702',
    },
  );

  const ocapUrl = issueOcapUrl(services.home, kref);

  return {
    kref,
    peerId: info.peerId as string,
    listenAddresses: info.listenAddresses as string[],
    ocapUrl,
    address,
    smartAccountAddress,
  };
}

/**
 * Common away setup steps shared across all delegation modes:
 * launch subcluster, init throwaway keyring, configure provider,
 * register home peer hints, connect to home.
 *
 * @param services - Compose service names for this pair.
 * @param contracts - Deployed contract addresses.
 * @param home - Home setup result (for peer connection).
 * @returns The coordinator kref and delegate address.
 */
function setupAwayBase(
  services: DockerKernelServicePair,
  contracts: ContractAddresses,
  home: HomeResult,
): { kref: string; delegateAddress: string } {
  const kref = launchWalletSubcluster(services.away, {
    role: 'away',
    contracts,
    allowedHosts: ALLOWED_HOSTS,
  });

  const delegateAddress = initKeyring(services.away, kref, {
    type: 'throwaway',
  });

  configureProvider(services.away, kref, {
    chainId: CHAIN_ID,
    rpcUrl: EVM_RPC_URL,
  });

  registerLocationHints(services.away, home.peerId, home.listenAddresses);
  connectToPeer(services.away, kref, home.ocapUrl);

  return { kref, delegateAddress };
}

/**
 * Set up away with bundler + EIP-7702 stateless smart account.
 *
 * @param services - Compose service names for this pair.
 * @param contracts - Deployed contract addresses.
 * @param home - Home setup result (for peer connection).
 * @returns Away wallet info.
 */
export async function setup7702Away(
  services: DockerKernelServicePair,
  contracts: ContractAddresses,
  home: HomeResult,
): Promise<AwayResult> {
  const { kref, delegateAddress } = setupAwayBase(services, contracts, home);

  configureBundler(services.away, kref, {
    bundlerUrl: BUNDLER_URL,
    chainId: CHAIN_ID,
    entryPoint: contracts.EntryPoint,
    environment: contracts,
  });

  await fundAddress(delegateAddress, 10);

  const { address: smartAccountAddress } = createSmartAccount(
    services.away,
    kref,
    {
      chainId: CHAIN_ID,
      implementation: 'stateless7702',
    },
  );

  await finalizeAwayPeerSetup(services.away, kref, smartAccountAddress);

  return { kref, delegateAddress, smartAccountAddress };
}

/**
 * Set up away with bundler + factory-deployed HybridDeleGator.
 *
 * @param services - Compose service names for this pair.
 * @param contracts - Deployed contract addresses.
 * @param home - Home setup result (for peer connection).
 * @returns Away wallet info.
 */
export async function setupHybridAway(
  services: DockerKernelServicePair,
  contracts: ContractAddresses,
  home: HomeResult,
): Promise<AwayResult> {
  const { kref, delegateAddress } = setupAwayBase(services, contracts, home);

  configureBundler(services.away, kref, {
    bundlerUrl: BUNDLER_URL,
    chainId: CHAIN_ID,
    entryPoint: contracts.EntryPoint,
    environment: contracts,
  });

  const sa = createSmartAccount(services.away, kref, { chainId: CHAIN_ID });

  if (sa.factory && sa.factoryData) {
    await preDeploySmartAccount(sa.factory, sa.factoryData);
    await fundAddress(sa.address, 10);
  }

  await finalizeAwayPeerSetup(services.away, kref, sa.address);

  return { kref, delegateAddress, smartAccountAddress: sa.address };
}

/**
 * Set up away with peer-relay mode (no bundler, no smart account).
 * After connecting to home, runs the same post-connect steps as setup-away.sh
 * (wait for peer wallet, refreshPeerAccounts, sendDelegateAddressToPeer).
 *
 * @param services - Compose service names for this pair.
 * @param contracts - Deployed contract addresses.
 * @param home - Home setup result (for peer connection).
 * @returns Away wallet info.
 */
export async function setupPeerRelayAway(
  services: DockerKernelServicePair,
  contracts: ContractAddresses,
  home: HomeResult,
): Promise<AwayResult> {
  const { kref, delegateAddress } = setupAwayBase(services, contracts, home);
  await finalizeAwayPeerSetup(services.away, kref, delegateAddress);
  return { kref, delegateAddress };
}
