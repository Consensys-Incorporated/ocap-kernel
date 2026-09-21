# @ocap/evm-wallet-experiment

A capability-driven EVM wallet, implemented as an OCAP kernel subcluster. It uses the [MetaMask Delegation Framework (Gator)](https://github.com/MetaMask/delegation-framework) for delegated transaction authority. **Hybrid** smart accounts submit ERC-4337 UserOperations through a bundler; **stateless EIP-7702** home accounts (mnemonic path) redeem delegations with normal EIP-1559 transactions via your JSON-RPC provider (e.g. Infura), without a bundler. The wallet subcluster isolates key management, Ethereum RPC communication, and delegation lifecycle into separate vats, enforcing the principle of least authority across the entire signing pipeline.

For a deeper explanation of the components and data flow, see [How It Works](./docs/how-it-works.md). For deploying the wallet on a home device + VPS with OpenClaw, see the [Setup Guide](./docs/setup-guide.md).

## Security model and known limitations

- **Peer signing has no interactive approval for message/typed-data requests.** Transaction signing over peer requests is now disabled and peer-connected wallets must use delegation redemption for sends, but message and typed-data peer signing still execute immediately without an approval prompt.
- **`revokeDelegation()` and hybrid redemption require a bundler or peer relay.** Hybrid accounts submit on-chain `disableDelegation` / redemption via ERC-4337 UserOps; configure a bundler (and optional paymaster). **Stateless 7702** accounts use a direct EIP-1559 transaction instead; only the JSON-RPC provider must be configured. **Away wallets without a bundler** relay delegation redemptions to the home wallet via CapTP (requires the home wallet to be online). If the on-chain transaction fails, the local delegation status is not changed.
- **Mnemonic encryption is optional.** The keyring vat can encrypt the mnemonic at rest using AES-256-GCM with a PBKDF2-derived key. Pass a `password` and `salt` to `initializeKeyring()` to enable encryption. Without a password, the mnemonic is stored in plaintext. When encrypted, the keyring starts in a locked state on daemon restart and must be unlocked with `unlockKeyring(password)` before signing operations work.

## Architecture

The wallet is composed of four vats within a single kernel subcluster. The **coordinator** vat acts as the bootstrap vat and public API surface. It orchestrates signing strategy resolution, delegation redemption, and peer wallet communication by dispatching to the other three vats via `E()` (eventual send).

```
                        +-----------------------+
                        |   Coordinator Vat     |
                        |   (bootstrap / API)   |
                        |                       |
                        |  - Signing strategy   |
                        |    resolution         |
                        |  - Delegation         |
                        |    redemption         |
                        |  - Peer wallet        |
                        |    communication      |
                        +--+------+------+------+
                           |      |      |
              E()          |      |      |         E()
          +----------------+      |      +------------------+
          |                       |                         |
          v                       v                         v
+-------------------+  +-------------------+  +------------------------+
|   Keyring Vat     |  |   Provider Vat    |  |   Delegation Vat       |
|                   |  |                   |  |                        |
| - HD key deriv.   |  | - Ethereum        |  | - Create / store       |
| - Throwaway keys  |  |   JSON-RPC        |  |   delegations          |
| - Transaction     |  | - Broadcast tx    |  | - EIP-712 typed data   |
|   signing         |  | - Bundler RPC     |  |   preparation          |
| - Message signing |  |   (UserOp submit, |  | - Action matching      |
| - Typed data      |  |    gas estimate)  |  | - Revocation           |
|   signing         |  |                   |  |                        |
+-------------------+  +-------------------+  +------------------------+

Keys NEVER leave        Network I/O only       Pure delegation logic
the keyring vat                                 (no keys, no network)
```

### Vat Responsibilities

**Coordinator vat** -- The bootstrap vat and sole public API surface. Resolves which signing strategy to use for each request (delegation, local key, external signer, or peer wallet). Builds and submits ERC-4337 UserOperations for delegation redemption. Manages peer wallet connectivity via OCAP URLs.

**Keyring vat** -- Isolates private key material. Supports two initialization modes: `srp` (BIP-39 mnemonic with BIP-44 HD derivation at `m/44'/60'/0'/0/{index}`) and `throwaway` (a single randomly generated private key). Signs transactions, personal messages, and EIP-712 typed data. Keys never leave this vat. Optionally encrypts the mnemonic at rest with AES-256-GCM (password-based, PBKDF2 key derivation).

**Provider vat** -- Handles all Ethereum JSON-RPC communication. Wraps a [viem](https://viem.sh/) transport for standard RPC calls (`eth_call`, `eth_getBalance`, etc.), transaction broadcasting, and ERC-4337 bundler RPC (`eth_sendUserOperation`, `eth_estimateUserOperationGas`).

**Delegation vat** -- Manages the lifecycle of Gator delegations: creation, EIP-712 signing preparation, storage, action matching, and revocation. Accepts incoming signed delegations from peer wallets. Contains no key material and performs no network I/O.

## Home vs. Away Kernel Setup

The wallet supports a two-kernel topology where a **home kernel** (the user's device) delegates authority to an **away kernel** (a remote server or secondary device). The two kernels connect via OCAP URLs over QUIC or TCP.

### Home Kernel

The home kernel is the authority holder. It typically has MetaMask connected as an external signer (no local keyring needed). It creates delegations and shares them with the away kernel.

```typescript
import {
  makeWalletClusterConfig,
  connectMetaMaskSigner,
} from '@ocap/evm-wallet-experiment';

// 1. Launch the wallet subcluster
const config = makeWalletClusterConfig({ bundleBaseUrl: '/bundles' });
const { rootKref } = await kernel.launchSubcluster(config);

// 2. Connect MetaMask as external signer
const signer = await connectMetaMaskSigner({
  dappMetadata: { name: 'My dApp', url: 'https://example.com' },
});
await coordinator.connectExternalSigner(signer);

// 3. Configure the bundler for ERC-4337 UserOps
await coordinator.configureBundler({
  bundlerUrl: 'https://bundler.example.com/rpc',
  chainId: 1,
});

// 4. Issue an OCAP URL and share it with the away kernel
const ocapUrl = await coordinator.issueOcapUrl();
// Send ocapUrl to the away kernel via any out-of-band channel

// 5. Read the delegate address sent by the away kernel (automatic)
const delegateAddress = await coordinator.getDelegateAddress();
// Falls back to manual input if the away kernel hasn't connected yet

// 6. Create a delegation for the away kernel's address
const delegation = await coordinator.createDelegation({
  delegate: delegateAddress ?? ('0xAwayAddress...' as Address),
  caveats: [
    makeCaveat({
      type: 'allowedTargets',
      terms: encodeAllowedTargets(['0xContractAddress...' as Address]),
    }),
    makeCaveat({
      type: 'valueLte',
      terms: encodeValueLte(1000000000000000000n), // 1 ETH max
    }),
  ],
  chainId: 1,
});

// 7. Push the delegation to the away kernel (automatic over QUIC/CapTP)
await coordinator.pushDelegationToAway(delegation);
```

### Away Kernel

The away kernel receives delegated authority. It initializes a throwaway keyring and redeems delegations by building ERC-4337 UserOperations. In the provided home/away setup flow, the delegate address exchange and back-channel registration happen automatically, so no manual copy-paste is needed.

```typescript
import { makeWalletClusterConfig } from '@ocap/evm-wallet-experiment';

// 1. Launch the wallet subcluster with a throwaway keyring
const config = makeWalletClusterConfig({ bundleBaseUrl: '/bundles' });
const { rootKref } = await kernel.launchSubcluster(config);
await coordinator.initializeKeyring({ type: 'throwaway' });

// 2. Connect to the home kernel via the OCAP URL
// This automatically:
//   - Connects to the peer coordinator
//   - Caches peer accounts for offline use
// Additional setup automation can then:
//   - Register a back-channel (registerAwayWallet) for delegation push
//   - Send the delegate address to the home device
await coordinator.connectToPeer(ocapUrl);

// 3. The home device pushes the delegation automatically via pushDelegationToAway().
//    Alternatively, receive it manually:
// await coordinator.receiveDelegation(delegation);

// 4. (Optional) Configure the bundler — without it, redemptions are relayed
//    to the home wallet (requires home online).
await coordinator.configureBundler({
  bundlerUrl: 'https://bundler.example.com/rpc',
  chainId: 1,
});

// 5. Redeem the delegation (via UserOp if bundler configured, or relayed to home)
const userOpHash = await coordinator.redeemDelegation({
  execution: {
    target: '0xContractAddress...' as Address,
    value: '0x0' as Hex,
    callData: '0x...' as Hex,
  },
  delegationId: delegation.id,
  maxFeePerGas: '0x3b9aca00' as Hex,
  maxPriorityFeePerGas: '0x3b9aca00' as Hex,
});
```

### Peer Wallet Communication

In the provided setup flow, the away kernel connects via `connectToPeer()`, then higher-level automation registers a back-channel with the home coordinator and sends the delegate address. This enables the home device to push delegations and read the delegate address without manual copy-paste.

If the away kernel has no local keys and no matching delegation for a message or typed-data signing request, it falls back to the peer wallet (the home kernel's coordinator). The signing request is forwarded over the OCAP URL connection, and the home kernel signs it using its own keyring or external signer. Transaction signing (`signTransaction`) does not have a peer fallback — the away kernel must use delegation redemption for sends.

```
  Away Kernel                           Home Kernel
  +-----------+                         +-----------+
  |Coordinator|  -- signing request --> |Coordinator|
  |           |                         |           |
  |  (no keys)|                         |  Keyring  |
  |           |  <-- signature -------- |  or       |
  |           |                         |  MetaMask |
  +-----------+                         +-----------+
       ^                                      ^
       |          OCAP URL over QUIC/TCP      |
       +--------------------------------------+
```

### Offline Autonomy

The away kernel caches the home kernel's accounts and signing mode during `connectToPeer()`. After the delegation is transferred:

**With bundler configured** — the home device can go offline, the away kernel operates fully autonomously:

- `getAccounts()` returns cached peer accounts (with a 5-second timeout on live peer calls)
- `getCapabilities()` returns cached signing mode
- `sendTransaction()` signs locally and submits via the bundler (no home needed)
- `signMessage()` / `signTypedData()` signs with the local throwaway key

**Without bundler (relay mode)** — delegation redemptions are relayed to the home wallet via CapTP, requiring the home to be online for sends. Message/typed-data signing still works locally with the throwaway key.

The only operation that always requires the home online is signing as the home EOA address specifically (since that requires the home's private key). The away coordinator detects this and throws a clear error instead of signing with the wrong key. See [How It Works — Offline Autonomy](./docs/how-it-works.md#offline-autonomy-vps-mode) for details.

## Signing Strategy Resolution

The coordinator resolves the appropriate signer for each request type using a priority chain.

### `signTransaction()`

Priority: local key → external signer → error

1. **Local key** -- If the keyring owns the `from` account, it signs directly.
2. **External signer** -- If a MetaMask or other external signer is connected, it signs.

No delegation or peer wallet fallback is used for bare transaction signing.

### `sendTransaction()`

Priority: delegation (UserOp) → local key sign + broadcast → external signer sign + broadcast → error

1. **Delegation** -- If a stored delegation matches the transaction's action (target, value, data), the coordinator builds and submits a UserOp signed via the local keyring.
2. **Local key** -- If the keyring owns the `from` account, it signs and broadcasts directly.
3. **External signer** -- If a MetaMask or other external signer is connected, it signs and broadcasts.

Delegations are checked first, but there is no peer wallet fallback for transactions.

### `signMessage()` / `signTypedData()`

Priority: peer account guard → keyring → external signer → peer wallet → error

1. **Peer account guard** -- If `from` matches a cached peer (home) account, the request is routed to the peer wallet. If the peer is offline, a descriptive error is thrown instead of silently signing with the wrong key.
2. **Keyring** -- If the keyring has keys, it signs directly.
3. **External signer** -- If a MetaMask or other external signer is connected, it signs.
4. **Peer wallet** -- If a peer wallet is connected, the request is forwarded.

## Delegation Flow

Delegations use the MetaMask Delegation Framework (Gator). A delegation grants a **delegate** address the authority to act on behalf of a **delegator** address, subject to **caveats** (on-chain enforced restrictions).

### Creating a Delegation

The delegator signs an EIP-712 typed data payload that binds the delegation parameters. The DelegationManager contract is the verifying contract.

```typescript
import {
  makeCaveat,
  encodeAllowedTargets,
  encodeAllowedMethods,
  encodeValueLte,
  encodeTimestamp,
  encodeLimitedCalls,
  encodeErc20TransferAmount,
} from '@ocap/evm-wallet-experiment';

const delegation = await coordinator.createDelegation({
  delegate: '0xDelegateAddress...' as Address,
  caveats: [
    makeCaveat({
      type: 'allowedTargets',
      terms: encodeAllowedTargets(['0xContract...' as Address]),
    }),
    makeCaveat({
      type: 'allowedMethods',
      terms: encodeAllowedMethods(['0xa9059cbb' as Hex]), // transfer(address,uint256)
    }),
    makeCaveat({
      type: 'valueLte',
      terms: encodeValueLte(0n), // No ETH value allowed
    }),
  ],
  chainId: 1,
});
```

### Supported Caveats

| Caveat Type                 | Description                                       | Encoder                           |
| --------------------------- | ------------------------------------------------- | --------------------------------- |
| `allowedTargets`            | Restrict to specific contract addresses           | `encodeAllowedTargets`            |
| `allowedMethods`            | Restrict to specific function selectors (4 bytes) | `encodeAllowedMethods`            |
| `valueLte`                  | Cap the ETH value per call                        | `encodeValueLte`                  |
| `nativeTokenTransferAmount` | Cap the native token (ETH) transfer amount        | `encodeNativeTokenTransferAmount` |
| `erc20TransferAmount`       | Cap the ERC-20 token transfer amount              | `encodeErc20TransferAmount`       |
| `limitedCalls`              | Limit total number of calls                       | `encodeLimitedCalls`              |
| `timestamp`                 | Restrict usage to a time window (unix seconds)    | `encodeTimestamp`                 |

### Sharing Delegations

Delegations can be shared between kernels in three ways:

- **Automatic push (recommended)** -- When the away device connects via `connectToPeer()`, it registers a back-channel with the home coordinator. The home device can then push delegations directly via `pushDelegationToAway(delegation)`. The setup scripts and `update-limits.sh` use this automatically.
- **Direct** -- Call `coordinator.receiveDelegation(delegation)` on the receiving kernel, passing the signed delegation object.
- **OCAP URL** -- The home kernel issues an OCAP URL, and the away kernel redeems it to obtain a reference to the home coordinator, then receives delegations via method calls.

### Redeeming Delegations

Redemption calls `DelegationManager.redeemDelegations` on-chain. The submission path depends on configuration:

- **Bundler configured** — builds an ERC-4337 UserOp signed by the delegate and submitted to a bundler (routed through EntryPoint v0.7).
- **Stateless 7702** — broadcasts a direct EIP-1559 self-call transaction via the JSON-RPC provider.
- **Peer relay (away wallet, no bundler)** — relays the delegation + execution to the home wallet via CapTP; the home wallet submits on its own behalf using whichever path it supports.

```typescript
const userOpHash = await coordinator.redeemDelegation({
  execution: {
    target: '0xTokenContract...' as Address,
    value: '0x0' as Hex,
    callData: '0xa9059cbb...' as Hex, // transfer(address,uint256) encoded
  },
  delegationId: delegation.id,
  // OR: action: { to: '0x...', value: '0x0', data: '0x...' } for automatic matching
  maxFeePerGas: '0x3b9aca00' as Hex,
  maxPriorityFeePerGas: '0x3b9aca00' as Hex,
});
```

## API Reference

### Coordinator -- Lifecycle

| Method                           | Description                                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap(vats, services)`      | Called by the kernel during subcluster launch. Wires up vat references.                                                                                                                                                      |
| `initializeKeyring(options)`     | Initialize the keyring vat. Options: `{ type: 'srp', mnemonic, password?, salt? }` or `{ type: 'throwaway' }`. When `password` is provided for SRP, the mnemonic is encrypted at rest (requires a random `salt` hex string). |
| `unlockKeyring(password)`        | Unlock an encrypted keyring after daemon restart. Required before any signing operations when the mnemonic was encrypted with a password.                                                                                    |
| `isKeyringLocked()`              | Returns `true` if the keyring is encrypted and has not been unlocked yet.                                                                                                                                                    |
| `configureProvider(chainConfig)` | Configure the provider vat with an RPC URL and chain ID.                                                                                                                                                                     |
| `connectExternalSigner(signer)`  | Connect an external signing backend (e.g., MetaMask).                                                                                                                                                                        |
| `configureBundler(config)`       | Configure the ERC-4337 bundler. Accepts `{ bundlerUrl, chainId, entryPoint?, usePaymaster?, sponsorshipPolicyId? }`.                                                                                                         |

### Coordinator -- Signing

| Method                           | Description                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signTransaction(tx)`            | Sign a transaction using strategy resolution.                                                                                                                  |
| `sendTransaction(tx)`            | Sign and broadcast a transaction via the provider.                                                                                                             |
| `sendBatchTransaction(txs)`      | Batch multiple transactions into a single UserOp for smart accounts. Falls back to sequential `sendTransaction` calls for EOA wallets without a smart account. |
| `signMessage(message, account?)` | Sign a personal message (EIP-191).                                                                                                                             |
| `signTypedData(data, from?)`     | Sign EIP-712 typed data.                                                                                                                                       |
| `request(method, params?)`       | Forward a raw JSON-RPC request to the provider.                                                                                                                |

### Coordinator -- Delegation

| Method                          | Description                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `createDelegation(opts)`        | Create and sign a new delegation. Returns the signed `Delegation`.                               |
| `receiveDelegation(delegation)` | Store a signed delegation received from a peer.                                                  |
| `revokeDelegation(id)`          | Revoke a delegation on-chain via `DelegationManager.disableDelegation`. Returns the UserOp hash. |
| `listDelegations()`             | List all stored delegations.                                                                     |
| `redeemDelegation(options)`     | Build, sign, and submit a UserOp to redeem a delegation.                                         |

### Coordinator -- Peer Connectivity

| Method                               | Description                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `issueOcapUrl()`                     | Issue an OCAP URL that grants a reference to this coordinator. Requires `ocapURLIssuerService`.                        |
| `connectToPeer(ocapUrl)`             | Connect to a remote coordinator via an OCAP URL and cache peer accounts for offline use.                               |
| `refreshPeerAccounts()`              | Re-fetch and cache peer accounts. Throws if no peer wallet is connected.                                               |
| `registerAwayWallet(awayRef)`        | Register an away wallet reference for delegation push. Called automatically by the away device during `connectToPeer`. |
| `pushDelegationToAway(delegation)`   | Push a signed delegation to the registered away wallet over CapTP. Throws if no away wallet is registered.             |
| `registerDelegateAddress(address)`   | Store a delegate address received from the away device. Called automatically via `sendDelegateAddressToPeer`.          |
| `getDelegateAddress()`               | Return the pending delegate address sent by the away device, or `undefined` if none.                                   |
| `sendDelegateAddressToPeer(address)` | Send this device's delegate address to the connected peer (home) device. Used by the higher-level setup flow.          |
| `handleSigningRequest(request)`      | Handle an incoming signing request from a peer wallet.                                                                 |

### Coordinator -- ERC-20 Tokens

| Method                       | Description                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `getTokenBalance(options)`   | Get ERC-20 balance. Accepts `{ token, owner }`. Returns the raw balance as a decimal string.                                 |
| `getTokenMetadata(options)`  | Get token metadata. Accepts `{ token }`. Returns `{ name, symbol, decimals }`. Handles non-standard `bytes32` returns (MKR). |
| `sendErc20Transfer(options)` | Send ERC-20 tokens. Accepts `{ token, to, amount, from? }`. Routes through `sendTransaction` (delegation-aware).             |

### Coordinator -- Token Swaps

| Method                  | Description                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSwapQuote(options)` | Get the best swap quote from MetaSwap (MetaMask's aggregator). Accepts `{ srcToken, destToken, srcAmount, slippage }`. Returns a `SwapQuote` with trade data and approval details. The `SwapQuote` type has a corresponding runtime validation struct (`SwapQuoteStruct`) exported from the package.                                            |
| `swapTokens(options)`   | Execute a token swap. Fetches a fresh quote, handles ERC-20 approval if needed, then executes the swap. Returns a `SwapResult` with transaction hashes and details. When a smart account is configured and the swap requires an ERC-20 approval, the approve and swap are batched into a single UserOp and the result includes `batched: true`. |

### Coordinator -- Introspection

| Method              | Description                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `getAccounts()`     | List accounts. Returns cached peer accounts when the home device is offline (5s timeout).     |
| `getCapabilities()` | Return a `WalletCapabilities` object describing the wallet state, including cached peer info. |

### Coordinator -- Smart Accounts

| Method                       | Description                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSmartAccount(config)` | Create a smart account. Accepts `{ chainId, implementation?, deploySalt?, address? }`. Default implementation is `'hybrid'` (counterfactual, deploys on first UserOp). `'stateless7702'` is also supported but requires RPC providers that expose EIP-7702 designator codes via `eth_getCode` (see note below). |
| `getSmartAccountAddress()`   | Return the smart account address, if configured.                                                                                                                                                                                                                                                                |

**Note on smart account implementations:** The `stateless7702` implementation uses EIP-7702 to promote the EOA into a DeleGator smart account — same address, no separate contract or funding needed. The home device uses this by default. The `hybrid` implementation creates a counterfactual smart account that deploys on-chain on the first UserOp via factory data. The away device uses this because its throwaway EOA has no ETH to pay for the on-chain EIP-7702 authorization tx.

The `WalletCapabilities` object contains:

```typescript
type WalletCapabilities = {
  hasLocalKeys: boolean;
  localAccounts: Address[];
  delegationCount: number;
  delegations?: DelegationInfo[];
  hasPeerWallet: boolean;
  hasExternalSigner: boolean;
  hasBundlerConfig: boolean;
  smartAccountAddress?: Address;
  chainId?: number;
  signingMode?: string;
  autonomy?: string;
  peerAccountsCached?: boolean;
  cachedPeerAccounts?: Address[];
  hasAwayWallet?: boolean;
};
```

## Library Utilities

The package exports standalone utility functions that can be used outside of the vat context.

### Caveat Encoding

```typescript
import {
  encodeAllowedTargets,
  encodeAllowedMethods,
  encodeValueLte,
  encodeNativeTokenTransferAmount,
  encodeErc20TransferAmount,
  encodeLimitedCalls,
  encodeTimestamp,
  makeCaveat,
  getEnforcerAddress,
} from '@ocap/evm-wallet-experiment';

// Build a complete Caveat struct from type + encoded terms
const caveat = makeCaveat({
  type: 'allowedTargets',
  terms: encodeAllowedTargets(['0x...' as Address]),
  chainId: 1, // optional: looks up enforcer address by chain
});
```

### ERC-20 Utilities

```typescript
import {
  encodeTransfer,
  encodeApprove,
  encodeAllowance,
  encodeBalanceOf,
  decodeTransferCalldata,
  decodeAllowanceResult,
  makeErc20TransferExecution,
  isErc20TransferCalldata,
  ERC20_TRANSFER_SELECTOR,
  ERC20_APPROVE_SELECTOR,
  ERC20_ALLOWANCE_SELECTOR,
} from '@ocap/evm-wallet-experiment';

// Encode a transfer(address,uint256) call
const callData = encodeTransfer('0xRecipient...' as Address, 1000000n);

// Build an Execution struct for delegation redemption
const execution = makeErc20TransferExecution({
  token: '0xUSDC...' as Address,
  to: '0xRecipient...' as Address,
  amount: 1000000n, // 1 USDC (6 decimals)
});

// Decode transfer calldata
const { to, amount } = decodeTransferCalldata(callData);

// Check if calldata is a transfer
isErc20TransferCalldata(callData); // true
```

### Delegation Utilities

```typescript
import {
  makeDelegation,
  prepareDelegationTypedData,
  delegationMatchesAction,
  explainDelegationMatch,
  finalizeDelegation,
  computeDelegationId,
  generateSalt,
} from '@ocap/evm-wallet-experiment';

// Create an unsigned delegation
const delegation = makeDelegation({
  delegator: '0xDelegator...' as Address,
  delegate: '0xDelegate...' as Address,
  caveats: [],
  chainId: 1,
});

// Prepare EIP-712 typed data for signing
const typedData = prepareDelegationTypedData({
  delegation,
  verifyingContract: '0xDelegationManager...' as Address,
});

// Check if a delegation covers an action (client-side, best-effort)
const matches = delegationMatchesAction(delegation, {
  to: '0xTarget...' as Address,
  value: '0x0' as Hex,
  data: '0x...' as Hex,
});
```

### UserOp Building

```typescript
import {
  buildDelegationUserOp,
  buildRedeemCallData,
  computeUserOpHash,
  encodeDelegationChain,
  encodeExecution,
  ENTRY_POINT_V07,
} from '@ocap/evm-wallet-experiment';

// Build an unsigned UserOp for delegation redemption
const userOp = buildDelegationUserOp({
  sender: '0xSmartAccount...' as Address,
  nonce: '0x0' as Hex,
  delegations: [signedDelegation],
  execution: {
    target: '0x...' as Address,
    value: '0x0' as Hex,
    callData: '0x...' as Hex,
  },
  maxFeePerGas: '0x3b9aca00' as Hex,
  maxPriorityFeePerGas: '0x3b9aca00' as Hex,
});

// Compute the hash for signing (ERC-4337 v0.7 packing)
const hash = computeUserOpHash(userOp, ENTRY_POINT_V07, 1);
```

### Bundler Client

Use `makeBundlerClient` for ERC-4337 bundler interactions (replaces the legacy `submitUserOp` / `estimateUserOpGas` helpers). The bundler client also exports a `UserOpReceiptResult` type for typed receipt results.

```typescript
import {
  makeBundlerClient,
  ENTRY_POINT_V07,
  type UserOpReceiptResult,
} from '@ocap/evm-wallet-experiment';

const client = makeBundlerClient({
  bundlerUrl: 'https://api.pimlico.io/v2/sepolia/rpc',
  chainId: 11155111,
  apiKey: 'YOUR_PIMLICO_KEY',
});

// Estimate gas
const gas = await client.estimateUserOperationGas({
  userOp: unsignedUserOp,
  entryPointAddress: ENTRY_POINT_V07,
});

// Sponsor via paymaster (Pimlico)
const sponsorship = await client.sponsorUserOperation({
  userOp: unsignedUserOp,
  entryPointAddress: ENTRY_POINT_V07,
  context: { sponsorshipPolicyId: 'sp_my_policy' },
});

// Submit
const userOpHash = await client.sendUserOperation({
  userOp: signedUserOp,
  entryPointAddress: ENTRY_POINT_V07,
});

// Wait for inclusion
const receipt = await client.waitForUserOperationReceipt({
  hash: userOpHash,
  pollingInterval: 2000,
  timeout: 60000,
});
```

### SDK Adapter

Utilities for interacting with the MetaMask Delegation Framework SDK, including batch operations and smart account address computation.

```typescript
import {
  buildBatchExecuteCallData,
  buildSdkBatchRedeemCallData,
  buildSdkRedeemCallData,
  buildSdkDisableCallData,
  createSdkExecution,
  computeSmartAccountAddress,
  toSdkDelegation,
  encodeSdkDelegations,
  resolveEnvironment,
  getDelegationManagerAddress,
  getEnforcerAddresses,
  Implementation,
  ExecutionMode,
} from '@ocap/evm-wallet-experiment';

// Build callData for batch execution (multiple executions in one UserOp)
const callData = buildBatchExecuteCallData([execution1, execution2]);

// Build callData for batch delegation redemption (multiple delegations in one UserOp)
const redeemCallData = buildSdkBatchRedeemCallData({
  delegations: [[sdkDelegation1], [sdkDelegation2]],
  executions: [execution1, execution2],
  modes: [ExecutionMode.CALL, ExecutionMode.CALL],
  environment,
});
```

### MetaMask Signer Adapter

```typescript
import {
  connectMetaMaskSigner,
  makeProviderSigner,
} from '@ocap/evm-wallet-experiment';

// High-level: connect via MetaMask SDK
const signer = await connectMetaMaskSigner({
  dappMetadata: { name: 'My dApp', url: 'https://example.com' },
  infuraAPIKey: 'YOUR_KEY',
});

// Low-level: wrap any EIP-1193 provider
const signer = makeProviderSigner(window.ethereum, {
  disconnect: () => {
    /* cleanup */
  },
});

const accounts = await signer.getAccounts();
const signature = await signer.signTypedData(typedData, accounts[0]);
signer.disconnect();
```

## OpenClaw Plugin

The `openclaw-plugin/` directory contains an [OpenClaw](https://openclaw.dev) plugin that exposes wallet operations as AI agent tools. The plugin communicates with the OCAP daemon via `ocap daemon exec` commands.

### Plugin Structure

| File                | Purpose                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| `index.ts`          | Tool registration — defines all `wallet_*` tools                                       |
| `daemon.ts`         | Daemon communication layer — spawns CLI, decodes CapData responses                     |
| `token-resolver.ts` | Token symbol resolution via the [MetaMask Token API](https://token.api.cx.metamask.io) |

### Tools

| Tool                   | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `wallet_accounts`      | List wallet accounts                                                            |
| `wallet_balance`       | Get ETH balance for an address                                                  |
| `wallet_send`          | Send ETH to an address                                                          |
| `wallet_token_resolve` | Resolve a token symbol (e.g. "USDC") to a contract address on the current chain |
| `wallet_token_balance` | Get ERC-20 token balance (accepts address or symbol)                            |
| `wallet_token_send`    | Send ERC-20 tokens (accepts address or symbol)                                  |
| `wallet_token_info`    | Get token metadata (name, symbol, decimals)                                     |
| `wallet_swap_quote`    | Get a token swap quote (source/dest token, amount, slippage)                    |
| `wallet_swap`          | Execute a token swap with automatic approval handling                           |
| `wallet_sign`          | Sign a message                                                                  |
| `wallet_capabilities`  | Check wallet capabilities                                                       |

### Token Symbol Resolution

All token tools (`wallet_token_balance`, `wallet_token_send`, `wallet_token_info`) accept either a contract address (`0x...`) or a token symbol/name (e.g. `"USDC"`, `"DAI"`). Symbol resolution uses the **MetaMask Token API** — a single search request returns contract addresses with metadata for the wallet's chain. Testnets are not indexed; provide contract addresses directly on test networks.

The dedicated `wallet_token_resolve` tool can be used to search for tokens by name or symbol explicitly.

## Cluster Configuration

Use `makeWalletClusterConfig` to generate the `ClusterConfig` for launching the subcluster.

```typescript
import { makeWalletClusterConfig } from '@ocap/evm-wallet-experiment';

const config = makeWalletClusterConfig({
  bundleBaseUrl: 'https://example.com/bundles',
  delegationManagerAddress: '0x...', // optional, defaults to placeholder
  services: ['ocapURLIssuerService', 'ocapURLRedemptionService'], // default
});

const { rootKref } = await kernel.launchSubcluster(config);
```

The configuration creates four vats: `coordinator`, `keyring`, `provider`, and either `delegator` (home role — default) or `redeemer` (away role). The coordinator is registered as the bootstrap vat. Every vat can use `TextEncoder` and `TextDecoder` for binary encoding without endowing them, because SES permits both in every compartment. The `keyring` vat receives `crypto` for throwaway-key generation; the `delegator` vat receives `crypto` for delegation-salt generation (the `redeemer` vat does not). The `coordinator` vat receives `Date` and `setTimeout` for on-chain confirmation polling.

## SES Compatibility

All vat code runs under [SES lockdown](https://github.com/endojs/endo/tree/master/packages/ses). Key considerations:

- **Vat code** uses `makeDefaultExo` from `@metamask/kernel-utils/exo` to create remotable objects, and `E()` from `@endo/eventual-send` for cross-vat communication. All vat root objects are exos.
- **Library utilities** (in `src/lib/`) use the `harden()` pattern for lockdown compatibility. The `harden` function is obtained from `globalThis.harden` with a passthrough fallback for environments without lockdown.
- **MetaMask SDK** cannot run inside a SES compartment. It is connected as an **external signer reference** that lives outside the vat boundary. The coordinator stores a reference to it but never loads it into a locked-down compartment.
- **viem** is used within vat compartments for ABI encoding, hashing, and HD key derivation. It is compatible with the SES environment as configured.

## Development

```bash
# Build vat bundles
yarn workspace @ocap/evm-wallet-experiment build

# Lint
yarn workspace @ocap/evm-wallet-experiment lint:fix
```

For Docker Compose setup (local demo and E2E tests), see [docs/docker.md](./docs/docker.md). Docker Model Runner with `ai/qwen3.5:4B-UD-Q4_K_XL` is required for the local demo's OpenClaw AI agent.

## Testing

The package has four tiers of tests, each exercising a progressively larger slice of the stack.

### Unit tests (490+ tests)

```bash
yarn workspace @ocap/evm-wallet-experiment test:dev:quiet
```

Fast, in-process tests using vitest. All inter-vat `E()` calls are mocked. Covers every `lib/` module and every vat's `buildRootObject` logic in isolation — keyring operations, signing, mnemonic encryption/decryption, delegation creation/matching, caveat encoding, UserOp building, bundler client, SDK adapter, MetaMask signer, and coordinator strategy resolution.

### Single-kernel integration (34 assertions)

```bash
yarn workspace @ocap/evm-wallet-experiment test:node
```

Plain Node.js script that runs under **real SES lockdown** in a **real kernel**. Launches the wallet subcluster (4 vats), exercises the full coordinator API via `kernel.queueMessage()`, and verifies inter-vat `E()` communication actually works end-to-end. Covers: keyring init (SRP + throwaway), signing (message, transaction, EIP-712), delegation lifecycle (create, sign, list), capabilities introspection, and no-authority error handling.

### Peer wallet over QUIC (27 assertions)

```bash
yarn workspace @ocap/evm-wallet-experiment test:node:peer
```

Two separate kernel instances connected via QUIC direct transport. Tests the home/away wallet architecture: OCAP URL issuance and redemption, remote message signing forwarded over CapTP, remote EIP-712 signing, transaction signing rejection (no peer fallback), delegation creation on the home wallet and transfer to the away wallet, and combined throwaway-key + peer + delegation capabilities. Verifies that remote signatures are identical to local signatures (same signing key, same result).

### Daemon integration (23 assertions)

```bash
yarn workspace @ocap/evm-wallet-experiment test:node:daemon
```

Exercises the wallet through the **daemon JSON-RPC socket** — the same interface an agent process uses in production. Boots a kernel with an RPC socket server, launches the wallet subcluster via `launchSubcluster` RPC, then calls wallet methods via `queueMessage` RPC over the Unix socket. Covers: daemon status, subcluster lifecycle, keyring init, signing, delegation creation, capabilities, error propagation through the RPC layer, and subcluster termination.

### Sepolia E2E (13 assertions, requires API keys)

```bash
PIMLICO_API_KEY=xxx SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx \
  yarn workspace @ocap/evm-wallet-experiment test:node:sepolia
```

Full on-chain test on Sepolia testnet. Creates a Hybrid smart account (standalone single-device test), creates and signs a delegation, redeems it by submitting an ERC-4337 UserOp to the Pimlico bundler with paymaster gas sponsorship, and waits for on-chain inclusion. Skips automatically if `PIMLICO_API_KEY` and `SEPOLIA_RPC_URL` are not set.

### Sepolia E2E — 7702 direct (no Pimlico)

```bash
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx TEST_MNEMONIC="..." \
  yarn workspace @ocap/evm-wallet-experiment test:node:sepolia-7702-direct
```

On-chain flow using `implementation: 'stateless7702'`: EIP-7702 upgrade tx, delegation creation, redemption via `eth_sendRawTransaction` through your RPC only (no bundler). Skips if `SEPOLIA_RPC_URL` is unset.

### Peer wallet Sepolia E2E (41 assertions, requires API keys)

```bash
PIMLICO_API_KEY=xxx SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx \
  MNEMONIC="your twelve word mnemonic" \
  yarn workspace @ocap/evm-wallet-experiment test:node:peer-e2e
```

The most comprehensive test: two kernels connected via local QUIC, exercising the complete home/away flow against Sepolia. Covers OCAP URL peer connection, remote message signing forwarded via CapTP, transaction signing rejection (no peer fallback), provider RPC queries, cross-kernel delegation transfer and revocation, smart account creation, self-delegation redemption via UserOp, and on-chain inclusion. Skips if any of `PIMLICO_API_KEY`, `SEPOLIA_RPC_URL`, or `MNEMONIC` is missing. Takes ~30–90 s depending on network conditions.

### Vitest integration (5 tests)

```bash
yarn workspace @ocap/evm-wallet-experiment test:integration
```

Vitest-based peer wallet tests in `test/integration/peer-wallet.test.ts`. Requires building bundles first (`yarn build`). Tests OCAP URL connection, remote message/transaction signing via CapTP, no-authority errors, and capabilities reporting across two kernels.

### Docker E2E (3 delegation modes × home/away pair)

```bash
# Start the full stack (Anvil + bundler + 6 kernel containers)
yarn workspace @ocap/evm-wallet-experiment docker:up

# Run all three delegation modes in parallel
yarn workspace @ocap/evm-wallet-experiment test:e2e:docker

# Run a single mode
DELEGATION_MODE=bundler-7702 yarn workspace @ocap/evm-wallet-experiment test:e2e:docker
# or: bundler-hybrid, peer-relay

# Tear down
yarn workspace @ocap/evm-wallet-experiment docker:down
```

Full home/away delegation flow across three delegation modes (`bundler-7702`, `bundler-hybrid`, `peer-relay`) running in parallel. The stack requires Docker Model Runner. See [docs/docker.md](./docs/docker.md) for prerequisites, stack details, and troubleshooting. For manual interactive simulation, see [docs/demo-local.md](./docs/demo-local.md).

## Supported Chains

The wallet supports all chains where the MetaMask Delegation Framework is deployed:

| Chain ID | Network           | Swap Support |
| -------- | ----------------- | ------------ |
| 1        | Ethereum          | Yes          |
| 10       | Optimism          | Yes          |
| 56       | BNB Smart Chain   | Yes          |
| 137      | Polygon           | Yes          |
| 8453     | Base              | Yes          |
| 42161    | Arbitrum One      | Yes          |
| 59144    | Linea             | Yes          |
| 11155111 | Sepolia (testnet) | No           |

All chains share the same DelegationManager and enforcer addresses (deterministic CREATE2 deployment, including Sepolia). Swap support (via MetaSwap API) is only available on mainnets.

Use `SUPPORTED_CHAIN_IDS`, `CHAIN_NAMES`, and `getChainContracts(chainId)` to query chain support programmatically. Use `getPimlicoRpcUrl(chainId)` for Pimlico bundler URLs.

## Constants

The package exports chain contract addresses used by the Delegation Framework:

| Export                       | Description                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `SUPPORTED_CHAIN_IDS`        | Array of all supported chain IDs.                                                |
| `CHAIN_NAMES`                | Human-readable chain names keyed by chain ID.                                    |
| `CHAIN_CONTRACTS`            | Registry of contract addresses keyed by chain ID.                                |
| `getChainContracts(chainId)` | Get contracts for a chain, falling back to placeholders.                         |
| `getPimlicoRpcUrl(chainId)`  | Get the Pimlico bundler RPC URL for a given chain.                               |
| `SEPOLIA_CHAIN_ID`           | Sepolia testnet chain ID (`11155111`).                                           |
| `PIMLICO_RPC_BASE_URL`       | _(deprecated)_ Base URL for the Pimlico bundler on Sepolia.                      |
| `ENTRY_POINT_V07`            | ERC-4337 EntryPoint v0.7 address (`0x0000000071727de22e5e9d8baf0edac6f37da032`). |
| `ROOT_AUTHORITY`             | The root authority hash (no parent delegation): `0xfff...fff`.                   |
| `DELEGATION_TYPES`           | EIP-712 type definitions for the Delegation Framework.                           |
| `ETH_HD_PATH_PREFIX`         | BIP-44 HD path for Ethereum: `m/44'/60'/0'/0`.                                   |

## Recent Improvements

- **Batch execution** -- `sendBatchTransaction` batches multiple transactions into a single UserOp for smart accounts. Token swaps that require an ERC-20 approval now batch the approve + swap into one UserOp (indicated by `batched: true` in the `SwapResult`). EOA wallets without a smart account fall back to sequential execution.
- **EIP-7702 authorization** -- The authorization flow now checks for reverted transactions instead of silently timing out, providing faster and more informative error reporting.
- **Error handling** -- Decryption with a wrong password now returns a clear error message. EIP-7702 gas estimation failures are no longer silently swallowed for all error types.
- **Timer cleanup** -- The internal `raceWithTimeout` helper (used for peer communication timeouts) now properly cleans up timers to prevent resource leaks.
- **SES lockdown compliance** -- Module-level counters (`bundlerRequestId`, `rpcRequestId`) have been moved into per-client-instance closures, eliminating shared mutable state that conflicts with SES lockdown requirements.
- **Explicit vat endowments** -- Throwaway keyrings and delegation salts now use `crypto.getRandomValues` directly, enabled by adding `crypto` to the `keyring` and `delegator` vats' globals. Removes the prior caller-supplied `entropy` escape hatch and the counter-based salt fallback.

## Disclaimer

This package is experimental software developed with the assistance of AI code generation tools. While it includes extensive test coverage (unit, integration, and on-chain E2E tests), it has not been formally audited. It may contain bugs, security vulnerabilities, or unexpected behavior.

This software is provided "as is", without warranty of any kind. The authors are not responsible for any loss of funds, data, or other damages resulting from its use. Do not use this package in production or with real assets without conducting your own thorough review and testing.
