import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import { Logger } from '@metamask/logger';
import type { Baggage } from '@metamask/ocap-kernel';
import type { SignedAuthorization } from 'viem';

import type {
  DelegationSection,
  TransferFungibleFacet,
  TransferNativeFacet,
} from '../lib/delegation-twin.ts';
import { makeDelegationTwin } from '../lib/delegation-twin.ts';
import {
  decodeBalanceOfResult,
  decodeDecimalsResult,
  decodeNameResult,
  decodeSymbolResult,
  encodeBalanceOf,
  encodeDecimals,
  encodeName,
  encodeSymbol,
} from '../lib/erc20.ts';
import {
  registerEnvironment,
  resolveEnvironment,
  buildSdkRedeemCallData,
  isEip7702Delegated,
  prepareUserOpTypedData,
  setSdkLogger,
  computeSmartAccountAddress,
} from '../lib/sdk.ts';
import {
  applyGasBuffer,
  validateGasEstimate,
  validateTokenCallResult,
} from '../lib/tx-utils.ts';
import { ENTRY_POINT_V07 } from '../lib/userop.ts';
import type {
  Address,
  ChainConfig,
  Delegation,
  DelegationGrant,
  Eip712TypedData,
  Execution,
  Hex,
  SmartAccountConfig,
  TransactionRequest,
  TransferNativeGrant,
  UserOperation,
  WalletCapabilities,
} from '../types.ts';

const harden = globalThis.harden ?? (<T>(value: T): T => value);

/**
 * Convert a wei amount in hex to a human-readable ETH string.
 *
 * @param weiHex - The wei amount as a hex string.
 * @returns A formatted string like "1.5 ETH".
 */
function weiToEth(weiHex: string): string {
  const wei = BigInt(weiHex);
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  if (frac === 0n) {
    return `${String(whole)} ETH`;
  }
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/u, '');
  return `${String(whole)}.${fracStr} ETH`;
}

// ---------------------------------------------------------------------------
// Vat powers and wiring types
// ---------------------------------------------------------------------------

/**
 * Vat powers for the away coordinator vat.
 */
type VatPowers = {
  logger?: Logger;
};

/**
 * Vat references available in the away wallet subcluster.
 */
type WalletVats = {
  keyring?: unknown;
  provider?: unknown;
  redeemer?: unknown;
};

/**
 * Services available to the away wallet subcluster.
 */
type WalletServices = {
  ocapURLRedemptionService?: unknown;
};

// ---------------------------------------------------------------------------
// Typed facets for E() calls (no `any` — explicit method signatures)
// ---------------------------------------------------------------------------

type HomeSection = TransferNativeFacet & TransferFungibleFacet;

type HomeCoordinatorRef = {
  signTypedData: (data: Eip712TypedData, from?: Address) => Promise<Hex>;
  signMessage: (message: string, account?: Address) => Promise<Hex>;
  getAccounts: () => Promise<Address[]>;
  redeemDelegation: (options: {
    delegation: Delegation;
    execution: Execution;
  }) => Promise<Hex>;
  getHomeSection: () => Promise<HomeSection>;
  registerDelegateAddress: (address: string) => Promise<void>;
};

type KeyringFacet = {
  initialize: (
    options: { type: string; mnemonic?: string },
    password?: string,
    salt?: string,
  ) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  isLocked: () => Promise<boolean>;
  hasKeys: () => Promise<boolean>;
  getAccounts: () => Promise<Address[]>;
  deriveAccount: (index: number) => Promise<Address>;
  signTransaction: (tx: TransactionRequest) => Promise<Hex>;
  signTypedData: (data: Eip712TypedData, from?: Address) => Promise<Hex>;
  signMessage: (message: string, from?: Address) => Promise<Hex>;
  signHash: (hash: Hex, from?: Address) => Promise<Hex>;
  signAuthorization: (options: {
    contractAddress: Address;
    chainId: number;
    nonce: number;
    from?: Address;
  }) => Promise<SignedAuthorization>;
};

type ProviderFacet = {
  configure: (config: ChainConfig) => Promise<void>;
  request: (method: string, params?: unknown[]) => Promise<unknown>;
  broadcastTransaction: (signedTx: Hex) => Promise<Hex>;
  getChainId: () => Promise<number>;
  getNonce: (address: Address) => Promise<number>;
  getEntryPointNonce: (options: {
    entryPoint: Address;
    sender: Address;
    key?: Hex;
  }) => Promise<Hex>;
  submitUserOp: (options: {
    bundlerUrl: string;
    entryPoint: Hex;
    userOp: UserOperation;
  }) => Promise<Hex>;
  estimateUserOpGas: (options: {
    bundlerUrl: string;
    entryPoint: Hex;
    userOp: UserOperation;
  }) => Promise<{
    callGasLimit: Hex;
    verificationGasLimit: Hex;
    preVerificationGas: Hex;
  }>;
  getUserOpReceipt: (options: {
    bundlerUrl: string;
    userOpHash: Hex;
  }) => Promise<unknown>;
  getGasFees: () => Promise<{
    maxFeePerGas: Hex;
    maxPriorityFeePerGas: Hex;
  }>;
  configureBundler: (config: {
    bundlerUrl: string;
    chainId: number;
  }) => Promise<void>;
  httpGetJson: (url: string) => Promise<unknown>;
  getUserOperationGasPrice: () => Promise<{
    fast: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
  }>;
  sponsorUserOp: (options: {
    bundlerUrl: string;
    entryPoint: Hex;
    userOp: UserOperation;
    context?: Record<string, unknown>;
  }) => Promise<{
    paymaster: Address;
    paymasterData: Hex;
    paymasterVerificationGasLimit: Hex;
    paymasterPostOpGasLimit: Hex;
    callGasLimit: Hex;
    verificationGasLimit: Hex;
    preVerificationGas: Hex;
  }>;
};

type ExternalSignerFacet = {
  getAccounts: () => Promise<Address[]>;
  signTypedData: (data: Eip712TypedData, from: Address) => Promise<Hex>;
  signMessage: (message: string, from: Address) => Promise<Hex>;
  signTransaction: (tx: TransactionRequest) => Promise<Hex>;
};

type RedeemerFacet = {
  receiveGrant: (grant: DelegationGrant) => Promise<void>;
  removeGrant: (id: string) => Promise<void>;
  listGrants: () => Promise<DelegationGrant[]>;
};

