import {
  array,
  boolean,
  create,
  define,
  enums,
  literal,
  number,
  object,
  optional,
  record,
  string,
  union,
  unknown,
} from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';
import type { SignedAuthorization } from 'viem';

// ---------------------------------------------------------------------------
// Hex string helpers
// ---------------------------------------------------------------------------

/**
 * A 0x-prefixed hex string.
 */
export type Hex = `0x${string}`;

const HexStruct = define<Hex>('Hex', (value) => {
  return typeof value === 'string' && /^0x[\da-f]*$/iu.test(value);
});

/**
 * A 0x-prefixed Ethereum address (20 bytes).
 */
export type Address = Hex;

const AddressStruct = define<Address>('Address', (value) => {
  return typeof value === 'string' && /^0x[\da-f]{40}$/iu.test(value);
});

// ---------------------------------------------------------------------------
// Chain configuration
// ---------------------------------------------------------------------------

export const ChainConfigStruct = object({
  chainId: number(),
  rpcUrl: string(),
  name: optional(string()),
});

export type ChainConfig = Infer<typeof ChainConfigStruct>;

/**
 * Create a validated ChainConfig.
 *
 * @param options - Chain configuration options.
 * @param options.chainId - The numeric chain ID.
 * @param options.rpcUrl - The JSON-RPC endpoint URL.
 * @param options.name - Optional human-readable chain name.
 * @returns A validated ChainConfig object.
 */
export function makeChainConfig(options: {
  chainId: number;
  rpcUrl: string;
  name?: string;
}): ChainConfig {
  return create(options, ChainConfigStruct);
}

// ---------------------------------------------------------------------------
// Caveat types (MetaMask Delegation Framework / Gator)
// ---------------------------------------------------------------------------

/**
 * Supported caveat enforcer types.
 * Each maps to a deployed enforcer contract on the delegation framework.
 */
export const CaveatTypeValues = [
  'allowedTargets',
  'allowedMethods',
  'allowedCalldata',
  'valueLte',
  'nativeTokenTransferAmount',
  'erc20TransferAmount',
  'limitedCalls',
  'timestamp',
] as const;

export type CaveatType = (typeof CaveatTypeValues)[number];

const CaveatTypeStruct = enums(CaveatTypeValues);

export const CaveatStruct = object({
  enforcer: AddressStruct,
  terms: HexStruct,
  args: optional(HexStruct),
  type: CaveatTypeStruct,
});

export type Caveat = Infer<typeof CaveatStruct>;

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

export const DelegationStatusValues = ['pending', 'signed', 'revoked'] as const;

export type DelegationStatus = (typeof DelegationStatusValues)[number];

export const DelegationStruct = object({
  id: string(),
  delegator: AddressStruct,
  delegate: AddressStruct,
  authority: HexStruct,
  caveats: array(CaveatStruct),
  salt: HexStruct,
  signature: optional(HexStruct),
  chainId: number(),
  status: enums(DelegationStatusValues),
});

export type Delegation = Infer<typeof DelegationStruct>;

// ---------------------------------------------------------------------------
// Transaction types
// ---------------------------------------------------------------------------

export const TransactionRequestStruct = object({
  from: AddressStruct,
  to: AddressStruct,
  value: optional(HexStruct),
  data: optional(HexStruct),
  nonce: optional(number()),
  gasLimit: optional(HexStruct),
  gasPrice: optional(HexStruct),
  maxFeePerGas: optional(HexStruct),
  maxPriorityFeePerGas: optional(HexStruct),
  chainId: optional(number()),
});

export type TransactionRequest = Infer<typeof TransactionRequestStruct> & {
  /**
   * EIP-7702 signed authorization list. When present, the transaction is
   * serialized as a type-4 (EIP-7702) transaction instead of EIP-1559.
   * Not struct-validated; only flows internally.
   */
  authorizationList?: readonly SignedAuthorization[];
};

