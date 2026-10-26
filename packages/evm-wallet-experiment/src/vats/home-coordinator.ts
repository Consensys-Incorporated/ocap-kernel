import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';
import { makeDiscoverableExo } from '@metamask/kernel-utils/discoverable';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import { Logger } from '@metamask/logger';
import type { Baggage } from '@metamask/ocap-kernel';
import type { SignedAuthorization } from 'viem';

import {
  ENFORCER_CONTRACT_KEY_MAP,
  PLACEHOLDER_CONTRACTS,
  getChainContracts,
  registerChainContracts,
} from '../constants.ts';
import type { ChainContracts } from '../constants.ts';
import {
  prepareDelegationTypedData,
  finalizeDelegation,
} from '../lib/delegation.ts';
import {
  decodeAllowanceResult,
  decodeBalanceOfResult,
  decodeDecimalsResult,
  decodeNameResult,
  decodeSymbolResult,
  encodeAllowance,
  encodeBalanceOf,
  encodeDecimals,
  encodeName,
  encodeSymbol,
  encodeTransfer,
} from '../lib/erc20.ts';
import { METHOD_CATALOG } from '../lib/method-catalog.ts';
import {
  buildBatchExecuteCallData,
  buildSdkDisableCallData,
  buildSdkRedeemCallData,
  computeSmartAccountAddress,
  isEip7702Delegated,
  prepareUserOpTypedData,
  registerEnvironment,
  resolveEnvironment,
  setSdkLogger,
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
  SwapQuote,
  SwapResult,
  TransactionRequest,
  TransferFungibleGrant,
  TransferNativeGrant,
  UserOperation,
  WalletCapabilities,
} from '../types.ts';

const harden = globalThis.harden ?? (<T>(value: T): T => value);

// ---------------------------------------------------------------------------
// Vat types
// ---------------------------------------------------------------------------

/**
 * Vat powers for the home coordinator vat.
 */
type VatPowers = {
  logger?: Logger;
};

/**
 * Vat references available in the home wallet subcluster.
 */
type WalletVats = {
  keyring?: unknown;
  provider?: unknown;
  delegator?: unknown;
};

/**
 * Services available to the home wallet subcluster.
 */
type WalletServices = {
  ocapURLIssuerService?: unknown;
  ocapURLRedemptionService?: unknown;
};

// ---------------------------------------------------------------------------
// Facet types (typed remote references for E() calls)
// ---------------------------------------------------------------------------

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

type OcapURLIssuerFacet = {
  issue: (target: unknown) => Promise<string>;
};

type DelegatorFacet = {
  buildTransferNativeGrant: (options: {
    delegator: Address;
    delegate: Address;
    to?: Address;
    maxAmount?: bigint | undefined;
    totalLimit?: bigint | undefined;
    chainId: number;
  }) => Promise<TransferNativeGrant>;
  buildTransferFungibleGrant: (options: {
    delegator: Address;
    delegate: Address;
    token: Address;
    to?: Address;
    totalLimit?: bigint | undefined;
    chainId: number;
  }) => Promise<TransferFungibleGrant>;
  storeGrant: (grant: DelegationGrant) => Promise<void>;
  removeGrant: (id: string) => Promise<void>;
  listGrants: () => Promise<DelegationGrant[]>;
  registerContracts: (
    chainId: number,
    environment: {
      DelegationManager: Hex;
      caveatEnforcers?: Record<string, Hex>;
    },
  ) => Promise<void>;
};

// ---------------------------------------------------------------------------
// buildRootObject — home coordinator vat entry point
// ---------------------------------------------------------------------------

/**
 * Build the root object for the home coordinator vat.
 *
 * The home coordinator owns the keyring, provider, and external signer.
 * It manages delegation grant creation (signing + storing) and exposes a
 * homeSection exo for the away coordinator's call-home path.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param _parameters - Initialization parameters (role: 'home').
 * @param baggage - Root of vat's persistent state.
 * @returns The root object for the home coordinator vat.
 */
