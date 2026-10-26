import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Logger } from '@metamask/logger';
import type { Baggage } from '@metamask/ocap-kernel';
import type { SignedAuthorization } from 'viem';

import { makeKeyring } from '../lib/keyring.ts';
import type {
  EncryptedKeyringInit,
  Keyring,
  KeyringInitOptions,
  StoredKeyringInit,
} from '../lib/keyring.ts';
import { encryptMnemonic, decryptMnemonic } from '../lib/mnemonic-crypto.ts';
import {
  signAuthorization,
  signHash,
  signTransaction,
  signMessage,
  signTypedData,
} from '../lib/signing.ts';
import type {
  Address,
  Eip712TypedData,
  Hex,
  TransactionRequest,
} from '../types.ts';

/**
 * Vat powers for the keyring vat.
 */
type VatPowers = {
  logger?: Logger;
};

/**
 * Build the root object for the keyring vat.
 *
 * The keyring vat isolates private keys. Keys never leave this vat.
 * Other vats send unsigned payloads and receive signed bytes.
 *
 * @param _vatPowers - Special powers granted to this vat.
 * @param _parameters - Initialization parameters.
 * @param baggage - Root of vat's persistent state.
 * @returns The root object for the keyring vat.
 */
export function buildRootObject(
  _vatPowers: VatPowers,
  _parameters: unknown,
  baggage: Baggage,
): object {
  let keyring: Keyring | undefined;
  let locked = false;

  /**
   * Check if stored data is encrypted.
   *
   * @param data - The stored keyring init data.
   * @returns True if the data is encrypted.
   */
  function isEncrypted(data: StoredKeyringInit): data is EncryptedKeyringInit {
    return 'encrypted' in data && data.encrypted;
  }

  /**
   * Rebuild the keyring from plaintext init options and re-derive accounts.
   *
   * @param initOptions - The plaintext keyring init options.
   */
  function rebuildKeyring(initOptions: KeyringInitOptions): void {
    keyring = makeKeyring(initOptions);
    if (baggage.has('accountCount')) {
      const count = baggage.get('accountCount') as number;
      const startIndex =
        initOptions.type === 'srp' ? (initOptions.addressIndex ?? 0) : 0;
      for (let i = startIndex + 1; i < startIndex + count; i++) {
        keyring.deriveAccount(i);
      }
    }
  }

  /**
   * Throw if the keyring is locked.
   */
  function assertUnlocked(): void {
    if (locked) {
      throw new Error('Keyring is locked');
    }
  }

  // Restore keyring from baggage if previously initialized
  if (baggage.has('keyringInit')) {
    const stored = baggage.get('keyringInit') as StoredKeyringInit;
    if (isEncrypted(stored)) {
      // Encrypted — keyring stays undefined until unlock() is called
      locked = true;
    } else {
      rebuildKeyring(stored);
    }
  }

  return makeDefaultExo('walletKeyring', {
    async bootstrap(): Promise<void> {
      // No services needed for the keyring vat
    },

    async initialize(
      options: KeyringInitOptions,
      password?: string,
      salt?: string,
      pbkdf2Iterations?: number,
    ): Promise<void> {
      if (keyring || locked) {
        throw new Error('Keyring already initialized');
      }
      keyring = makeKeyring(options);

      // Determine what to persist: encrypted if password provided for SRP
      let stored: StoredKeyringInit;
      if (password && options.type === 'srp') {
        if (!salt) {
          throw new Error(
            'A random salt is required when encrypting the mnemonic',
          );
        }
        stored =
          options.addressIndex === undefined
            ? {
                ...encryptMnemonic({
                  mnemonic: options.mnemonic,
                  password,
                  salt,
                  pbkdf2Iterations,
                }),
                type: 'srp',
              }
            : {
                ...encryptMnemonic({
                  mnemonic: options.mnemonic,
                  password,
                  salt,
                  pbkdf2Iterations,
                }),
                type: 'srp',
                addressIndex: options.addressIndex,
              };
      } else {
        stored = options;
      }

      if (baggage.has('keyringInit')) {
        baggage.set('keyringInit', stored);
      } else {
        baggage.init('keyringInit', stored);
      }
    },

    async unlock(password: string, pbkdf2Iterations?: number): Promise<void> {
      if (!locked) {
        throw new Error('Keyring is not locked');
      }
      if (!baggage.has('keyringInit')) {
        throw new Error('No keyring data in baggage');
      }
      const stored = baggage.get('keyringInit') as EncryptedKeyringInit;
      const mnemonic = decryptMnemonic({
        data: stored,
        password,
        pbkdf2Iterations,
      });
      rebuildKeyring(
        stored.addressIndex === undefined
          ? { type: 'srp', mnemonic }
          : { type: 'srp', mnemonic, addressIndex: stored.addressIndex },
      );
      locked = false;
    },

    async isLocked(): Promise<boolean> {
      return locked;
    },

    async hasKeys(): Promise<boolean> {
      return keyring?.hasKeys() ?? false;
    },

    async deriveAccount(index: number): Promise<Address> {
      assertUnlocked();
      if (!keyring) {
        throw new Error('Keyring not initialized');
      }
      const address = keyring.deriveAccount(index);

      // Persist the derived account count
      const accounts = keyring.getAccounts();
      if (baggage.has('accountCount')) {
        baggage.set('accountCount', accounts.length);
      } else {
        baggage.init('accountCount', accounts.length);
      }

      return address;
    },

    async getAccounts(): Promise<Address[]> {
      if (!keyring) {
        return [];
      }
      return keyring.getAccounts();
    },

    async signTransaction(tx: TransactionRequest): Promise<Hex> {
      assertUnlocked();
      if (!keyring) {
        throw new Error('Keyring not initialized');
      }
      const account = keyring.getAccount(tx.from);
      if (!account) {
        throw new Error(`No key for account ${tx.from}`);
      }
      return signTransaction({ account, tx });
    },

    async signTypedData(
      typedData: Eip712TypedData,
      from?: Address,
    ): Promise<Hex> {
      assertUnlocked();
      if (!keyring) {
        throw new Error('Keyring not initialized');
      }
      const accounts = keyring.getAccounts();
      const address = from ?? accounts[0];
      if (!address) {
        throw new Error('No accounts available');
      }
      const account = keyring.getAccount(address);
      if (!account) {
        throw new Error(`No key for account ${address}`);
      }
      return signTypedData({ account, typedData });
    },

    async signHash(hash: Hex, from?: Address): Promise<Hex> {
      assertUnlocked();
      if (!keyring) {
        throw new Error('Keyring not initialized');
      }
      const accounts = keyring.getAccounts();
      const address = from ?? accounts[0];
      if (!address) {
        throw new Error('No accounts available');
      }
      const account = keyring.getAccount(address);
      if (!account) {
        throw new Error(`No key for account ${address}`);
      }
      return signHash({ account, hash });
    },

    async signMessage(message: string, from?: Address): Promise<Hex> {
      assertUnlocked();
      if (!keyring) {
        throw new Error('Keyring not initialized');
      }
      const accounts = keyring.getAccounts();
      const address = from ?? accounts[0];
      if (!address) {
        throw new Error('No accounts available');
      }
      const account = keyring.getAccount(address);
      if (!account) {
        throw new Error(`No key for account ${address}`);
      }
      return signMessage({ account, message });
    },

    async signAuthorization(options: {
      contractAddress: Address;
      chainId: number;
      nonce: number;
      from?: Address;
    }): Promise<SignedAuthorization> {
      assertUnlocked();
      if (!keyring) {
        throw new Error('Keyring not initialized');
      }
      const accounts = keyring.getAccounts();
      const address = options.from ?? accounts[0];
      if (!address) {
        throw new Error('No accounts available');
      }
      const account = keyring.getAccount(address);
      if (!account) {
        throw new Error(`No key for account ${address}`);
      }
      return signAuthorization({
        account,
        contractAddress: options.contractAddress,
        chainId: options.chainId,
        nonce: options.nonce,
      });
    },
  });
}