// ---------------------------------------------------------------------------
// Signing request (used for peer wallet communication)
// ---------------------------------------------------------------------------

export const SigningRequestStruct = union([
  object({
    type: literal('transaction'),
    tx: TransactionRequestStruct,
  }),
  object({
    type: literal('typedData'),
    data: record(string(), unknown()),
  }),
  object({
    type: literal('message'),
    message: string(),
    account: AddressStruct,
  }),
]);

export type SigningRequest = Infer<typeof SigningRequestStruct>;

// ---------------------------------------------------------------------------
// Wallet capabilities introspection
// ---------------------------------------------------------------------------

export const DelegationInfoStruct = object({
  id: string(),
  delegator: AddressStruct,
  delegate: AddressStruct,
  caveats: array(
    object({
      type: CaveatTypeStruct,
      humanReadable: string(),
    }),
  ),
});

export type DelegationInfo = Infer<typeof DelegationInfoStruct>;

export const WalletCapabilitiesStruct = object({
  hasLocalKeys: boolean(),
  localAccounts: array(AddressStruct),
  delegationCount: number(),
  delegations: optional(array(DelegationInfoStruct)),
  hasPeerWallet: boolean(),
  hasExternalSigner: boolean(),
  hasBundlerConfig: boolean(),
  smartAccountAddress: optional(AddressStruct),
  chainId: optional(number()),
  signingMode: optional(string()),
  autonomy: optional(string()),
  peerAccountsCached: optional(boolean()),
  cachedPeerAccounts: optional(array(AddressStruct)),
  hasAwayWallet: optional(boolean()),
});

export type WalletCapabilities = Infer<typeof WalletCapabilitiesStruct>;

// ---------------------------------------------------------------------------
// Smart account configuration
// ---------------------------------------------------------------------------

export const SmartAccountConfigStruct = object({
  implementation: union([literal('hybrid'), literal('stateless7702')]),
  deploySalt: optional(HexStruct),
  address: optional(AddressStruct),
  factory: optional(AddressStruct),
  factoryData: optional(HexStruct),
  deployed: optional(boolean()),
});

export type SmartAccountConfig = Infer<typeof SmartAccountConfigStruct>;

// ---------------------------------------------------------------------------
// Action descriptor (for delegation matching)
// ---------------------------------------------------------------------------

export const ActionStruct = object({
  to: AddressStruct,
  value: optional(HexStruct),
  data: optional(HexStruct),
});

export type Action = Infer<typeof ActionStruct>;

// ---------------------------------------------------------------------------
// Delegation creation options
// ---------------------------------------------------------------------------

export const CreateDelegationOptionsStruct = object({
  delegate: AddressStruct,
  caveats: array(CaveatStruct),
  chainId: number(),
  salt: optional(HexStruct),
});

export type CreateDelegationOptions = Infer<
  typeof CreateDelegationOptionsStruct
>;

// ---------------------------------------------------------------------------
// EIP-712 typed data (generic representation)
// ---------------------------------------------------------------------------

export const Eip712DomainStruct = object({
  name: optional(string()),
  version: optional(string()),
  chainId: optional(number()),
  verifyingContract: optional(AddressStruct),
  salt: optional(HexStruct),
});

export type Eip712Domain = Infer<typeof Eip712DomainStruct>;

export const Eip712TypedDataStruct = object({
  domain: Eip712DomainStruct,
  types: record(string(), array(object({ name: string(), type: string() }))),
  primaryType: string(),
  message: record(string(), unknown()),
});

export type Eip712TypedData = Infer<typeof Eip712TypedDataStruct>;

// ---------------------------------------------------------------------------
// ERC-4337 UserOperation (off-chain representation, v0.7)
// ---------------------------------------------------------------------------