export function buildRootObject(
  vatPowers: VatPowers,
  _parameters: unknown,
  baggage: Baggage,
): object {
  const logger = (vatPowers.logger ?? new Logger()).subLogger({
    tags: ['home-coordinator-vat'],
  });

  // Wire SDK logger so resolveEnvironment/registerEnvironment are visible
  setSdkLogger((level, message, data) => {
    if (level === 'info') {
      logger.info(message, data);
    } else {
      logger.debug(message, data);
    }
  });

  // References to other vats (set during bootstrap)
  let keyringVat: KeyringFacet | undefined;
  let providerVat: ProviderFacet | undefined;
  let delegatorVat: DelegatorFacet | undefined;

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

  // OcapURL service references
  let issuerService: OcapURLIssuerFacet | undefined;

  // Away wallet's delegate address, registered via registerDelegateAddress
  let delegateAddress: string | undefined;

  /**
   * Typed helper for restoring values from baggage (resuscitation).
   *
   * @param key - The baggage key to look up.
   * @returns The stored value cast to T, or undefined if not present.
   */
  function restoreFromBaggage<T>(key: string): T | undefined {
    return baggage.has(key) ? (baggage.get(key) as T) : undefined;
  }

  // Restore vat references from baggage if available (resuscitation)
  keyringVat = restoreFromBaggage<KeyringFacet>('keyringVat');
  providerVat = restoreFromBaggage<ProviderFacet>('providerVat');
  delegatorVat = restoreFromBaggage<DelegatorFacet>('delegatorVat');
  externalSigner = restoreFromBaggage<ExternalSignerFacet>('externalSigner');
  bundlerConfig = restoreFromBaggage<typeof bundlerConfig>('bundlerConfig');
  if (bundlerConfig?.environment) {
    registerEnvironment(bundlerConfig.chainId, bundlerConfig.environment);
    // Re-register chain contracts so signDelegationInGrant can find the
    // DelegationManager address after a kernel restart (resuscitation).
    const rawEnforcers = bundlerConfig.environment.caveatEnforcers ?? {};
    const restoredEnforcers = { ...PLACEHOLDER_CONTRACTS.enforcers };
    for (const [key, addr] of Object.entries(rawEnforcers)) {
      const caveatType = ENFORCER_CONTRACT_KEY_MAP[key];
      if (caveatType !== undefined) {
        restoredEnforcers[caveatType] = addr;
      }
    }
    registerChainContracts(bundlerConfig.chainId, {
      delegationManager: bundlerConfig.environment.DelegationManager,
      enforcers: restoredEnforcers,
    } as ChainContracts);
  }
  smartAccountConfig =
    restoreFromBaggage<SmartAccountConfig>('smartAccountConfig');
  delegateAddress = restoreFromBaggage<string>('delegateAddress');

  /** Chain ID from the last `configureProvider` call (avoids RPC on every send). */
  let cachedProviderChainId: number | undefined = restoreFromBaggage<number>(
    'cachedProviderChainId',
  );

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
    maxFeePerGas?: Hex;
    maxPriorityFeePerGas?: Hex;
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
   * Resolve the signing strategy for typed data.
   * Priority: keyring → external signer → error
   *
   * @param data - The EIP-712 typed data to sign.
   * @param from - Optional sender address.
   * @returns The signature as a hex string.
   */
  async function resolveTypedDataSigning(
    data: Eip712TypedData,
    from?: Address,
  ): Promise<Hex> {
    if (keyringVat) {
      const hasKeys = await E(keyringVat).hasKeys();
      if (hasKeys) {
        return E(keyringVat).signTypedData(data, from);
      }
    }

    if (externalSigner) {
      const accounts = await E(externalSigner).getAccounts();
      if (accounts.length > 0) {
        return E(externalSigner).signTypedData(
          data,
          from ?? (accounts[0] as Address),
        );
      }
    }

    throw new Error('No authority to sign typed data');
  }

  /**
   * Resolve the signing strategy for a personal message.
   * Priority: keyring → external signer → error
   *
   * @param message - The message to sign.
   * @param from - Optional sender address.
   * @returns The signature as a hex string.
   */
  async function resolveMessageSigning(
    message: string,
    from?: Address,
  ): Promise<Hex> {
    if (keyringVat) {
      const hasKeys = await E(keyringVat).hasKeys();
      if (hasKeys) {
        return E(keyringVat).signMessage(message, from);
      }
    }

    if (externalSigner) {
      const accounts = await E(externalSigner).getAccounts();
      if (accounts.length > 0) {
        return E(externalSigner).signMessage(
          message,
          from ?? (accounts[0] as Address),
        );
      }
    }

    throw new Error('No authority to sign message');
  }

  /**
   * Resolve the signing strategy for a transaction.
   * Priority: local key → external signer → reject
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
   * Build, sign, and submit a UserOp. Shared pipeline for both direct
   * smart account operations and on-chain delegation revocation.
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
   * Submit a transaction that calls `DelegationManager.disableDelegation` to
   * revoke a delegation on-chain — either via a direct EIP-1559 tx (7702) or
   * an ERC-4337 UserOp (hybrid).
   *
   * @param delegation - The delegation to disable.
   * @returns The hash and whether the direct 7702 path was used.
   */
  async function submitDisableUserOp(
    delegation: Delegation,
  ): Promise<{ hash: Hex; isDirect: boolean }> {
    const sender = smartAccountConfig?.address ?? delegation.delegator;

    const chainId = await resolveChainId();
    const disableCallData = buildSdkDisableCallData({
      delegation,
      chainId,
    });

    try {
      const isDirect = await useDirect7702Tx(sender);
      if (isDirect) {
        const hash = await buildAndSubmitDirect7702Tx({
          sender,
          callData: disableCallData,
        });
        return { hash, isDirect: true };
      }
      if (!bundlerConfig) {
        throw new Error(
          'Bundler not configured (required for hybrid on-chain revocation)',
        );
      }
      const hash = await buildAndSubmitUserOp({
        sender,
        callData: disableCallData,
      });
      return { hash, isDirect: false };
    } catch (error) {
      throw new Error(
        `Failed to submit on-chain revocation for delegator ${delegation.delegator}`,
        { cause: error },
      );
    }
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

  /**
   * Sign the delegation inside an unsigned grant and return the grant with the
   * delegation's signature field filled in.
   *
   * Resolves the DelegationManager verifying contract from the chain's registered
   * contracts (see {@link getChainContracts}), prepares EIP-712 typed data, and
   * signs via keyring or external signer.
   *
   * @param unsignedGrant - A grant whose `delegation.signature` is undefined.
   * @returns The same grant with `delegation.signature` set and `delegation.status` 'signed'.
   */
  async function signDelegationInGrant<T extends DelegationGrant>(
    unsignedGrant: T,
  ): Promise<T> {
    const { delegation } = unsignedGrant;

    // Resolve the DelegationManager address for this chain
    const contracts = getChainContracts(delegation.chainId);
    const verifyingContract = contracts.delegationManager;

    const typedData = prepareDelegationTypedData({
      delegation,
      verifyingContract,
    });

    const signature = await resolveTypedDataSigning(typedData);

    const signedDelegation = finalizeDelegation(delegation, signature);

    return harden({
      ...unsignedGrant,
      delegation: signedDelegation,
    });
  }

  // ---------------------------------------------------------------------------
  // homeSection exo — built once, after all internal functions are defined
  // ---------------------------------------------------------------------------

  const homeSection = makeDiscoverableExo(
    'HomeWallet',
    {
      async transferNative(to: Address, amount: bigint): Promise<Hex> {
        const from = await resolveOwnerAddress();
        const amountHex: Hex = `0x${amount.toString(16)}`;
        if (!providerVat) {
          throw new Error('Provider not configured');
        }
        const chainId = await resolveChainId();
        const nonce = await E(providerVat).getNonce(from);
        const fees = await E(providerVat).getGasFees();
        const estimatedGas = validateGasEstimate(
          await E(providerVat).request('eth_estimateGas', [
            { from, to, value: amountHex },
          ]),
        );
        const gasLimit = applyGasBuffer(estimatedGas, 10);
        const tx: TransactionRequest = {
          from,
          to,
          chainId,
          nonce,
          value: amountHex,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          gasLimit,
          data: '0x' as Hex,
        };
        const signed = await resolveTransactionSigning(tx);
        return E(providerVat).broadcastTransaction(signed);
      },

      async transferFungible(
        token: Address,
        to: Address,
        amount: bigint,
      ): Promise<Hex> {
        const from = await resolveOwnerAddress();
        if (!providerVat) {
          throw new Error('Provider not configured');
        }
        const callData = encodeTransfer(to, amount);
        const chainId = await resolveChainId();
        const nonce = await E(providerVat).getNonce(from);
        const fees = await E(providerVat).getGasFees();
        const estimatedGas = validateGasEstimate(
          await E(providerVat).request('eth_estimateGas', [
            { from, to: token, data: callData, value: '0x0' },
          ]),
        );
        const gasLimit = applyGasBuffer(estimatedGas, 10);
        const tx: TransactionRequest = {
          from,
          to: token,
          chainId,
          nonce,
          value: '0x0' as Hex,
          data: callData,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          gasLimit,
        };
        const signed = await resolveTransactionSigning(tx);
        return E(providerVat).broadcastTransaction(signed);
      },
    },
    {
      transferNative: METHOD_CATALOG.transferNative,
      transferFungible: METHOD_CATALOG.transferFungible,
    },
    M.interface(
      'HomeWallet',
      {
        transferNative: M.callWhen(M.string(), M.bigint()).returns(M.string()),
        transferFungible: M.callWhen(
          M.string(),
          M.string(),
          M.bigint(),
        ).returns(M.string()),
      },
      { defaultGuards: 'passable' },
    ),
  );

  // ---------------------------------------------------------------------------
  // Public exo — the home coordinator's exported interface
  // ---------------------------------------------------------------------------

  const homeCoordinator = makeDefaultExo('walletHomeCoordinator', {
    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    async bootstrap(vats: WalletVats, services: WalletServices): Promise<void> {
      keyringVat = vats.keyring as KeyringFacet | undefined;
      providerVat = vats.provider as ProviderFacet | undefined;
      delegatorVat = vats.delegator as DelegatorFacet | undefined;
      issuerService = services.ocapURLIssuerService as
        | OcapURLIssuerFacet
        | undefined;

      if (keyringVat) {
        persistBaggage('keyringVat', keyringVat);
      }
      if (providerVat) {
        persistBaggage('providerVat', providerVat);
      }
      if (delegatorVat) {
        persistBaggage('delegatorVat', delegatorVat);
      }
      // On resuscitation, propagate bundler environment to delegator-vat so
      // its isolated module-level Map has the chain contracts it needs.
      if (delegatorVat && bundlerConfig?.environment) {
        await E(delegatorVat).registerContracts(
          bundlerConfig.chainId,
          bundlerConfig.environment,
        );
      }

      logger.info('bootstrap complete', {
        hasKeyring: Boolean(keyringVat),
        hasProvider: Boolean(providerVat),
        hasDelegator: Boolean(delegatorVat),
      });
    },

    // ------------------------------------------------------------------
    // Wallet initialization
    // ------------------------------------------------------------------

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

    async unlockKeyring(password: string): Promise<void> {
      if (!keyringVat) {
        throw new Error('Keyring vat not available');
      }
      await E(keyringVat).unlock(password);
    },

    async isKeyringLocked(): Promise<boolean> {
      if (!keyringVat) {
        throw new Error('Keyring vat not available');
      }
      return E(keyringVat).isLocked();
    },

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

    // ------------------------------------------------------------------
    // External signer & bundler configuration
    // ------------------------------------------------------------------

    async connectExternalSigner(signer: ExternalSignerFacet): Promise<void> {
      if (!signer || typeof signer !== 'object') {
        throw new Error('Invalid external signer: must be a non-null object');
      }
      externalSigner = signer;
      persistBaggage('externalSigner', externalSigner);
    },

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

        // Also register in our own getChainContracts() registry so that
        // signDelegationInGrant() can find the DelegationManager for this chain.
        const rawEnforcers = config.environment.caveatEnforcers ?? {};
        const enforcers = { ...PLACEHOLDER_CONTRACTS.enforcers };
        for (const [key, addr] of Object.entries(rawEnforcers)) {
          const caveatType = ENFORCER_CONTRACT_KEY_MAP[key];
          if (caveatType !== undefined) {
            enforcers[caveatType] = addr;
          }
        }
        registerChainContracts(config.chainId, {
          delegationManager: config.environment.DelegationManager,
          enforcers,
        } as ChainContracts);

        // Propagate to the delegator vat so its module-level Map is also
        // populated (each vat has isolated module state).
        if (delegatorVat) {
          await E(delegatorVat).registerContracts(
            config.chainId,
            config.environment,
          );
        }
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

    // ------------------------------------------------------------------
    // Smart account configuration
    // ------------------------------------------------------------------

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

    async getSmartAccountAddress(): Promise<Address | undefined> {
      return smartAccountConfig?.address;
    },

    // ------------------------------------------------------------------
    // Public wallet API
    // ------------------------------------------------------------------

    async getAccounts(): Promise<Address[]> {
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

    async signTransaction(tx: TransactionRequest): Promise<Hex> {
      return resolveTransactionSigning(tx);
    },

    async sendTransaction(tx: TransactionRequest): Promise<Hex> {
      if (!providerVat) {
        throw new Error('Provider not configured');
      }
      logger.debug('sendTransaction', {
        from: tx.from,
        to: tx.to,
        value: tx.value,
        hasBundlerConfig: Boolean(bundlerConfig),
      });

      // Home sends direct transactions only — no delegation routing.
      logger.debug('sendTransaction: using direct send');

      // Estimate missing gas fields for direct (non-delegation) sends
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

    async sendBatchTransaction(
      txs: TransactionRequest[],
    ): Promise<Hex | Hex[]> {
      if (txs.length === 0) {
        throw new Error('No transactions to send');
      }

      if (txs.length === 1) {
        return homeCoordinator.sendTransaction(txs[0] as TransactionRequest);
      }

      if (!providerVat) {
        throw new Error('Provider not configured');
      }

      const batchSender =
        smartAccountConfig?.address ?? (await homeCoordinator.getAccounts())[0];

      // Cache the predicate result — useDirect7702Tx is impure (eth_getCode)
      // and must not be called twice for the same sender.
      const isDirect7702Batch =
        batchSender !== undefined &&
        smartAccountConfig?.implementation === 'stateless7702' &&
        (await useDirect7702Tx(batchSender));

      // Home batches smart account txs directly — no delegation batch path.
      const useSmartAccountBatchPath =
        bundlerConfig !== undefined || isDirect7702Batch;

      if (useSmartAccountBatchPath) {
        const executions: Execution[] = txs.map((tx) => ({
          target: tx.to,
          value: tx.value ?? ('0x0' as Hex),
          callData: tx.data ?? ('0x' as Hex),
        }));

        const sender = batchSender;
        if (!sender) {
          throw new Error('No accounts available for batch');
        }

        const callData = buildBatchExecuteCallData({ executions });
        if (isDirect7702Batch) {
          return buildAndSubmitDirect7702Tx({ sender, callData });
        }
        if (!bundlerConfig) {
          throw new Error(
            'Non-delegation batch execution requires a bundler or direct 7702',
          );
        }
        return buildAndSubmitUserOp({ sender, callData });
      }

      // EOA fallback: execute sequentially
      const hashes: Hex[] = [];
      for (const tx of txs) {
        hashes.push(await homeCoordinator.sendTransaction(tx));
      }
      return hashes;
    },

    async signTypedData(data: Eip712TypedData, from?: Address): Promise<Hex> {
      return resolveTypedDataSigning(data, from);
    },

    async signMessage(message: string, account?: Address): Promise<Hex> {
      return resolveMessageSigning(message, account);
    },

    async request(method: string, params?: unknown[]): Promise<unknown> {
      if (!providerVat) {
        throw new Error('Provider not configured');
      }
      return E(providerVat).request(method, params);
    },

    /**
     * Look up a transaction by hash. Tries the bundler first (in case the
     * hash is a UserOp hash from a smart account operation), then falls back
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

    // ------------------------------------------------------------------
    // Delegation grant management (via delegator vat)
    // ------------------------------------------------------------------

    /**
     * Build, sign, and store a TransferNative delegation grant.
     *
     * Calls the delegator vat to construct the unsigned delegation, signs it
     * locally with the available keyring or external signer, then stores the
     * signed grant back in the delegator vat.
     *
     * @param options - Grant construction options.
     * @param options.delegate - The delegate address.
     * @param options.to - Optional restricted recipient.
     * @param options.maxAmount - Optional per-call ETH value limit (wei).
     * @param options.totalLimit - Optional cumulative ETH transfer cap (wei).
     * @param options.chainId - The chain ID.
     * @returns The signed TransferNativeGrant.
     */
    async buildTransferNativeGrant(options: {
      delegate: Address;
      to?: Address;
      maxAmount?: bigint | string;
      totalLimit?: bigint | string;
      chainId: number;
    }): Promise<TransferNativeGrant> {
      if (!delegatorVat) {
        throw new Error('Delegator vat not available');
      }
      const delegator =
        smartAccountConfig?.address ?? (await resolveOwnerAddress());
      const maxAmount =
        options.maxAmount === undefined ? undefined : BigInt(options.maxAmount);
      const totalLimit =
        options.totalLimit === undefined
          ? undefined
          : BigInt(options.totalLimit);
      const unsignedGrant = await E(delegatorVat).buildTransferNativeGrant({
        delegator,
        ...options,
        maxAmount,
        totalLimit,
      });
      const signedGrant = await signDelegationInGrant(unsignedGrant);
      await E(delegatorVat).storeGrant(signedGrant);
      return signedGrant;
    },

    /**
     * Build, sign, and store a TransferFungible delegation grant.
     *
     * Calls the delegator vat to construct the unsigned delegation, signs it
     * locally with the available keyring or external signer, then stores the
     * signed grant back in the delegator vat.
     *
     * @param options - Grant construction options.
     * @param options.delegate - The delegate address.
     * @param options.token - The ERC-20 token contract address.
     * @param options.to - Optional restricted recipient.
     * @param options.totalLimit - Optional cumulative transfer cap (token units).
     * @param options.chainId - The chain ID.
     * @returns The signed TransferFungibleGrant.
     */
    async buildTransferFungibleGrant(options: {
      delegate: Address;
      token: Address;
      to?: Address;
      totalLimit?: bigint | string;
      chainId: number;
    }): Promise<TransferFungibleGrant> {
      if (!delegatorVat) {
        throw new Error('Delegator vat not available');
      }
      const delegator =
        smartAccountConfig?.address ?? (await resolveOwnerAddress());
      const totalLimit =
        options.totalLimit === undefined
          ? undefined
          : BigInt(options.totalLimit);
      const unsignedGrant = await E(delegatorVat).buildTransferFungibleGrant({
        delegator,
        ...options,
        totalLimit,
      });
      const signedGrant = await signDelegationInGrant(unsignedGrant);
      await E(delegatorVat).storeGrant(signedGrant);
      return signedGrant;
    },

    /**
     * List all delegation grants stored in the delegator vat.
     *
     * @returns An array of all DelegationGrant objects.
     */
    async listGrants(): Promise<DelegationGrant[]> {
      if (!delegatorVat) {
        throw new Error('Delegator vat not available');
      }
      return E(delegatorVat).listGrants();
    },

    /**
     * Revoke a delegation grant on-chain and remove it from the delegator vat.
     *
     * Submits an on-chain `disableDelegation` call (either via direct EIP-1559
     * or ERC-4337 UserOp depending on the smart account type), waits for
     * confirmation, then removes the grant from the delegator vat.
     *
     * @param id - The delegation ID to revoke.
     * @returns The transaction or UserOp hash of the on-chain revocation.
     */
    async revokeGrant(id: string): Promise<Hex> {
      if (!delegatorVat) {
        throw new Error('Delegator vat not available');
      }

      // Find the grant by id
      const grants = await E(delegatorVat).listGrants();
      const grant = grants.find((gr) => gr.delegation.id === id);
      if (!grant) {
        throw new Error(`Grant ${id} not found`);
      }

      const { delegation } = grant;
      if (delegation.status === 'revoked') {
        throw new Error(`Grant ${id} is already revoked`);
      }
      if (delegation.status !== 'signed') {
        throw new Error(
          `Grant ${id} has status '${delegation.status}', expected 'signed'`,
        );
      }

      // Submit on-chain disable — returns the hash and which path was used
      // so we poll the right receipt endpoint without calling useDirect7702Tx
      // a second time (the predicate is impure due to eth_getCode).
      const { hash: submissionHash, isDirect } =
        await submitDisableUserOp(delegation);

      if (isDirect) {
        const receipt = await pollTransactionReceipt({
          txHash: submissionHash,
        });
        if (!receipt.success) {
          throw new Error(
            `On-chain revocation reverted for grant ${id} (tx: ${submissionHash})`,
          );
        }
      } else {
        // waitForUserOpReceipt either returns a non-null receipt or throws
        // on timeout — validate the shape to catch unexpected bundler responses.
        const rawReceipt = await homeCoordinator.waitForUserOpReceipt({
          userOpHash: submissionHash,
        });
        const receipt = rawReceipt as { success?: boolean } | undefined;
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          !('success' in receipt)
        ) {
          throw new Error(
            `Unexpected UserOp receipt format for grant ${id} ` +
              `(userOpHash: ${submissionHash})`,
          );
        }
        if (!receipt.success) {
          throw new Error(
            `On-chain revocation reverted for grant ${id} (userOpHash: ${submissionHash})`,
          );
        }
      }

      // Remove local grant record after on-chain confirmation
      await E(delegatorVat).removeGrant(id);

      return submissionHash;
    },

    /**
     * Relay a delegation redemption from an away coordinator that has no bundler.
     * Used by the peer-relay away kernel to submit delegation UserOps via home's
     * bundler. The delegation's delegate must be home's smart account address.
     *
     * @param options - Redemption options.
     * @param options.delegation - The signed delegation to redeem.
     * @param options.execution - The execution to perform.
     * @returns The transaction or UserOp hash.
     */
    async redeemDelegation(options: {
      delegation: Delegation;
      execution: Execution;
    }): Promise<Hex> {
      const sender = smartAccountConfig?.address ?? options.delegation.delegate;
      const chainId = await resolveChainId();
      const sdkCallData = buildSdkRedeemCallData({
        delegations: [options.delegation],
        execution: options.execution,
        chainId,
      });
      if (await useDirect7702Tx(sender)) {
        return buildAndSubmitDirect7702Tx({ sender, callData: sdkCallData });
      }
      if (!bundlerConfig) {
        throw new Error(
          'Bundler not configured — cannot relay delegation redemption',
        );
      }
      return buildAndSubmitUserOp({ sender, callData: sdkCallData });
    },

    // ------------------------------------------------------------------
    // ERC-20 token utilities
    // ------------------------------------------------------------------

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

    async sendErc20Transfer(options: {
      token: Address;
      to: Address;
      amount: bigint | Hex;
      from?: Address;
    }): Promise<Hex> {
      const accounts = await homeCoordinator.getAccounts();
      const from = options.from ?? accounts[0];
      if (!from) {
        throw new Error('No accounts available');
      }
      const rawAmount =
        typeof options.amount === 'bigint'
          ? options.amount
          : BigInt(options.amount);
      const callData = encodeTransfer(options.to, rawAmount);
      return homeCoordinator.sendTransaction({
        from,
        to: options.token,
        data: callData,
        value: '0x0' as Hex,
      });
    },

    // ------------------------------------------------------------------
    // Token swaps (MetaSwap API)
    // ------------------------------------------------------------------

    async getSwapQuote(options: {
      srcToken: Address;
      destToken: Address;
      srcAmount: Hex;
      slippage: number;
      walletAddress?: Address;
    }): Promise<SwapQuote> {
      if (!providerVat) {
        throw new Error('Provider not configured');
      }

      if (options.slippage < 0.1 || options.slippage > 50) {
        throw new Error('Slippage must be between 0.1 and 50');
      }

      const walletAddress =
        options.walletAddress ?? (await homeCoordinator.getAccounts())[0];
      if (!walletAddress) {
        throw new Error('No accounts available');
      }

      const chainId = await resolveChainId();

      const rawAmount = BigInt(options.srcAmount).toString();

      // Build query string manually — URLSearchParams is unavailable in SES vats.
      const queryEntries: [string, string][] = [
        ['sourceToken', options.srcToken.toLowerCase()],
        ['destinationToken', options.destToken.toLowerCase()],
        ['sourceAmount', rawAmount],
        ['slippage', String(options.slippage)],
        ['walletAddress', walletAddress],
        ['timeout', '10000'],
      ];
      const query = queryEntries
        .map(
          ([key, val]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(val)}`,
        )
        .join('&');

      const url = `https://swap.api.cx.metamask.io/networks/${String(chainId)}/trades?${query}`;

      const response = await E(providerVat).httpGetJson(url);

      if (!Array.isArray(response) || response.length === 0) {
        throw new Error(
          'No swap quotes available for this token pair and amount',
        );
      }

      // Select the best quote by highest destinationAmount
      let best: SwapQuote | undefined;
      let bestAmount = -1n;

      for (const entry of response) {
        const quote = entry as Record<string, unknown>;
        if (quote.error) {
          continue;
        }
        const rawDest =
          typeof quote.destinationAmount === 'string'
            ? quote.destinationAmount
            : '0';
        const destAmount = BigInt(rawDest);
        if (destAmount > bestAmount) {
          bestAmount = destAmount;
          best = quote as unknown as SwapQuote;
        }
      }

      if (!best) {
        throw new Error(
          'All swap aggregators returned errors. Try a different amount or token pair.',
        );
      }

      return harden(best);
    },

    async swapTokens(options: {
      srcToken: Address;
      destToken: Address;
      srcAmount: Hex;
      slippage: number;
    }): Promise<SwapResult> {
      const ZERO_ADDRESS =
        '0x0000000000000000000000000000000000000000' as Address;

      const accounts = await homeCoordinator.getAccounts();
      const from = accounts[0];
      if (!from) {
        throw new Error('No accounts available');
      }

      // Fetch a fresh quote at execution time, reusing the resolved account
      const quote = await homeCoordinator.getSwapQuote({
        ...options,
        walletAddress: from,
      });

      // Determine if approval is needed
      const needsApproval =
        quote.approvalNeeded !== null &&
        options.srcToken.toLowerCase() !== ZERO_ADDRESS;

      const approvalInfo = needsApproval ? quote.approvalNeeded : null;
      let approvalNeeded = false;
      if (approvalInfo) {
        if (!providerVat) {
          throw new Error('Provider not configured');
        }

        const spender = approvalInfo.to as Address;
        const allowanceCallData = encodeAllowance(from, spender);
        const allowanceResult = await E(providerVat).request('eth_call', [
          { to: options.srcToken, data: allowanceCallData },
          'latest',
        ]);

        const currentAllowance =
          typeof allowanceResult === 'string' && allowanceResult !== '0x'
            ? decodeAllowanceResult(allowanceResult as Hex)
            : 0n;

        approvalNeeded = currentAllowance < BigInt(options.srcAmount);
      }

      const swapTx: TransactionRequest = {
        from,
        to: quote.trade.to as Address,
        data: quote.trade.data as Hex,
        value: (quote.trade.value ?? '0x0') as Hex,
      };

      // Batch path: combine approve + swap in a single UserOp when
      // the bundler is configured (smart account).
      if (approvalNeeded && approvalInfo && bundlerConfig) {
        const approvalTx: TransactionRequest = {
          from,
          to: options.srcToken,
          data: approvalInfo.data as Hex,
          value: (approvalInfo.value ?? '0x0') as Hex,
        };

        const batchResult = await homeCoordinator.sendBatchTransaction([
          approvalTx,
          swapTx,
        ]);

        // sendBatchTransaction returns a single Hex for batched UserOps
        const batchHash = Array.isArray(batchResult)
          ? (batchResult[0] as Hex)
          : batchResult;

        return harden({
          approvalTxHash: undefined,
          swapTxHash: batchHash,
          sourceAmount: quote.sourceAmount,
          destinationAmount: quote.destinationAmount,
          aggregator: quote.aggregator,
          batched: true,
        });
      }

      // Sequential path: approve then swap (EOA or no approval needed)
      let approvalTxHash: Hex | undefined;
      if (approvalNeeded && approvalInfo) {
        approvalTxHash = await homeCoordinator.sendTransaction({
          from,
          to: options.srcToken,
          data: approvalInfo.data as Hex,
          value: (approvalInfo.value ?? '0x0') as Hex,
        });
      }

      try {
        const swapTxHash = await homeCoordinator.sendTransaction(swapTx);

        return harden({
          approvalTxHash,
          swapTxHash,
          sourceAmount: quote.sourceAmount,
          destinationAmount: quote.destinationAmount,
          aggregator: quote.aggregator,
        });
      } catch (error: unknown) {
        if (approvalTxHash) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `Swap transaction failed after approval was sent (approval tx: ${approvalTxHash}). ` +
              `The token allowance was set but the swap did not complete: ${message}`,
          );
        }
        throw error;
      }
    },

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
     * Poll until a regular EIP-1559 transaction is mined (e.g. stateless 7702
     * direct sends). Prefer `waitForUserOpReceipt` for ERC-4337 UserOp hashes.
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
    // Peer delegate address registration
    // ------------------------------------------------------------------

    /**
     * Register the away wallet's on-chain delegate address.
     * Called by the away coordinator after connecting to report which address
     * will appear as `msg.sender` when redeeming delegations.
     *
     * @param address - The away wallet's delegate address (0x-prefixed).
     */
    async registerDelegateAddress(address: string): Promise<void> {
      delegateAddress = address;
      persistBaggage('delegateAddress', delegateAddress);
    },

    /**
     * Return the registered away wallet delegate address, if any.
     *
     * @returns The delegate address, or undefined if not yet registered.
     */
    async getDelegateAddress(): Promise<string | undefined> {
      return delegateAddress;
    },

    // ------------------------------------------------------------------
    // OcapURL and homeSection
    // ------------------------------------------------------------------

    /**
     * Issue an OcapURL that grants the bearer access to this home coordinator.
     *
     * The away coordinator calls this URL via `connectToPeer` to obtain a
     * reference to the home coordinator and then fetches the homeSection.
     *
     * @returns The OcapURL string.
     */
    async issueOcapUrl(): Promise<string> {
      if (!issuerService) {
        throw new Error('OCAP URL issuer service not available');
      }
      return E(issuerService).issue(homeCoordinator);
    },

    /**
     * Return the pre-built homeSection exo.
     *
     * The away coordinator fetches this reference at connectToPeer time and
     * stores as the call-home fallback for the away coordinator's routing.
     *
     * @returns The homeSection exo object.
     */
    async getHomeSection(): Promise<object> {
      return homeSection;
    },

    // ------------------------------------------------------------------
    // Introspection
    // ------------------------------------------------------------------

    /**
     * Return a summary of the home wallet's current capabilities.
     *
     * Reflects local state only: keys, accounts, external signer, bundler,
     * smart account, and grant count from the delegator vat (if available).
     *
     * @returns A WalletCapabilities object.
     */
    async getCapabilities(): Promise<WalletCapabilities> {
      const hasLocalKeys = keyringVat ? await E(keyringVat).hasKeys() : false;

      const localAccounts: Address[] = keyringVat
        ? await E(keyringVat).getAccounts()
        : [];

      // Fetch grant count from delegator vat if available
      let grantsCount = 0;
      if (delegatorVat) {
        try {
          const grants = await E(delegatorVat).listGrants();
          grantsCount = grants.length;
        } catch (error) {
          logger.warn('Failed to fetch grants from delegator vat', error);
        }
      }

      // Resolve signing mode based on available authorities
      let signingMode: string = 'none';
      if (externalSigner) {
        signingMode = 'external:metamask';
      } else if (hasLocalKeys) {
        signingMode = 'local';
      }

      // Determine autonomy level based on smart account and bundler config
      let autonomy: string;
      const canSendDirectly =
        bundlerConfig !== undefined ||
        (smartAccountConfig?.implementation === 'stateless7702' &&
          providerVat !== undefined);
      if (canSendDirectly) {
        autonomy =
          grantsCount > 0
            ? `autonomous (${grantsCount} delegation grant(s) issued)`
            : 'autonomous (direct smart account)';
      } else if (hasLocalKeys || externalSigner) {
        autonomy = 'EOA signing';
      } else {
        autonomy = 'no signing authority';
      }

      let capabilityChainId: number | undefined;
      try {
        capabilityChainId = await resolveChainId();
      } catch (error) {
        logger.warn('Failed to resolve chain ID for capabilities', error);
      }

      return harden({
        hasLocalKeys,
        localAccounts,
        delegationCount: grantsCount,
        delegations: undefined,
        hasPeerWallet: false,
        hasExternalSigner: externalSigner !== undefined,
        hasBundlerConfig: bundlerConfig !== undefined,
        smartAccountAddress: smartAccountConfig?.address,
        chainId: capabilityChainId,
        signingMode,
        autonomy,
        peerAccountsCached: false,
        cachedPeerAccounts: [],
        hasAwayWallet: false,
      });
    },
  });

  return homeCoordinator;
}
