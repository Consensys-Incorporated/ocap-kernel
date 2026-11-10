import type {
  SignedAuthorization,
  TransactionSerializableEIP1559,
  TransactionSerializableEIP7702,
  TransactionSerializableLegacy,
} from 'viem';
import type { HDAccount, LocalAccount, PrivateKeyAccount } from 'viem/accounts';

import type {
  Address,
  Eip712TypedData,
  Hex,
  TransactionRequest,
} from '../types.ts';

/**
 * Sign a transaction with the given account.
 *
 * Detects the transaction type from the request fields:
 * - `authorizationList` present → EIP-7702 (type 4)
 * - `maxFeePerGas` present → EIP-1559 (type 2)
 * - Otherwise → Legacy (type 0)
 *
 * @param options - Signing options.
 * @param options.account - The local account to sign with.
 * @param options.tx - The transaction request.
 * @returns The signed transaction as a hex string.
 */
export async function signTransaction(options: {
  account: LocalAccount;
  tx: TransactionRequest;
}): Promise<Hex> {
  const { account, tx } = options;

  // EIP-7702 (type 4) — authorization list present
  if (tx.authorizationList && tx.authorizationList.length > 0) {
    const eip7702Tx = {
      to: tx.to,
      type: 'eip7702' as const,
      authorizationList:
        tx.authorizationList as unknown as SignedAuthorization[],
      ...(tx.maxFeePerGas === undefined
        ? {}
        : { maxFeePerGas: BigInt(tx.maxFeePerGas) }),
      ...(tx.maxPriorityFeePerGas === undefined
        ? {}
        : { maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) }),
      ...(tx.value === undefined ? {} : { value: BigInt(tx.value) }),
      ...(tx.data === undefined ? {} : { data: tx.data }),
      ...(tx.nonce === undefined ? {} : { nonce: tx.nonce }),
      ...(tx.gasLimit === undefined ? {} : { gas: BigInt(tx.gasLimit) }),
      ...(tx.chainId === undefined ? {} : { chainId: tx.chainId }),
    } as TransactionSerializableEIP7702;
    return account.signTransaction(eip7702Tx);
  }

  // EIP-1559 (type 2)
  if (tx.maxFeePerGas) {
    const eip1559Tx = {
      to: tx.to,
      type: 'eip1559' as const,
      maxFeePerGas: BigInt(tx.maxFeePerGas),
      ...(tx.value === undefined ? {} : { value: BigInt(tx.value) }),
      ...(tx.data === undefined ? {} : { data: tx.data }),
      ...(tx.nonce === undefined ? {} : { nonce: tx.nonce }),
      ...(tx.gasLimit === undefined ? {} : { gas: BigInt(tx.gasLimit) }),
      ...(tx.chainId === undefined ? {} : { chainId: tx.chainId }),
      ...(tx.maxPriorityFeePerGas === undefined
        ? {}
        : { maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) }),
    } as TransactionSerializableEIP1559;
    return account.signTransaction(eip1559Tx);
  }

  // Legacy (type 0)
  const legacyTx = {
    to: tx.to,
    type: 'legacy' as const,
    ...(tx.value === undefined ? {} : { value: BigInt(tx.value) }),
    ...(tx.data === undefined ? {} : { data: tx.data }),
    ...(tx.nonce === undefined ? {} : { nonce: tx.nonce }),
    ...(tx.gasLimit === undefined ? {} : { gas: BigInt(tx.gasLimit) }),
    ...(tx.chainId === undefined ? {} : { chainId: tx.chainId }),
    ...(tx.gasPrice === undefined ? {} : { gasPrice: BigInt(tx.gasPrice) }),
  } as TransactionSerializableLegacy;
  return account.signTransaction(legacyTx);
}

/**
 * Sign a raw hash using ECDSA (no EIP-191 prefix).
 *
 * This is used for UserOp hash signing where the EntryPoint expects
 * a raw ECDSA signature over the hash, not a personal_sign envelope.
 *
 * @param options - Signing options.
 * @param options.account - The local account to sign with.
 * @param options.hash - The hash to sign.
 * @returns The signature as a hex string.
 */
export async function signHash(options: {
  account: HDAccount | PrivateKeyAccount;
  hash: Hex;
}): Promise<Hex> {
  const { account, hash } = options;
  return account.sign({ hash });
}

/**
 * Sign a message using EIP-191 personal sign.
 *
 * @param options - Signing options.
 * @param options.account - The local account to sign with.
 * @param options.message - The message to sign.
 * @returns The signature as a hex string.
 */
export async function signMessage(options: {
  account: LocalAccount;
  message: string;
}): Promise<Hex> {
  const { account, message } = options;
  return account.signMessage({ message });
}

/**
 * Sign EIP-712 typed data.
 *
 * @param options - Signing options.
 * @param options.account - The local account to sign with.
 * @param options.typedData - The EIP-712 typed data payload.
 * @returns The signature as a hex string.
 */
export async function signTypedData(options: {
  account: LocalAccount;
  typedData: Eip712TypedData;
}): Promise<Hex> {
  const { account, typedData } = options;
  return account.signTypedData({
    domain: typedData.domain as Record<string, unknown>,
    types: typedData.types as Record<string, { name: string; type: string }[]>,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}

/**
 * Sign an EIP-7702 authorization to delegate an EOA's code to a contract.
 *
 * @param options - Signing options.
 * @param options.account - The local account to sign with.
 * @param options.contractAddress - The implementation contract address.
 * @param options.chainId - The chain ID for the authorization.
 * @param options.nonce - The authorization nonce (required for self-execution: txNonce + 1).
 * @returns The signed authorization.
 */
export async function signAuthorization(options: {
  account: LocalAccount;
  contractAddress: Address;
  chainId: number;
  nonce: number;
}): Promise<SignedAuthorization> {
  // viem types `HDAccount.signAuthorization` as optional.
  if (!options.account.signAuthorization) {
    throw new Error('Account cannot sign EIP-7702 authorizations');
  }
  return options.account.signAuthorization({
    contractAddress: options.contractAddress,
    chainId: options.chainId,
    nonce: options.nonce,
  });
}