export const UserOperationStruct = object({
  sender: AddressStruct,
  nonce: HexStruct,
  factory: optional(AddressStruct),
  factoryData: optional(HexStruct),
  callData: HexStruct,
  callGasLimit: HexStruct,
  verificationGasLimit: HexStruct,
  preVerificationGas: HexStruct,
  maxFeePerGas: HexStruct,
  maxPriorityFeePerGas: HexStruct,
  paymaster: optional(AddressStruct),
  paymasterVerificationGasLimit: optional(HexStruct),
  paymasterPostOpGasLimit: optional(HexStruct),
  paymasterData: optional(HexStruct),
  signature: HexStruct,
});

export type UserOperation = Infer<typeof UserOperationStruct>;

// ---------------------------------------------------------------------------
// Execution descriptor (for delegation redemption)
// ---------------------------------------------------------------------------

export const ExecutionStruct = object({
  target: AddressStruct,
  value: HexStruct,
  callData: HexStruct,
});

export type Execution = Infer<typeof ExecutionStruct>;

// ---------------------------------------------------------------------------
// Delegation match result (for delegation matching diagnostics)
// ---------------------------------------------------------------------------

export type DelegationMatchResult = {
  matches: boolean;
  failedCaveat?: CaveatType;
  reason?: string;
};

// ---------------------------------------------------------------------------
// Semantic delegation grants (twin construction input — post-decoded)
// ---------------------------------------------------------------------------

export type TransferNativeGrant = {
  method: 'transferNative';
  /** Restricted recipient; enforced by AllowedTargetsEnforcer on-chain. */
  to?: Address;
  /** Per-call ETH value limit; enforced by ValueLteEnforcer on-chain. */
  maxAmount?: bigint;
  /** Cumulative ETH transfer cap; enforced by NativeTokenTransferAmountEnforcer on-chain. */
  totalLimit?: bigint;
  delegation: Delegation;
};

export type TransferFungibleGrant = {
  method: 'transferFungible';
  /** ERC-20 token contract; from AllowedTargetsEnforcer. Always present. */
  token: Address;
  /** Restricted recipient; from AllowedCalldataEnforcer. */
  to?: Address;
  /** Cumulative transfer cap; from ERC20TransferAmountEnforcer. */
  totalLimit?: bigint;
  delegation: Delegation;
};

const BigintStruct = define<bigint>(
  'bigint',
  (value) => typeof value === 'bigint',
);

export const TransferNativeGrantStruct = object({
  method: literal('transferNative'),
  to: optional(AddressStruct),
  maxAmount: optional(BigintStruct),
  totalLimit: optional(BigintStruct),
  delegation: DelegationStruct,
});

export const TransferFungibleGrantStruct = object({
  method: literal('transferFungible'),
  token: AddressStruct,
  to: optional(AddressStruct),
  totalLimit: optional(BigintStruct),
  delegation: DelegationStruct,
});

export const DelegationGrantStruct = union([
  TransferNativeGrantStruct,
  TransferFungibleGrantStruct,
]);

/** Discriminated union of all supported semantic delegation grant types. */
export type DelegationGrant = TransferNativeGrant | TransferFungibleGrant;

// ---------------------------------------------------------------------------
// Swap types (MetaSwap API)
// ---------------------------------------------------------------------------

export const SwapQuoteStruct = object({
  trade: object({
    to: string(),
    from: string(),
    data: string(),
    value: string(),
    gas: string(),
  }),
  approvalNeeded: union([
    object({ to: string(), data: string(), value: string() }),
    literal(null),
  ]),
  sourceAmount: string(),
  destinationAmount: string(),
  aggregator: string(),
  fee: number(),
  gasEstimate: string(),
  priceSlippage: number(),
  quoteRefreshSeconds: number(),
});

export type SwapQuote = Infer<typeof SwapQuoteStruct>;

export type SwapResult = {
  approvalTxHash?: Hex | undefined;
  swapTxHash: Hex;
  sourceAmount: string;
  destinationAmount: string;
  aggregator: string;
  batched?: boolean | undefined;
};