type OcapURLRedemptionFacet = {
  redeem: (url: string) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// buildRootObject
// ---------------------------------------------------------------------------

/**
 * Build the root object for the away coordinator vat.
 *
 * The away coordinator manages routing for the semantic wallet API on the away
 * (agent) side. It keeps execution infrastructure (provider, bundler, smart
 * account, tx submission, ERC-20 queries) and routes semantic calls
 * (`transferNative`, `transferFungible`) through delegation twins first, then
 * falls back to calling home.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param _parameters - Initialization parameters (role: 'away').
 * @param baggage - Root of vat's persistent state.
 * @returns The root object for the away coordinator vat.
 */
export function buildRootObject(
  vatPowers: VatPowers,
  _parameters: unknown,
  baggage: Baggage,
): object {
  const logger = (vatPowers.logger ?? new Logger()).subLogger({
    tags: ['away-coordinator'],
  });

  // Wire SDK logger so resolveEnvironment/registerEnvironment are visible
  setSdkLogger((level, message, data) => {
    if (level === 'info') {
      logger.info(message, data);
    } else {
      logger.debug(message, data);
    }
  });

  // -------------------------------------------------------------------------
  // State variables
  // -------------------------------------------------------------------------

  // References to other vats (set during bootstrap)
  let keyringVat: KeyringFacet | undefined;
  let providerVat: ProviderFacet | undefined;
  let redeemerVat: RedeemerFacet | undefined;

  // External signer reference (e.g. MetaMask).
  // Note: external signers are transient — they must be reconnected after
  // kernel restart via connectExternalSigner(). The baggage entry tracks
  // the reference but it may be stale after resuscitation.
  let externalSigner: ExternalSignerFacet | undefined;

  // Bundler configuration for ERC-4337 UserOps
  let bundlerConfig:
    | {
        bundlerUrl: string;
        entryPoint: Hex;
        chainId: number;
        usePaymaster?: boolean | undefined;
        sponsorshipPolicyId?: string | undefined;
        environment?:
          | {
              EntryPoint: Hex;
              DelegationManager: Hex;
              SimpleFactory: Hex;
              implementations: Record<string, Hex>;
              caveatEnforcers: Record<string, Hex>;
            }
          | undefined;
      }
    | undefined;

  // Smart account configuration (persisted in baggage)
  let smartAccountConfig: SmartAccountConfig | undefined;

  // OCAP URL redemption service (wired from services in bootstrap)
  let redemptionService: OcapURLRedemptionFacet | undefined;

  // Routing state
  let homeSection: HomeSection | undefined; // remote ref to home's homeSection exo
  let homeCoordRef: HomeCoordinatorRef | undefined; // remote ref to home coordinator (for delegate registration)
  let delegationSections: DelegationSection[] = [];
  // Keyed by delegation.id so rebuildRouting preserves in-memory spend counters.
  const delegationTwinMap = new Map<string, DelegationSection>();

  // -------------------------------------------------------------------------
  // Baggage helpers
  // -------------------------------------------------------------------------

  /**
   * Typed helper for restoring values from baggage (resuscitation).
   *
   * @param key - The baggage key to look up.
   * @returns The stored value cast to T, or undefined if not present.
   */
  function restoreFromBaggage<T>(key: string): T | undefined {
    return baggage.has(key) ? (baggage.get(key) as T) : undefined;
  }

  /**
   * Persist a baggage key-value pair, handling both init and update.
   *
   * @param key - The baggage key.
   * @param value - The value to persist.
   */
  function persistBaggage(key: string, value: unknown): void {
    if (baggage.has(key)) {
      baggage.set(key, value);
    } else {
      baggage.init(key, value);
    }
  }

  // -------------------------------------------------------------------------
  // Restore state from baggage (resuscitation)
  // -------------------------------------------------------------------------

  keyringVat = restoreFromBaggage<KeyringFacet>('keyringVat');
  providerVat = restoreFromBaggage<ProviderFacet>('providerVat');
  redeemerVat = restoreFromBaggage<RedeemerFacet>('redeemerVat');
  externalSigner = restoreFromBaggage<ExternalSignerFacet>('externalSigner');
  bundlerConfig = restoreFromBaggage<typeof bundlerConfig>('bundlerConfig');
  if (bundlerConfig?.environment) {
    registerEnvironment(bundlerConfig.chainId, bundlerConfig.environment);
  }
  smartAccountConfig =
    restoreFromBaggage<SmartAccountConfig>('smartAccountConfig');
  homeCoordRef = restoreFromBaggage<HomeCoordinatorRef>('homeCoordRef');
  homeSection = restoreFromBaggage<HomeSection>('homeSection');

  /** Chain ID from the last `configureProvider` call (avoids RPC on every send). */
  let cachedProviderChainId: number | undefined = restoreFromBaggage<number>(
    'cachedProviderChainId',
  );

  // -------------------------------------------------------------------------
  // Internal async helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the wallet chain ID for SDK addresses and txs.
   *
   * Order: bundler config → cached provider config → `eth_chainId` RPC.
   *
   * @returns The resolved chain ID.
   */
  async function resolveChainId(): Promise<number> {
    if (bundlerConfig?.chainId !== undefined) {
      return bundlerConfig.chainId;
    }
    if (cachedProviderChainId !== undefined) {
      return cachedProviderChainId;
    }
    if (!providerVat) {
      throw new Error(
        'Provider not configured — call configureProvider() first',
      );
    }
    return E(providerVat).getChainId();
  }

  /**
   * Whether smart-account operations for this sender should use Infura-style
   * raw transactions (stateless 7702) instead of ERC-4337 UserOps.
   *
   * @param sender - Smart account address (same as EOA for stateless 7702).
   * @returns True when direct EIP-1559 submission should be used.
   */
  async function useDirect7702Tx(sender: Address): Promise<boolean> {
    if (smartAccountConfig?.implementation === 'stateless7702') {
      if (
        smartAccountConfig.address !== undefined &&
        smartAccountConfig.address.toLowerCase() !== sender.toLowerCase()
      ) {
        // Config points at a different account — fall through to lazy check.
      } else {
        return true;
      }
    }
    if (smartAccountConfig?.implementation === 'hybrid') {
      return false;
    }
    if (!providerVat) {
      throw new Error(
        'Cannot determine account type: provider not configured and ' +
          'smartAccountConfig is absent. Call configureProvider() first.',
      );
    }
    const code = (await E(providerVat).request('eth_getCode', [
      sender,
      'latest',
    ])) as string;
    const chainId = await resolveChainId();
    return isEip7702Delegated(code, chainId);
  }

  /**
   * Resolve the signing strategy for typed data.
   * Priority: keyring → external signer → error.
   * Away has no peer wallet fallback for typed data signing.
   *
   * @param data - The EIP-712 typed data to sign.
   * @returns The signature as a hex string.
   */
  async function resolveTypedDataSigning(data: Eip712TypedData): Promise<Hex> {
    if (keyringVat) {
      const hasKeys = await E(keyringVat).hasKeys();
      if (hasKeys) {
        return E(keyringVat).signTypedData(data);
      }
    }

    if (externalSigner) {
      const accounts = await E(externalSigner).getAccounts();
      if (accounts.length > 0) {
        return E(externalSigner).signTypedData(data, accounts[0] as Address);
      }
    }

    if (homeCoordRef) {
      return E(homeCoordRef).signTypedData(data);
    }

    throw new Error('No authority to sign typed data');
  }

  /**
   * Resolve the signing strategy for a transaction.
   * LOCAL KEY ONLY on away side — no peer fallback.
   * Priority: keyring → external signer → error.
   *
   * @param tx - The transaction request to sign.
   * @returns The signed transaction as a hex string.
   */
  async function resolveTransactionSigning(
    tx: TransactionRequest,
  ): Promise<Hex> {
    // Strategy 1: Check if local keyring owns this account
    if (keyringVat) {
      const accounts = await E(keyringVat).getAccounts();
      if (accounts.includes(tx.from.toLowerCase() as Address)) {
        return E(keyringVat).signTransaction(tx);
      }
    }

    // Strategy 2: Check if external signer can handle it
    if (externalSigner) {
      return E(externalSigner).signTransaction({
        ...tx,
        from: tx.from.toLowerCase() as Address,
      });
    }

    throw new Error('No authority to sign this transaction');
  }

  /**
   * Sign and broadcast a self-call tx with SDK-encoded DeleGator calldata
   * (7702 EOA). Returns the transaction hash immediately after broadcast.
   *
   * @param options - Direct submission options.
   * @param options.sender - Upgraded EOA / smart account address.
   * @param options.callData - SDK-wrapped `execute` calldata.
   * @param options.maxFeePerGas - Optional max fee per gas override.
   * @param options.maxPriorityFeePerGas - Optional priority fee override.
   * @returns The transaction hash from `eth_sendRawTransaction`.
   */
  async function buildAndSubmitDirect7702Tx(options: {
    sender: Address;
    callData: Hex;
    maxFeePerGas?: Hex | undefined;
    maxPriorityFeePerGas?: Hex | undefined;
  }): Promise<Hex> {
    if (!providerVat) {
      throw new Error('Provider vat not available');
    }
    const chainId = await resolveChainId();
    let { maxFeePerGas, maxPriorityFeePerGas } = options;
    if (!maxFeePerGas || !maxPriorityFeePerGas) {
      const fees = await E(providerVat).getGasFees();
      maxFeePerGas = maxFeePerGas ?? fees.maxFeePerGas;
      maxPriorityFeePerGas = maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas;
    }
    const nonce = await E(providerVat).getNonce(options.sender);
    const estimatedGas = validateGasEstimate(
      await E(providerVat).request('eth_estimateGas', [
        {
          from: options.sender,
          to: options.sender,
          data: options.callData,
        },
      ]),
    );
    const gasLimit = applyGasBuffer(estimatedGas, 10);
    const filledTx: TransactionRequest = {
      from: options.sender,
      to: options.sender,
      chainId,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
      data: options.callData,
      value: '0x0' as Hex,
    };
    const signedTx = await resolveTransactionSigning(filledTx);
    return E(providerVat).broadcastTransaction(signedTx);
  }

  /**
   * Build, sign, and submit a UserOp. Shared pipeline for delegation
   * redemption.
   *
   * @param options - Pipeline options.
   * @param options.sender - The smart account address that sends the UserOp.
   * @param options.callData - The encoded callData for the UserOp.
   * @param options.maxFeePerGas - Optional max fee per gas override.
   * @param options.maxPriorityFeePerGas - Optional max priority fee per gas override.
   * @returns The UserOp hash from the bundler.
   */
  async function buildAndSubmitUserOp(options: {
    sender: Address;
    callData: Hex;
    maxFeePerGas?: Hex;
    maxPriorityFeePerGas?: Hex;
  }): Promise<Hex> {
    if (!providerVat) {
      throw new Error('Provider vat not available');
    }
    if (!bundlerConfig) {
      throw new Error('Bundler not configured');
    }

    const { sender, callData } = options;

    // Get gas prices from the bundler (pimlico_getUserOperationGasPrice)
    // which returns prices the bundler will accept, avoiding rejection
    // due to stale node-reported fees.
    let { maxFeePerGas, maxPriorityFeePerGas } = options;
    if (!maxFeePerGas || !maxPriorityFeePerGas) {
      const gasPrice = await E(providerVat).getUserOperationGasPrice();
      maxFeePerGas = maxFeePerGas ?? gasPrice.fast.maxFeePerGas;
      maxPriorityFeePerGas =
        maxPriorityFeePerGas ?? gasPrice.fast.maxPriorityFeePerGas;
    }

    // Get nonce from EntryPoint contract (ERC-4337 nonce)
    const nonceHex = await E(providerVat).getEntryPointNonce({
      entryPoint: bundlerConfig.entryPoint,
      sender,
    });

    // Detect signing mode: check smartAccountConfig first, then fall back
    // to on-chain code inspection. This ensures the correct signing mode
    // even if smartAccountConfig is lost from baggage.
    let isStateless7702 =
      smartAccountConfig?.implementation === 'stateless7702';

    // Always fetch on-chain code — needed for both factory detection and
    // signing mode fallback.
    const onChainCode = (await E(providerVat).request('eth_getCode', [
      sender,
      'latest',
    ])) as string | undefined;

    if (typeof onChainCode !== 'string') {
      throw new Error(
        `eth_getCode for ${sender} returned ${String(onChainCode)}; check provider configuration`,
      );
    }

    // Fall back to on-chain code detection for 7702 accounts that weren't
    // configured via smartAccountConfig (e.g., restored from stale baggage).
    // Any EIP-7702 designator prefix (0xef0100) indicates a Stateless7702
    // DeleGator, which uses a different EIP-712 domain name for signing.
    if (!isStateless7702 && onChainCode.toLowerCase().startsWith('0xef0100')) {
      isStateless7702 = true;
    }

    // Check on-chain whether the smart account is deployed (eth_getCode).
    // This avoids relying on a cached flag that could be stale if the
    // deployment UserOp failed on-chain.
    let includeFactory = false;
    if (
      !isStateless7702 &&
      smartAccountConfig?.factory &&
      smartAccountConfig.factoryData
    ) {
      includeFactory = onChainCode === '0x' || onChainCode === '0x0';

      if (!includeFactory && smartAccountConfig.deployed === false) {
        smartAccountConfig = harden({
          ...smartAccountConfig,
          deployed: true,
        });
        persistBaggage('smartAccountConfig', smartAccountConfig);
      }
    }

    // Build unsigned UserOp with a dummy 65-byte signature so that the
    // smart account's validateUserOp can parse the ECDSA signature during
    // bundler/paymaster simulation. An empty signature (0x) causes revert.
    const unsignedUserOp: UserOperation = {
      sender,
      nonce: nonceHex,
      callData,
      callGasLimit: '0x50000' as Hex,
      verificationGasLimit: '0x60000' as Hex,
      preVerificationGas: '0x10000' as Hex,
      maxFeePerGas,
      maxPriorityFeePerGas,
      signature:
        '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c' as Hex,
      ...(includeFactory && smartAccountConfig
        ? {
            factory: smartAccountConfig.factory as Hex,
            factoryData: smartAccountConfig.factoryData as Hex,
          }
        : {}),
    };

    let userOpWithGas: UserOperation;

    if (bundlerConfig.usePaymaster) {
      // Use paymaster sponsorship instead of gas estimation
      const sponsorContext: Record<string, unknown> = {};
      if (bundlerConfig.sponsorshipPolicyId) {
        sponsorContext.sponsorshipPolicyId = bundlerConfig.sponsorshipPolicyId;
      }

      const sponsorResult = await E(providerVat).sponsorUserOp({
        bundlerUrl: bundlerConfig.bundlerUrl,
        entryPoint: bundlerConfig.entryPoint,
        userOp: unsignedUserOp,
        context: sponsorContext,
      });

      userOpWithGas = {
        ...unsignedUserOp,
        paymaster: sponsorResult.paymaster,
        paymasterData: sponsorResult.paymasterData,
        paymasterVerificationGasLimit:
          sponsorResult.paymasterVerificationGasLimit,
        paymasterPostOpGasLimit: sponsorResult.paymasterPostOpGasLimit,
        callGasLimit: sponsorResult.callGasLimit,
        verificationGasLimit: sponsorResult.verificationGasLimit,
        preVerificationGas: sponsorResult.preVerificationGas,
      };
    } else {
      // Estimate gas via bundler
      const gasEstimate = await E(providerVat).estimateUserOpGas({
        bundlerUrl: bundlerConfig.bundlerUrl,
        entryPoint: bundlerConfig.entryPoint,
        userOp: unsignedUserOp,
      });

      userOpWithGas = {
        ...unsignedUserOp,
        callGasLimit: applyGasBuffer(gasEstimate.callGasLimit, 10),
        verificationGasLimit: applyGasBuffer(
          gasEstimate.verificationGasLimit,
          10,
        ),
        preVerificationGas: gasEstimate.preVerificationGas,
      };
    }

    // Sign the UserOp via EIP-712 typed data. Both Hybrid and Stateless7702
    // DeleGators validate signatures using EIP-712 — the only difference is
    // the domain name.
    const userOpTypedData = prepareUserOpTypedData({
      userOp: userOpWithGas,
      entryPoint: bundlerConfig.entryPoint,
      chainId: bundlerConfig.chainId,
      smartAccountAddress: sender,
      ...(isStateless7702
        ? { smartAccountName: 'EIP7702StatelessDeleGator' }
        : {}),
    });
    const signature: Hex = await resolveTypedDataSigning(userOpTypedData);

    // Attach signature and submit
    const signedUserOp: UserOperation = {
      ...userOpWithGas,
      signature,
    };

    return E(providerVat).submitUserOp({
      bundlerUrl: bundlerConfig.bundlerUrl,
      entryPoint: bundlerConfig.entryPoint,
      userOp: signedUserOp,
    });
  }

  /**
   * Build, sign, and submit a UserOp that redeems one or more delegations.
   *
   * @param options - UserOp pipeline options.
   * @param options.delegations - The delegation chain (leaf to root).
   * @param options.execution - The execution to perform.
   * @param options.maxFeePerGas - Max fee per gas.
   * @param options.maxPriorityFeePerGas - Max priority fee per gas.
   * @returns The UserOp hash from the bundler.
   */
  async function submitDelegationUserOp(options: {
    delegations: Delegation[];
    execution: Execution;
    maxFeePerGas?: Hex | undefined;
    maxPriorityFeePerGas?: Hex | undefined;
  }): Promise<Hex> {
    if (!bundlerConfig && !smartAccountConfig) {
      throw new Error(
        'Bundler not configured — cannot redeem delegation without bundler or smart account config',
      );
    }

    const sender =
      smartAccountConfig?.address ??
      (options.delegations[0] as Delegation).delegate;

    const chainId = await resolveChainId();
    const sdkCallData = buildSdkRedeemCallData({
      delegations: options.delegations,
      execution: options.execution,
      chainId,
    });

    if (await useDirect7702Tx(sender)) {
      return buildAndSubmitDirect7702Tx({
        sender,
        callData: sdkCallData,
        maxFeePerGas: options.maxFeePerGas,
        maxPriorityFeePerGas: options.maxPriorityFeePerGas,
      });
    }

    if (!bundlerConfig) {
      throw new Error(
        'Bundler not configured (required for hybrid smart account redemption)',
      );
    }

    const userOpOptions: {
      sender: Address;
      callData: Hex;
      maxFeePerGas?: Hex;
      maxPriorityFeePerGas?: Hex;
    } = { sender, callData: sdkCallData };
    if (options.maxFeePerGas) {
      userOpOptions.maxFeePerGas = options.maxFeePerGas;
    }
    if (options.maxPriorityFeePerGas) {
      userOpOptions.maxPriorityFeePerGas = options.maxPriorityFeePerGas;
    }

    return buildAndSubmitUserOp(userOpOptions);
  }

  /**
   * Poll until an EIP-1559 transaction is mined or timeout.
   *
   * @param options - Polling options.
   * @param options.txHash - Transaction hash to wait for.
   * @param options.pollIntervalMs - Delay between RPC polls in milliseconds.
   * @param options.timeoutMs - Maximum time to wait in milliseconds.
   * @returns Whether the mined transaction succeeded (`status` 0x1).
   */
  async function pollTransactionReceipt(options: {
    txHash: Hex;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<{ success: boolean }> {
    if (!providerVat) {
      throw new Error('Provider not configured');
    }
    if (
      typeof globalThis.Date?.now !== 'function' ||
      typeof globalThis.setTimeout !== 'function'
    ) {
      throw new Error(
        'Transaction receipt polling requires Date.now and setTimeout',
      );
    }
    const interval = options.pollIntervalMs ?? 2000;
    const timeout = options.timeoutMs ?? 120_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let receipt: { status?: string | number } | null = null;
      try {
        receipt = (await E(providerVat).request('eth_getTransactionReceipt', [
          options.txHash,
        ])) as { status?: string | number } | null;
      } catch (error) {
        // Transient RPC errors (network hiccups, rate limits) should not
        // abort polling — the tx was already broadcast and may still mine.
        logger.warn(
          `RPC error polling receipt for ${options.txHash}, will retry`,
          error,
        );
        await new Promise((resolve) => setTimeout(resolve, interval));
        continue;
      }
      if (receipt) {
        // Normalize: some providers return status as a number (1) rather
        // than the standard hex string ('0x1'). EIP-1559 receipts must have
        // a status field; a missing one likely indicates a malformed response.
        const { status } = receipt;
        if (status === undefined || status === null) {
          logger.warn(
            `Receipt for ${options.txHash} has no status field — assuming success`,
          );
          return harden({ success: true });
        }
        const normalizedStatus =
          typeof status === 'number' ? `0x${status.toString(16)}` : status;
        return harden({ success: normalizedStatus === '0x1' });
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(
      `Transaction ${options.txHash} not mined after ${String(timeout)}ms`,
    );
  }

  /**
   * Resolve the EOA owner address from the keyring or external signer.
   *
   * @returns The first available EOA address.
   * @throws If no accounts are available.
   */
  async function resolveOwnerAddress(): Promise<Address> {
    if (keyringVat) {
      const accounts = await E(keyringVat).getAccounts();
      if (accounts.length > 0) {
        return accounts[0] as Address;
      }
    }
    if (externalSigner) {
      const accounts = await E(externalSigner).getAccounts();
      if (accounts.length > 0) {
        return accounts[0] as Address;
      }
    }
    throw new Error('No accounts available');
  }

  /**
   * Create a Stateless7702 smart account by signing and broadcasting
   * an EIP-7702 authorization transaction. The user's EOA address
   * becomes the smart account — no factory deployment or funding needed.
   *
   * @param chainId - The chain ID.
   * @returns The smart account configuration.
   */
  async function createStateless7702SmartAccount(
    chainId: number,
  ): Promise<SmartAccountConfig> {
    if (!providerVat) {
      throw new Error('Provider vat required for EIP-7702 authorization');
    }

    // Resolve EOA address: keyring first, then external signer.
    let eoaAddress: Address;
    try {
      eoaAddress = await resolveOwnerAddress();
    } catch {
      throw new Error('No accounts available for EIP-7702 smart account');
    }

    // Check if already set up (persisted from a prior call)
    if (
      smartAccountConfig?.implementation === 'stateless7702' &&
      smartAccountConfig.address === eoaAddress
    ) {
      return smartAccountConfig;
    }

    // Best-effort on-chain check — works on providers that support
    // EIP-7702 designator codes via eth_getCode (not all do, e.g. Infura).
    const code = (await E(providerVat).request('eth_getCode', [
      eoaAddress,
      'latest',
    ])) as string;

    if (isEip7702Delegated(code, chainId)) {
      smartAccountConfig = harden({
        implementation: 'stateless7702' as const,
        address: eoaAddress,
        deployed: true,
      });
      persistBaggage('smartAccountConfig', smartAccountConfig);
      return smartAccountConfig;
    }

    // EIP-7702 promotion requires signAuthorization which is only
    // available on the local keyring (not supported by external signers).
    if (!keyringVat || !(await E(keyringVat).hasKeys())) {
      throw new Error(
        'EIP-7702 promotion requires a local keyring with initialized keys. ' +
          'Use implementation: "hybrid", or promote the account through MetaMask first.',
      );
    }

    // Sign EIP-7702 authorization
    const env = resolveEnvironment(chainId);
    const implAddress = (
      env.implementations as Record<string, string | undefined>
    ).EIP7702StatelessDeleGatorImpl;
    if (!implAddress) {
      throw new Error(
        `EIP7702StatelessDeleGatorImpl not found in environment for chain ${String(chainId)}`,
      );
    }

    // Fetch the EOA nonce, gas fees, and sign the authorization in parallel.
    // EIP-7702 self-execution: the tx sender is the same EOA as the
    // authorization authority. The sender's nonce is incremented by the tx
    // validity check BEFORE authorizations are processed, so the
    // authorization nonce must be txNonce + 1.
    const EIP7702_FALLBACK_GAS = '0x19000' as Hex; // 102400
    // Minimum plausible gas for an EIP-7702 auth tx (~40k). Estimates
    // below this likely indicate the RPC ignored the authorizationList
    // and returned a plain-transfer estimate (21000).
    const EIP7702_MIN_GAS = 0xa000n; // 40960
    const [nonce, fees, estimatedAuthGas] = await Promise.all([
      E(providerVat).getNonce(eoaAddress),
      E(providerVat).getGasFees(),
      (
        E(providerVat).request('eth_estimateGas', [
          {
            from: eoaAddress,
            to: eoaAddress,
            authorizationList: [{ address: implAddress, chainId }],
          },
        ]) as Promise<Hex>
      ).then(
        (result) => {
          if (typeof result !== 'string' || !result.startsWith('0x')) {
            logger.warn(
              `eth_estimateGas returned non-hex for EIP-7702 auth: ${String(result)}, using fallback`,
            );
            return EIP7702_FALLBACK_GAS;
          }
          if (BigInt(result) < EIP7702_MIN_GAS) {
            logger.warn(
              `eth_estimateGas returned suspiciously low value ${result} for EIP-7702 auth, using fallback`,
            );
            return EIP7702_FALLBACK_GAS;
          }
          return result;
        },
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          // Only fall back when the RPC doesn't support authorizationList param
          if (
            message.includes('-32602') ||
            message.includes('-32601') ||
            message.includes('not supported') ||
            message.includes('unknown field')
          ) {
            logger.warn(
              'eth_estimateGas does not support authorizationList, using fallback gas',
            );
            return EIP7702_FALLBACK_GAS;
          }
          throw new Error(
            `eth_estimateGas failed for EIP-7702 authorization: ${message}`,
          );
        },
      ),
    ]);
    const authGasLimit = applyGasBuffer(estimatedAuthGas, 20);
    const signedAuth = await E(keyringVat).signAuthorization({
      contractAddress: implAddress as Address,
      chainId,
      nonce: nonce + 1,
    });

    const signedTx = await E(keyringVat).signTransaction({
      from: eoaAddress,
      to: eoaAddress,
      chainId,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      gasLimit: authGasLimit,
      authorizationList: [signedAuth],
    });

    const txHash = await E(providerVat).broadcastTransaction(signedTx);

    // Wait for the authorization tx to be mined. Some RPC providers (e.g.
    // Infura) don't expose EIP-7702 designator code via eth_getCode, so we
    // poll eth_getTransactionReceipt instead (status 0x1 = success).
    if (typeof globalThis.setTimeout !== 'function') {
      throw new Error(
        'EIP-7702 confirmation polling requires setTimeout ' +
          "(add the missing globals to this vat's globals in cluster-config.ts)",
      );
    }
    const maxAttempts = 45;
    for (let i = 0; i < maxAttempts; i++) {
      const receipt = (await E(providerVat).request(
        'eth_getTransactionReceipt',
        [txHash],
      )) as { status?: string } | null;
      if (receipt?.status === '0x1') {
        break;
      }
      if (receipt?.status === '0x0') {
        throw new Error(
          `EIP-7702 authorization tx ${txHash as string} reverted on-chain`,
        );
      }
      if (i === maxAttempts - 1) {
        throw new Error(
          `EIP-7702 authorization tx ${txHash} not confirmed after 90s`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    smartAccountConfig = harden({
      implementation: 'stateless7702' as const,
      address: eoaAddress,
      deployed: true,
    });
    persistBaggage('smartAccountConfig', smartAccountConfig);
    return smartAccountConfig;
  }

  // -------------------------------------------------------------------------
  // Routing helpers
  // -------------------------------------------------------------------------

  /**
   * Build a `redeemFn` closure for a given delegation.
   * Used by `makeDelegationTwin` to submit delegation redemptions.
   *
   * @param delegation - The delegation to redeem against.
   * @returns An async function that submits an execution as a delegation UserOp.
   */
  function makeRedeemFn(
    delegation: Delegation,
  ): (execution: Execution) => Promise<Hex> {
    return async (execution: Execution): Promise<Hex> => {
      if (bundlerConfig || smartAccountConfig) {
        return submitDelegationUserOp({ delegations: [delegation], execution });
      }
      if (homeCoordRef) {
        return E(homeCoordRef).redeemDelegation({ delegation, execution });
      }
      throw new Error(
        'Bundler not configured — cannot redeem delegation without bundler or smart account config',
      );
    };
  }

  /**
   * Rebuild the delegation sections from current redeemer grants.
   * Called after `receiveDelegation` or `connectToPeer`.
   */
  async function rebuildRouting(): Promise<void> {
    const grants = redeemerVat ? await E(redeemerVat).listGrants() : [];
    const currentIds = new Set(grants.map((grant) => grant.delegation.id));
    for (const id of delegationTwinMap.keys()) {
      if (!currentIds.has(id)) {
        delegationTwinMap.delete(id);
      }
    }
    for (const grant of grants) {
      if (!delegationTwinMap.has(grant.delegation.id)) {
        delegationTwinMap.set(
          grant.delegation.id,
          makeDelegationTwin({
            grant,
            redeemFn: makeRedeemFn(grant.delegation),
          }),
        );
      }
    }
    delegationSections = grants.map(
      (grant) =>
        delegationTwinMap.get(grant.delegation.id) as DelegationSection,
    );
  }

  // -------------------------------------------------------------------------
  // Exo (public API)
  // -------------------------------------------------------------------------

  const awayCoordinator = makeDefaultExo('awayCoordinator', {
    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Wire vat references and services. Called by the kernel during subcluster
     * bootstrap.
     *
     * @param vats - References to co-located vats.
     * @param services - External services available to this subcluster.
     */
    async bootstrap(vats: WalletVats, services: WalletServices): Promise<void> {
      keyringVat = vats.keyring as KeyringFacet | undefined;
      providerVat = vats.provider as ProviderFacet | undefined;
      redeemerVat = vats.redeemer as RedeemerFacet | undefined;
      redemptionService = services.ocapURLRedemptionService as
        | OcapURLRedemptionFacet
        | undefined;

      if (keyringVat) {
        persistBaggage('keyringVat', keyringVat);
      }
      if (providerVat) {
        persistBaggage('providerVat', providerVat);
      }
      if (redeemerVat) {
        persistBaggage('redeemerVat', redeemerVat);
      }

      logger.info('away bootstrap complete', {
        hasKeyring: Boolean(keyringVat),
        hasProvider: Boolean(providerVat),
        hasRedeemer: Boolean(redeemerVat),
      });

      // Rebuild routing from persisted state (e.g. after kernel restart).
      // homeSection is already restored from baggage; grants come from redeemerVat.
      if (redeemerVat || homeSection) {
        await rebuildRouting();
      }
    },

    // ------------------------------------------------------------------
    // Keyring
    // ------------------------------------------------------------------

    /**
     * Initialize the keyring vat with a seed phrase or a throwaway key.
     *
     * @param options - Keyring initialization options.
     * @param options.type - 'srp' for a seed phrase, 'throwaway' for ephemeral key.
     * @param options.mnemonic - BIP-39 mnemonic (srp only).
     * @param options.password - Encryption password (srp only).
     * @param options.salt - Encryption salt (srp only).
     * @param options.addressIndex - HD derivation index (srp only).
     */
    async initializeKeyring(options: {
      type: 'srp' | 'throwaway';
      mnemonic?: string;
      password?: string;
      salt?: string;
      addressIndex?: number;
    }): Promise<void> {
      if (!keyringVat) {
        throw new Error('Keyring vat not available');
      }
      if (options.type === 'throwaway') {
        await E(keyringVat).initialize(
          { type: 'throwaway' },
          undefined,
          options.salt,
        );
        return;
      }
      const initOptions: {
        type: 'srp';
        mnemonic: string;
        addressIndex?: number;
      } = {
        type: 'srp',
        mnemonic: options.mnemonic ?? '',
      };
      if (options.addressIndex !== undefined) {
        initOptions.addressIndex = options.addressIndex;
      }
      await E(keyringVat).initialize(
        initOptions,
        options.password,
        options.salt,
      );
    },

    /**
     * Unlock the keyring with the stored password.
     *
     * @param password - The decryption password.
     */
    async unlockKeyring(password: string): Promise<void> {
      if (!keyringVat) {
        throw new Error('Keyring vat not available');
      }
      await E(keyringVat).unlock(password);
    },

    /**
     * Check whether the keyring is currently locked.
     *
     * @returns True if the keyring is locked, false otherwise.
     */
    async isKeyringLocked(): Promise<boolean> {
      if (!keyringVat) {
        throw new Error('Keyring vat not available');
      }
      return E(keyringVat).isLocked();
    },

    // ------------------------------------------------------------------
    // Provider & bundler configuration
    // ------------------------------------------------------------------

    /**
     * Configure the JSON-RPC provider (sets RPC URL and chain ID).
     *
     * @param chainConfig - Chain configuration with RPC URL and chain ID.
     */
    async configureProvider(chainConfig: ChainConfig): Promise<void> {
      if (!providerVat) {
        throw new Error('Provider vat not available');
      }

      // Validate RPC URL (regex — URL constructor unavailable under SES)
      if (!/^https?:\/\/.+/u.test(chainConfig.rpcUrl)) {
        throw new Error(
          `Invalid RPC URL: "${chainConfig.rpcUrl}". Must be a valid HTTP(S) URL.`,
        );
      }

      if (!Number.isInteger(chainConfig.chainId) || chainConfig.chainId <= 0) {
        throw new Error(
          `Invalid chain ID: ${String(chainConfig.chainId)}. Must be a positive integer.`,
        );
      }

      await E(providerVat).configure(chainConfig);

      cachedProviderChainId = chainConfig.chainId;
      persistBaggage('cachedProviderChainId', cachedProviderChainId);
    },

    /**
     * Configure the ERC-4337 bundler for UserOp submission.
     *
     * @param config - Bundler configuration.
     * @param config.bundlerUrl - The bundler RPC URL.
     * @param config.entryPoint - EntryPoint contract address (defaults to v0.7).
     * @param config.chainId - The chain ID the bundler operates on.
     * @param config.usePaymaster - Whether to use paymaster sponsorship.
     * @param config.sponsorshipPolicyId - Paymaster policy ID for sponsored ops.
     * @param config.environment - Custom SDK environment for non-standard chains.
     * @param config.environment.EntryPoint - EntryPoint contract address.
     * @param config.environment.DelegationManager - DelegationManager contract address.
     * @param config.environment.SimpleFactory - SimpleFactory contract address.
     * @param config.environment.implementations - Map of implementation names to addresses.
     * @param config.environment.caveatEnforcers - Map of enforcer names to addresses.
     */
    async configureBundler(config: {
      bundlerUrl: string;
      entryPoint?: Hex;
      chainId: number;
      usePaymaster?: boolean;
      sponsorshipPolicyId?: string;
      environment?: {
        EntryPoint: Hex;
        DelegationManager: Hex;
        SimpleFactory: Hex;
        implementations: Record<string, Hex>;
        caveatEnforcers: Record<string, Hex>;
      };
    }): Promise<void> {
      // Validate bundler URL (regex — URL constructor unavailable under SES)
      if (!/^https?:\/\/.+/u.test(config.bundlerUrl)) {
        throw new Error(
          `Invalid bundler URL: "${config.bundlerUrl}". Must be a valid HTTP(S) URL.`,
        );
      }

      if (!Number.isInteger(config.chainId) || config.chainId <= 0) {
        throw new Error(
          `Invalid chain ID: ${String(config.chainId)}. Must be a positive integer.`,
        );
      }

      // Register a custom SDK environment for chains not in the SDK's built-in
      // registry (e.g. local Anvil at chain 31337).
      if (config.environment) {
        registerEnvironment(config.chainId, config.environment);
      }

      bundlerConfig = harden({
        bundlerUrl: config.bundlerUrl,
        entryPoint: config.entryPoint ?? ENTRY_POINT_V07,
        chainId: config.chainId,
        usePaymaster: config.usePaymaster,
        sponsorshipPolicyId: config.sponsorshipPolicyId,
        environment: config.environment,
      });
      persistBaggage('bundlerConfig', bundlerConfig);
      logger.info('bundler configured', {
        bundlerUrl: config.bundlerUrl,
        chainId: config.chainId,
        entryPoint: bundlerConfig.entryPoint,
        hasEnvironment: Boolean(config.environment),
      });

      if (!providerVat) {
        throw new Error(
          'Provider vat not available. Call configureProvider() before configureBundler().',
        );
      }
      await E(providerVat).configureBundler({
        bundlerUrl: config.bundlerUrl,
        chainId: config.chainId,
      });
    },

    /**
     * Connect an external signer (e.g. MetaMask) for transaction signing.
     *
     * @param signer - The external signer facet.
     */
    async connectExternalSigner(signer: ExternalSignerFacet): Promise<void> {
      if (!signer || typeof signer !== 'object') {
        throw new Error('Invalid external signer: must be a non-null object');
      }
      externalSigner = signer;
      persistBaggage('externalSigner', externalSigner);
    },

    // ------------------------------------------------------------------
    // Smart account configuration
    // ------------------------------------------------------------------

    /**
     * Create or restore a smart account configuration.
     *
     * @param config - Smart account creation options.
     * @param config.deploySalt - Optional deploy salt for counterfactual address derivation.
     * @param config.chainId - The chain ID the smart account is deployed on.
     * @param config.address - Optional explicit smart account address (skips derivation).
     * @param config.implementation - 'hybrid' (ERC-4337) or 'stateless7702' (EIP-7702).
     * @returns The smart account configuration including the derived address.
     */
    async createSmartAccount(config: {
      deploySalt?: Hex;
      chainId: number;
      address?: Address;
      implementation?: 'hybrid' | 'stateless7702';
    }): Promise<SmartAccountConfig> {
      const implementation = config.implementation ?? 'hybrid';

      if (implementation === 'stateless7702') {
        return createStateless7702SmartAccount(config.chainId);
      }

      // Hybrid path (existing logic)
      let { address } = config;
      let factory: Address | undefined;
      let factoryData: Hex | undefined;
      const deploySalt =
        config.deploySalt ??
        ('0x0000000000000000000000000000000000000000000000000000000000000001' as Hex);

      // Derive counterfactual address if not explicitly provided
      if (!address) {
        // Find the owner EOA from keyring or external signer
        let owner: Address;
        try {
          owner = await resolveOwnerAddress();
        } catch {
          throw new Error(
            'No owner account available to derive smart account address',
          );
        }

        const env = resolveEnvironment(config.chainId);
        factory = env.SimpleFactory;

        const derived = await computeSmartAccountAddress({
          owner,
          deploySalt,
          chainId: config.chainId,
        });
        address = derived.address;
        factoryData = derived.factoryData;
      }

      smartAccountConfig = harden({
        implementation: 'hybrid' as const,
        deploySalt,
        address,
        factory,
        factoryData,
        deployed: false,
      });
      persistBaggage('smartAccountConfig', smartAccountConfig);
      return smartAccountConfig;
    },

    /**
     * Return the smart account address, if one is configured.
     *
     * @returns The smart account address, or undefined.
     */
    async getSmartAccountAddress(): Promise<Address | undefined> {
      return smartAccountConfig?.address;
    },

    // ------------------------------------------------------------------
    // Public wallet API
    // ------------------------------------------------------------------

    /**
     * Return all locally available accounts (keyring + external signer).
     *
     * @returns Array of Ethereum addresses.
     */
    async getAccounts(): Promise<Address[]> {
      // Peer (home) accounts take priority — they are the identity visible to
      // the outside world. Local throwaway keys are exposed only via
      // getCapabilities().localAccounts, not here.
      if (homeCoordRef) {
        return E(homeCoordRef).getAccounts();
      }

      const localAccounts: Address[] = keyringVat
        ? await E(keyringVat).getAccounts()
        : [];

      const extAccounts: Address[] = externalSigner
        ? await E(externalSigner).getAccounts()
        : [];

      // Deduplicate by lowercasing
      const seen = new Set(localAccounts.map((a) => a.toLowerCase()));
      const merged = [...localAccounts];
      for (const account of extAccounts) {
        if (!seen.has(account.toLowerCase())) {
          seen.add(account.toLowerCase());
          merged.push(account);
        }
      }
      return merged;
    },

    /**
     * Sign a raw transaction using the local key (keyring or external signer).
     * Away coordinator has no peer wallet fallback for signing.
     *
     * @param tx - The transaction request to sign.
     * @returns The signed transaction as a hex string.
     */
    async signTransaction(tx: TransactionRequest): Promise<Hex> {
      return resolveTransactionSigning(tx);
    },

    /**
     * Sign an arbitrary message using the local key (keyring or external signer).
     *
     * @param message - The message to sign.
     * @returns The signature as a hex string.
     */
    async signMessage(message: string): Promise<Hex> {
      if (keyringVat) {
        const hasKeys = await E(keyringVat).hasKeys();
        if (hasKeys) {
          return E(keyringVat).signMessage(message);
        }
      }
      if (externalSigner) {
        const accounts = await E(externalSigner).getAccounts();
        if (accounts.length > 0) {
          return E(externalSigner).signMessage(message, accounts[0] as Address);
        }
      }
      if (homeCoordRef) {
        return E(homeCoordRef).signMessage(message);
      }
      throw new Error('No authority to sign message');
    },

    /**
     * Sign EIP-712 typed data using the local key (keyring or external signer).
     *
     * @param data - The EIP-712 typed data to sign.
     * @returns The signature as a hex string.
     */
    async signTypedData(data: Eip712TypedData): Promise<Hex> {
      return resolveTypedDataSigning(data);
    },

    /**
     * Send a transaction using the direct path only (no delegation matching).
     * Away's delegation routing goes through transferNative/transferFungible, not sendTransaction.
     *
     * @param tx - The transaction request.
     * @returns The transaction hash.
     */
    async sendTransaction(tx: TransactionRequest): Promise<Hex> {
      if (!providerVat) {
        throw new Error('Provider not configured');
      }
      logger.debug('sendTransaction (direct path only)', {
        from: tx.from,
        to: tx.to,
        value: tx.value,
        hasBundlerConfig: Boolean(bundlerConfig),
      });

      // Direct (non-delegation) send: estimate missing gas fields
      const filledTx = { ...tx };

      filledTx.nonce ??= await E(providerVat).getNonce(filledTx.from);
      filledTx.chainId ??= await E(providerVat).getChainId();
      if (!filledTx.maxFeePerGas || !filledTx.maxPriorityFeePerGas) {
        const fees = await E(providerVat).getGasFees();
        filledTx.maxFeePerGas ??= fees.maxFeePerGas;
        filledTx.maxPriorityFeePerGas ??= fees.maxPriorityFeePerGas;
      }
      filledTx.gasLimit ??= applyGasBuffer(
        validateGasEstimate(
          await E(providerVat).request('eth_estimateGas', [
            {
              from: filledTx.from,
              to: filledTx.to,
              value: filledTx.value,
              data: filledTx.data,
            },
          ]),
        ),
        10,
      );

      const signedTx = await resolveTransactionSigning(filledTx);
      return E(providerVat).broadcastTransaction(signedTx);
    },

    /**
     * Pass a JSON-RPC method call through to the provider vat.
     *
     * @param method - The JSON-RPC method name.
     * @param params - Optional method parameters.
     * @returns The raw RPC response.
     */
    async request(method: string, params?: unknown[]): Promise<unknown> {
      if (!providerVat) {
        throw new Error('Provider not configured');
      }
      return E(providerVat).request(method, params);
    },

    /**
     * Look up a transaction by hash. Tries the bundler first (in case the
     * hash is a UserOp hash from delegation redemption), then falls back
     * to a regular `eth_getTransactionReceipt` RPC call.
     *
     * @param hash - A UserOp hash or regular tx hash.
     * @returns An object with `txHash` and `receipt`, or null if not found.
     */
    async getTransactionReceipt(hash: Hex): Promise<{
      txHash: Hex;
      userOpHash?: Hex;
      success: boolean;
    } | null> {
      if (!providerVat) {
        throw new Error('Provider not configured');
      }

      // Try bundler first (UserOp hash)
      if (bundlerConfig) {
        try {
          const userOpReceipt = (await E(providerVat).getUserOpReceipt({
            bundlerUrl: bundlerConfig.bundlerUrl,
            userOpHash: hash,
          })) as {
            success: boolean;
            receipt?: { transactionHash?: string };
          } | null;

          if (userOpReceipt?.receipt?.transactionHash) {
            return harden({
              txHash: userOpReceipt.receipt.transactionHash as Hex,
              userOpHash: hash,
              success: userOpReceipt.success,
            });
          }
        } catch (error) {
          // Not a UserOp hash — fall through to regular RPC
          logger.debug(
            'UserOp receipt lookup failed, trying regular RPC',
            error,
          );
        }
      }

      // Try regular tx receipt
      const receipt = (await E(providerVat).request(
        'eth_getTransactionReceipt',
        [hash],
      )) as { status?: string; transactionHash?: string } | null;

      if (receipt?.transactionHash) {
        return harden({
          txHash: receipt.transactionHash as Hex,
          success: receipt.status === '0x1',
        });
      }

      return null;
    },

    /**
     * Poll for a UserOp receipt until it appears or the timeout elapses.
     *
     * @param options - Polling options.
     * @param options.userOpHash - The UserOp hash returned by the bundler.
     * @param options.pollIntervalMs - Delay between polls in milliseconds.
     * @param options.timeoutMs - Maximum time to wait in milliseconds.
     * @returns The raw receipt object from the bundler.
     */
    async waitForUserOpReceipt(options: {
      userOpHash: Hex;
      pollIntervalMs?: number;
      timeoutMs?: number;
    }): Promise<unknown> {
      if (!providerVat || !bundlerConfig) {
        throw new Error('Provider and bundler must be configured');
      }

      if (
        typeof globalThis.Date?.now !== 'function' ||
        typeof globalThis.setTimeout !== 'function'
      ) {
        throw new Error(
          'waitForUserOpReceipt requires Date.now and setTimeout ' +
            "(add the missing globals to this vat's globals in cluster-config.ts)",
        );
      }

      const interval = options.pollIntervalMs ?? 2000;
      const timeout = options.timeoutMs ?? 60000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        const receipt = await E(providerVat).getUserOpReceipt({
          bundlerUrl: bundlerConfig.bundlerUrl,
          userOpHash: options.userOpHash,
        });
        if (receipt !== null) {
          return receipt;
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
      throw new Error(
        `UserOp ${options.userOpHash} not found after ${timeout}ms`,
      );
    },

    /**
     * Poll until a regular EIP-1559 transaction is mined.
     * Prefer `waitForUserOpReceipt` for ERC-4337 UserOp hashes.
     *
     * @param options - Polling options.
     * @param options.txHash - Transaction hash to wait for.
     * @param options.pollIntervalMs - Delay between RPC polls in milliseconds.
     * @param options.timeoutMs - Maximum time to wait in milliseconds.
     * @returns Whether the mined transaction succeeded (`status` 0x1).
     */
    async waitForTransactionReceipt(options: {
      txHash: Hex;
      pollIntervalMs?: number;
      timeoutMs?: number;
    }): Promise<{ success: boolean }> {
      return pollTransactionReceipt(options);
    },

    // ------------------------------------------------------------------
    // ERC-20 token utilities
    // ------------------------------------------------------------------

    /**
     * Query the ERC-20 token balance for an owner address.
     *
     * @param options - Query options.
     * @param options.token - Token contract address.
     * @param options.owner - Account address to query.
     * @returns The balance as a decimal string.
     */
    async getTokenBalance(options: {
      token: Address;
      owner: Address;
    }): Promise<string> {
      if (!providerVat) {
        throw new Error('Provider not configured');
      }
      const callData = encodeBalanceOf(options.owner);
      const result = await E(providerVat).request('eth_call', [
        { to: options.token, data: callData },
        'latest',
      ]);
      const validated = validateTokenCallResult(
        result,
        'balanceOf',
        options.token,
      );
      return decodeBalanceOfResult(validated).toString();
    },

    /**
     * Query the name, symbol, and decimals of an ERC-20 token.
     *
     * @param options - Query options.
     * @param options.token - Token contract address.
     * @returns An object with name, symbol, and decimals.
     */
    async getTokenMetadata(options: {
      token: Address;
    }): Promise<{ name: string; symbol: string; decimals: number }> {
      if (!providerVat) {
        throw new Error('Provider not configured');
      }
      const [nameSettled, symbolSettled, decimalsSettled] =
        await Promise.allSettled([
          E(providerVat).request('eth_call', [
            { to: options.token, data: encodeName() },
            'latest',
          ]),
          E(providerVat).request('eth_call', [
            { to: options.token, data: encodeSymbol() },
            'latest',
          ]),
          E(providerVat).request('eth_call', [
            { to: options.token, data: encodeDecimals() },
            'latest',
          ]),
        ]);

      // decimals is mandatory — wrong decimals causes financial errors
      if (decimalsSettled.status === 'rejected') {
        throw new Error(
          `decimals() call failed for token ${options.token}: ${
            decimalsSettled.reason instanceof Error
              ? decimalsSettled.reason.message
              : String(decimalsSettled.reason)
          }`,
        );
      }

      // name and symbol are optional in ERC-20; fall back gracefully
      let name = 'Unknown';
      if (nameSettled.status === 'fulfilled') {
        try {
          name = decodeNameResult(
            validateTokenCallResult(nameSettled.value, 'name', options.token),
          );
        } catch {
          // name() not implemented or returned invalid data
        }
      }

      let symbol = 'Unknown';
      if (symbolSettled.status === 'fulfilled') {
        try {
          symbol = decodeSymbolResult(
            validateTokenCallResult(
              symbolSettled.value,
              'symbol',
              options.token,
            ),
          );
        } catch {
          // symbol() not implemented or returned invalid data
        }
      }

      return harden({
        name,
        symbol,
        decimals: decodeDecimalsResult(
          validateTokenCallResult(
            decimalsSettled.value,
            'decimals',
            options.token,
          ),
        ),
      });
    },

    // ------------------------------------------------------------------
    // Semantic wallet API
    // ------------------------------------------------------------------

    /**
     * Transfer native ETH.
     * Tries each matching delegation twin in order; the first success is
     * returned. If all matched twins fail, throws with all collected errors
     * as the cause array; does not fall through to the home section.
     *
     * @param to - Recipient address.
     * @param amount - Amount in wei.
     * @returns The transaction hash.
     */
    async transferNative(
      to: Address,
      amount: string | number | bigint,
    ): Promise<Hex> {
      // Coerce at the JSON boundary — CLI callers pass numeric strings.
      const amt = BigInt(amount);
      const matching = delegationSections.filter(
        (
          sec,
        ): sec is Extract<DelegationSection, { method: 'transferNative' }> =>
          sec.method === 'transferNative',
      );
      if (matching.length > 0) {
        const errors: unknown[] = [];
        for (const section of matching) {
          try {
            return await E(section.exo).transferNative(to, amt);
          } catch (error) {
            errors.push(error);
          }
        }
        throw new Error(
          `All delegation twins failed: ${errors
            .map((cause) =>
              cause instanceof Error ? cause.message : String(cause),
            )
            .join('; ')}`,
          { cause: errors },
        );
      }
      if (homeSection) {
        return E(homeSection).transferNative(to, amt);
      }
      throw new Error(
        'No routing available — call connectToPeer first or receive a delegation',
      );
    },

    /**
     * Transfer ERC-20 tokens.
     * Tries each matching delegation twin in order; the first success is
     * returned. If all matched twins fail, throws with all collected errors
     * as the cause array; does not fall through to the home section.
     *
     * @param token - ERC-20 token contract address.
     * @param to - Recipient address.
     * @param amount - Amount in token units.
     * @returns The transaction hash.
     */
    async transferFungible(
      token: Address,
      to: Address,
      amount: string | number | bigint,
    ): Promise<Hex> {
      // Coerce at the JSON boundary — CLI callers pass numeric strings.
      const amt = BigInt(amount);
      const tokenLower = token.toLowerCase() as Address;
      const matching = delegationSections.filter(
        (
          sec,
        ): sec is Extract<DelegationSection, { method: 'transferFungible' }> =>
          sec.method === 'transferFungible' && sec.token === tokenLower,
      );
      if (matching.length > 0) {
        const errors: unknown[] = [];
        for (const section of matching) {
          try {
            return await E(section.exo).transferFungible(tokenLower, to, amt);
          } catch (error) {
            errors.push(error);
          }
        }
        throw new Error(
          `All delegation twins failed: ${errors
            .map((cause) =>
              cause instanceof Error ? cause.message : String(cause),
            )
            .join('; ')}`,
          { cause: errors },
        );
      }
      if (homeSection) {
        return E(homeSection).transferFungible(token, to, amt);
      }
      throw new Error(
        'No routing available — call connectToPeer first or receive a delegation',
      );
    },

    /**
     * Receive a delegation grant from home and persist it to the redeemer vat.
     * Rebuilds the delegation sections to incorporate the new grant.
     *
     * @param grant - The semantic delegation grant to store.
     */
    async receiveDelegation(grant: DelegationGrant): Promise<void> {
      if (!redeemerVat) {
        throw new Error('Redeemer vat not available');
      }
      await E(redeemerVat).receiveGrant(grant);
      await rebuildRouting();
    },

    /**
     * List all delegation grants stored in the redeemer vat.
     *
     * @returns An array of all DelegationGrant objects received on this device.
     */
    async listGrants(): Promise<DelegationGrant[]> {
      if (!redeemerVat) {
        return [];
      }
      return E(redeemerVat).listGrants();
    },

    /**
     * Connect to the home coordinator via an OCAP URL.
     * Redeems the URL to obtain a remote reference to the home coordinator,
     * then fetches the home section exo for the call-home fallback path.
     * Persists homeCoordRef and homeSection and rebuilds routing.
     *
     * @param ocapUrl - The OCAP URL issued by the home coordinator.
     */
    async connectToPeer(ocapUrl: string): Promise<void> {
      if (!redemptionService) {
        throw new Error('OCAP URL redemption service not available');
      }
      homeCoordRef = (await E(redemptionService).redeem(
        ocapUrl,
      )) as HomeCoordinatorRef;
      homeSection = await E(homeCoordRef).getHomeSection();
      persistBaggage('homeCoordRef', homeCoordRef);
      persistBaggage('homeSection', homeSection);
      await rebuildRouting();
    },

    /**
     * Refresh cached peer accounts from the home coordinator.
     * No-op if no home coordinator connection has been established.
     */
    async refreshPeerAccounts(): Promise<void> {
      if (!homeCoordRef) {
        return;
      }
      await E(homeCoordRef).getAccounts();
    },

    /**
     * Register this device's delegate address on the home coordinator.
     * Called after connecting to the peer to allow the home coordinator to
     * record the away wallet's on-chain delegate address.
     *
     * @param address - The away wallet's delegate address (0x-prefixed).
     */
    async sendDelegateAddressToPeer(address: string): Promise<void> {
      if (!homeCoordRef) {
        throw new Error('Not connected to a peer — call connectToPeer first');
      }
      await E(homeCoordRef).registerDelegateAddress(address);
    },

    // ------------------------------------------------------------------
    // Introspection
    // ------------------------------------------------------------------

    /**
     * Return a summary of the away coordinator's current capabilities.
     * Reflects away-side state: local key, bundler, smart account, grants
     * count (from redeemerVat), and whether homeSection is wired.
     *
     * @returns A WalletCapabilities object describing current state.
     */
    async getCapabilities(): Promise<WalletCapabilities> {
      const hasLocalKeys = keyringVat ? await E(keyringVat).hasKeys() : false;
      const localAccounts: Address[] = keyringVat
        ? await E(keyringVat).getAccounts()
        : [];
      const grants = redeemerVat ? await E(redeemerVat).listGrants() : [];

      let signingMode = 'none';
      if (externalSigner) {
        signingMode = 'external:metamask';
      } else if (hasLocalKeys) {
        signingMode = 'local';
      }

      let autonomy = 'no signing authority';
      if (grants.length > 0) {
        // Describe any native ETH amount limits in human-readable form.
        const limitParts: string[] = grants
          .filter(
            (grant): grant is TransferNativeGrant =>
              grant.method === 'transferNative' &&
              grant.maxAmount !== undefined,
          )
          .map(
            (grant) =>
              `max ${weiToEth(`0x${BigInt(grant.maxAmount ?? 0n).toString(16)}`)} per tx`,
          );
        const limitSuffix =
          limitParts.length > 0 ? ` (${limitParts.join('; ')})` : '';
        autonomy = `autonomous via ${grants.length} delegation(s)${limitSuffix}`;
      } else if (homeSection) {
        autonomy = 'call-home (no delegations)';
      }

      let capabilityChainId: number | undefined;
      try {
        capabilityChainId = await resolveChainId();
      } catch {
        // ignore — chain ID may not be configured yet
      }

      return harden({
        hasLocalKeys,
        localAccounts,
        delegationCount: grants.length,
        hasPeerWallet: homeSection !== undefined,
        hasExternalSigner: externalSigner !== undefined,
        hasBundlerConfig: bundlerConfig !== undefined,
        smartAccountAddress: smartAccountConfig?.address,
        chainId: capabilityChainId,
        signingMode,
        autonomy,
      });
    },
  });

  return awayCoordinator;
}
