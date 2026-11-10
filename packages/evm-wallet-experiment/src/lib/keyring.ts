import {
  english,
  generateMnemonic,
  mnemonicToAccount,
  privateKeyToAccount,
  generatePrivateKey,
} from 'viem/accounts';
import type { HDAccount, PrivateKeyAccount } from 'viem/accounts';

import type { EncryptedMnemonicData } from './mnemonic-crypto.ts';
import type { Address } from '../types.ts';

const harden = globalThis.harden ?? (<T>(value: T): T => value);

/**
 * Options for initializing a keyring.
 *
 * Throwaway keyrings are intentionally ephemeral: each call to `makeKeyring`
 * generates a fresh private key, so the key does not survive a vat restart.
 * Baggage only persists `{ type: 'throwaway' }`; callers that need key
 * stability across restarts must use `type: 'srp'`.
 */
export type KeyringInitOptions =
  | { type: 'srp'; mnemonic: string; addressIndex?: number }
  | { type: 'throwaway' };

/**
 * Encrypted keyring init data stored in baggage when a password is used.
 */
export type EncryptedKeyringInit = EncryptedMnemonicData & {
  type: 'srp';
  /** BIP-44 address index used when the keyring was first initialized. */
  addressIndex?: number;
};

/**
 * The shape of keyring init data stored in baggage — either plaintext or encrypted.
 */
export type StoredKeyringInit = KeyringInitOptions | EncryptedKeyringInit;

/**
 * A keyring manages private keys and signing. Keys never leave this module.
 */
export type Keyring = {
  getAccounts: () => Address[];
  deriveAccount: (index: number) => Address;
  getAccount: (address: Address) => HDAccount | PrivateKeyAccount | undefined;
  hasKeys: () => boolean;
  getMnemonic: () => string | undefined;
};

/**
 * Create a new keyring from an SRP mnemonic or a throwaway key.
 *
 * @param options - Initialization options.
 * @returns The keyring instance.
 */
export function makeKeyring(options: KeyringInitOptions): Keyring {
  const accounts = new Map<Address, HDAccount | PrivateKeyAccount>();
  let mnemonic: string | undefined;

  if (options.type === 'srp') {
    mnemonic = options.mnemonic;
    const startIndex = options.addressIndex ?? 0;
    deriveAccountInternal(startIndex);
  } else {
    if (!globalThis.crypto?.getRandomValues) {
      throw new Error(
        'Throwaway keyring requires the "crypto" global endowment; ' +
          "add 'crypto' to this vat's globals in cluster-config.ts",
      );
    }
    const account = privateKeyToAccount(generatePrivateKey());
    accounts.set(account.address.toLowerCase() as Address, account);
  }

  /**
   * Derive an account at the given BIP-44 index.
   *
   * @param index - The address index to derive.
   * @returns The derived account address.
   */
  function deriveAccountInternal(index: number): Address {
    if (!mnemonic) {
      throw new Error('Cannot derive accounts from a throwaway keyring');
    }
    const account: HDAccount = mnemonicToAccount(mnemonic, {
      addressIndex: index,
    });
    const address = account.address.toLowerCase() as Address;
    accounts.set(address, account);
    return address;
  }

  return harden({
    getAccounts(): Address[] {
      return [...accounts.keys()];
    },

    deriveAccount(index: number): Address {
      return deriveAccountInternal(index);
    },

    getAccount(address: Address): HDAccount | PrivateKeyAccount | undefined {
      return accounts.get(address.toLowerCase() as Address);
    },

    hasKeys(): boolean {
      return accounts.size > 0;
    },

    getMnemonic(): string | undefined {
      return mnemonic;
    },
  });
}

/**
 * Generate a new random BIP-39 mnemonic phrase (12 words).
 *
 * @returns The mnemonic string.
 */
export function generateMnemonicPhrase(): string {
  return generateMnemonic(english);
}
