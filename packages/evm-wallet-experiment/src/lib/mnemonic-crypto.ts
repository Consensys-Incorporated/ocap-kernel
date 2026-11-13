import { gcm } from '@noble/ciphers/aes';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';

const harden = globalThis.harden ?? (<T>(value: T): T => value);

const DEFAULT_PBKDF2_ITERATIONS = 600_000;

/**
 * Encrypted mnemonic envelope persisted in baggage.
 */
export type EncryptedMnemonicData = {
  encrypted: true;
  ciphertext: string;
  nonce: string;
  salt: string;
};

/**
 * Convert a hex-encoded string (no 0x prefix) to Uint8Array.
 *
 * @param encoded - Hex-encoded string without 0x prefix.
 * @returns The byte array.
 */
function hexToBytes(encoded: string): Uint8Array {
  const bytes = new Uint8Array(encoded.length / 2);
  for (let i = 0; i < encoded.length; i += 2) {
    bytes[i / 2] = parseInt(encoded.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert a Uint8Array to a hex-encoded string (no 0x prefix).
 *
 * @param bytes - The byte array.
 * @returns Hex-encoded string without 0x prefix.
 */
function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

/**
 * Derive a 16-byte salt from the password using keccak256 with a domain separator.
 * Used as fallback when no external salt is provided.
 *
 * @param passwordBytes - The UTF-8 encoded password.
 * @returns A 16-byte salt.
 */
function deriveSalt(passwordBytes: Uint8Array): Uint8Array {
  const domainSeparator = new TextEncoder().encode('ocap-keyring-salt');
  const input = new Uint8Array(domainSeparator.length + passwordBytes.length);
  input.set(domainSeparator);
  input.set(passwordBytes, domainSeparator.length);
  return keccak256(input).slice(0, 16);
}

/**
 * Derive a 12-byte nonce from salt and derived key using keccak256.
 *
 * @param salt - The salt bytes.
 * @param key - The derived AES key bytes.
 * @returns A 12-byte nonce for AES-GCM.
 */
function deriveNonce(salt: Uint8Array, key: Uint8Array): Uint8Array {
  const input = new Uint8Array(salt.length + key.length);
  input.set(salt);
  input.set(key, salt.length);
  return keccak256(input).slice(0, 12);
}

/**
 * Encrypt a mnemonic with a password using AES-256-GCM + PBKDF2.
 *
 * @param options - Encryption options.
 * @param options.mnemonic - The mnemonic to encrypt.
 * @param options.password - The password for key derivation.
 * @param options.salt - Optional hex-encoded salt (16 bytes). If omitted, derived from password.
 * @param options.pbkdf2Iterations - Optional PBKDF2 iteration count. Defaults to 600,000.
 * @returns The encrypted mnemonic envelope.
 */
export function encryptMnemonic({
  mnemonic,
  password,
  salt: saltEncoded,
  pbkdf2Iterations = DEFAULT_PBKDF2_ITERATIONS,
}: {
  mnemonic: string;
  password: string;
  salt?: string;
  pbkdf2Iterations?: number | undefined;
}): EncryptedMnemonicData {
  const passwordBytes = new TextEncoder().encode(password);
  const salt = saltEncoded
    ? hexToBytes(saltEncoded)
    : deriveSalt(passwordBytes);

  const key = pbkdf2(sha256, passwordBytes, salt, {
    c: pbkdf2Iterations,
    dkLen: 32,
  });

  const nonce = deriveNonce(salt, key);
  const cipher = gcm(key, nonce);
  const plaintext = new TextEncoder().encode(mnemonic);
  const ciphertext = cipher.encrypt(plaintext);

  return harden({
    encrypted: true as const,
    ciphertext: bytesToHex(ciphertext),
    nonce: bytesToHex(nonce),
    salt: bytesToHex(salt),
  });
}

/**
 * Decrypt a mnemonic from an encrypted envelope.
 *
 * @param options - Decryption options.
 * @param options.data - The encrypted mnemonic envelope.
 * @param options.password - The password used during encryption.
 * @param options.pbkdf2Iterations - Optional PBKDF2 iteration count. Must match the value used during encryption.
 * @returns The decrypted mnemonic string.
 */
export function decryptMnemonic({
  data,
  password,
  pbkdf2Iterations = DEFAULT_PBKDF2_ITERATIONS,
}: {
  data: EncryptedMnemonicData;
  password: string;
  pbkdf2Iterations?: number | undefined;
}): string {
  const passwordBytes = new TextEncoder().encode(password);
  const salt = hexToBytes(data.salt);
  const nonce = hexToBytes(data.nonce);
  const ciphertext = hexToBytes(data.ciphertext);

  const key = pbkdf2(sha256, passwordBytes, salt, {
    c: pbkdf2Iterations,
    dkLen: 32,
  });

  const cipher = gcm(key, nonce);
  let plaintext: Uint8Array;
  try {
    plaintext = cipher.decrypt(ciphertext);
  } catch {
    throw new Error('Decryption failed — check that the password is correct');
  }

  return new TextDecoder().decode(plaintext);
}
