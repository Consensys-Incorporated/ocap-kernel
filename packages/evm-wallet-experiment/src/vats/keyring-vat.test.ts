import { describe, it, expect, beforeEach } from 'vitest';

import { buildRootObject } from './keyring-vat.ts';
import { makeMockBaggage } from '../../test/helpers.ts';

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
// Use fast PBKDF2 iterations for testing. Production uses 600,000.
const TEST_PBKDF2_ITERATIONS = 1_000;

describe('keyring-vat', () => {
  let baggage: ReturnType<typeof makeMockBaggage>;
  let root: ReturnType<typeof buildRootObject>;

  beforeEach(() => {
    baggage = makeMockBaggage();
    // oxlint-disable-next-line typescript/no-explicit-any
    root = buildRootObject({}, undefined, baggage as any);
  });

  describe('bootstrap', () => {
    it('completes without error', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      expect(await (root as any).bootstrap()).toBeUndefined();
    });
  });

  describe('initialize', () => {
    it('initializes with SRP mnemonic', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      // oxlint-disable-next-line typescript/no-explicit-any
      const hasKeys = await (root as any).hasKeys();
      expect(hasKeys).toBe(true);
    });

    it('initializes with throwaway key', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'throwaway' });

      // oxlint-disable-next-line typescript/no-explicit-any
      const hasKeys = await (root as any).hasKeys();
      expect(hasKeys).toBe(true);
    });

    it('throws if already initialized', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'throwaway' });

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).initialize({ type: 'throwaway' }),
      ).rejects.toThrow('Keyring already initialized');
    });

    it('persists init options in baggage', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      expect(baggage.has('keyringInit')).toBe(true);
    });
  });

  describe('getAccounts', () => {
    it('returns empty array when not initialized', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const accounts = await (root as any).getAccounts();
      expect(accounts).toStrictEqual([]);
    });

    it('returns accounts after SRP initialization', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      // oxlint-disable-next-line typescript/no-explicit-any
      const accounts = await (root as any).getAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatch(/^0x[\da-f]{40}$/iu);
    });
  });

  describe('deriveAccount', () => {
    it('derives a new account at a given index', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      // oxlint-disable-next-line typescript/no-explicit-any
      const address = await (root as any).deriveAccount(1);
      expect(address).toMatch(/^0x[\da-f]{40}$/iu);

      // oxlint-disable-next-line typescript/no-explicit-any
      const accounts = await (root as any).getAccounts();
      expect(accounts).toHaveLength(2);
    });

    it('throws when not initialized', async () => {
      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).deriveAccount(0),
      ).rejects.toThrow('Keyring not initialized');
    });
  });

  describe('signTransaction', () => {
    it('signs a transaction', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      // oxlint-disable-next-line typescript/no-explicit-any
      const accounts = await (root as any).getAccounts();

      // oxlint-disable-next-line typescript/no-explicit-any
      const signed = await (root as any).signTransaction({
        from: accounts[0],
        to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        value: '0xde0b6b3a7640000',
        chainId: 1,
        nonce: 0,
        maxFeePerGas: '0x3b9aca00',
        maxPriorityFeePerGas: '0x3b9aca00',
      });

      expect(signed).toMatch(/^0x/u);
    });

    it('throws for unknown account', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).signTransaction({
          from: '0x0000000000000000000000000000000000000000',
          to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
          chainId: 1,
          nonce: 0,
        }),
      ).rejects.toThrow('No key for account');
    });
  });

  describe('signHash', () => {
    it('signs a raw hash without EIP-191 prefix', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      const hash =
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      // oxlint-disable-next-line typescript/no-explicit-any
      const signature = await (root as any).signHash(hash);
      expect(signature).toMatch(/^0x/u);
      expect(signature).toHaveLength(132);
    });

    it('produces a different signature than signMessage for the same input', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      const input =
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      // oxlint-disable-next-line typescript/no-explicit-any
      const hashSig = await (root as any).signHash(input);
      // oxlint-disable-next-line typescript/no-explicit-any
      const msgSig = await (root as any).signMessage(input);

      expect(hashSig).not.toBe(msgSig);
    });

    it('throws when not initialized', async () => {
      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).signHash('0xabcd'),
      ).rejects.toThrow('Keyring not initialized');
    });
  });

  describe('signMessage', () => {
    it('signs a personal message', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      // oxlint-disable-next-line typescript/no-explicit-any
      const signature = await (root as any).signMessage('Hello, world!');
      expect(signature).toMatch(/^0x/u);
      expect(signature).toHaveLength(132);
    });
  });

  describe('signAuthorization', () => {
    it('signs an EIP-7702 authorization', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      // oxlint-disable-next-line typescript/no-explicit-any
      const auth = await (root as any).signAuthorization({
        contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
        chainId: 11155111,
        nonce: 1,
      });
      expect(auth.address).toBe('0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B');
      expect(auth.chainId).toBe(11155111);
      expect(auth.nonce).toBe(1);
      expect(auth.r).toBeDefined();
      expect(auth.s).toBeDefined();
    });

    it('throws when not initialized', async () => {
      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).signAuthorization({
          contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
          chainId: 11155111,
        }),
      ).rejects.toThrow('Keyring not initialized');
    });
  });

  describe('resuscitation from baggage', () => {
    it('restores keyring from persisted init options', async () => {
      // Initialize and persist
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'srp', mnemonic: TEST_MNEMONIC });

      // oxlint-disable-next-line typescript/no-explicit-any
      const accountsBefore = await (root as any).getAccounts();

      // Create a new root object with the same baggage (simulates resuscitation)
      // oxlint-disable-next-line typescript/no-explicit-any
      const restoredRoot = buildRootObject({}, undefined, baggage as any);

      // oxlint-disable-next-line typescript/no-explicit-any
      const accountsAfter = await (restoredRoot as any).getAccounts();
      expect(accountsAfter).toStrictEqual(accountsBefore);
    });

    it('rebuilds throwaway keyrings with a new address after resuscitation', async () => {
      // Throwaway keys are intentionally ephemeral — baggage only stores
      // `{ type: 'throwaway' }`, so restart produces a fresh random key.
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({ type: 'throwaway' });
      // oxlint-disable-next-line typescript/no-explicit-any
      const accountsBefore = await (root as any).getAccounts();
      expect(accountsBefore).toHaveLength(1);

      // oxlint-disable-next-line typescript/no-explicit-any
      const restoredRoot = buildRootObject({}, undefined, baggage as any);
      // oxlint-disable-next-line typescript/no-explicit-any
      const accountsAfter = await (restoredRoot as any).getAccounts();

      expect(accountsAfter).toHaveLength(1);
      expect(accountsAfter[0]).toMatch(/^0x[\da-f]{40}$/iu);
      expect(accountsAfter).not.toStrictEqual(accountsBefore);
    });
  });

  describe('password encryption', () => {
    const TEST_PASSWORD = 'super-secret-123';
    const TEST_SALT = 'aabbccddaabbccddaabbccddaabbccdd';

    it('stores encrypted data in baggage when password provided', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize(
        { type: 'srp', mnemonic: TEST_MNEMONIC },
        TEST_PASSWORD,
        TEST_SALT,
        TEST_PBKDF2_ITERATIONS,
      );

      const stored = baggage.get('keyringInit') as Record<string, unknown>;
      expect(stored.encrypted).toBe(true);
      expect(stored.type).toBe('srp');
      expect(stored.ciphertext).toBeDefined();
      expect(stored.nonce).toBeDefined();
      expect(stored.salt).toBe(TEST_SALT);
      // Mnemonic should NOT be in the stored data
      expect(stored).not.toHaveProperty('mnemonic');
    });

    it('stores plaintext in baggage when no password provided', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({
        type: 'srp',
        mnemonic: TEST_MNEMONIC,
      });

      const stored = baggage.get('keyringInit') as Record<string, unknown>;
      expect(stored).not.toHaveProperty('encrypted');
      expect(stored.mnemonic).toBe(TEST_MNEMONIC);
    });

    it('requires salt when password is provided', async () => {
      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).initialize(
          { type: 'srp', mnemonic: TEST_MNEMONIC },
          TEST_PASSWORD,
        ),
      ).rejects.toThrow('A random salt is required');
    });

    it('ignores password for throwaway keyrings', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize(
        { type: 'throwaway' },
        TEST_PASSWORD,
        TEST_SALT,
        TEST_PBKDF2_ITERATIONS,
      );

      const stored = baggage.get('keyringInit') as Record<string, unknown>;
      expect(stored).not.toHaveProperty('encrypted');
      expect(stored.type).toBe('throwaway');
    });

    it('resuscitates encrypted baggage into locked state', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize(
        { type: 'srp', mnemonic: TEST_MNEMONIC },
        TEST_PASSWORD,
        TEST_SALT,
        TEST_PBKDF2_ITERATIONS,
      );

      // Simulate resuscitation
      // oxlint-disable-next-line typescript/no-explicit-any
      const restored = buildRootObject({}, undefined, baggage as any);

      // oxlint-disable-next-line typescript/no-explicit-any
      expect(await (restored as any).isLocked()).toBe(true);
      // oxlint-disable-next-line typescript/no-explicit-any
      expect(await (restored as any).hasKeys()).toBe(false);
    });

    it('unlocks with correct password and restores keyring', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize(
        { type: 'srp', mnemonic: TEST_MNEMONIC },
        TEST_PASSWORD,
        TEST_SALT,
        TEST_PBKDF2_ITERATIONS,
      );

      // oxlint-disable-next-line typescript/no-explicit-any
      const accountsBefore = await (root as any).getAccounts();

      // Simulate resuscitation
      // oxlint-disable-next-line typescript/no-explicit-any
      const restored = buildRootObject({}, undefined, baggage as any);

      // oxlint-disable-next-line typescript/no-explicit-any
      await (restored as any).unlock(TEST_PASSWORD, TEST_PBKDF2_ITERATIONS);

      // oxlint-disable-next-line typescript/no-explicit-any
      expect(await (restored as any).isLocked()).toBe(false);
      // oxlint-disable-next-line typescript/no-explicit-any
      expect(await (restored as any).hasKeys()).toBe(true);
      // oxlint-disable-next-line typescript/no-explicit-any
      const accountsAfter = await (restored as any).getAccounts();
      expect(accountsAfter).toStrictEqual(accountsBefore);
    });

    it('throws on unlock with wrong password', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize(
        { type: 'srp', mnemonic: TEST_MNEMONIC },
        TEST_PASSWORD,
        TEST_SALT,
        TEST_PBKDF2_ITERATIONS,
      );

      // oxlint-disable-next-line typescript/no-explicit-any
      const restored = buildRootObject({}, undefined, baggage as any);

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (restored as any).unlock('wrong-password', TEST_PBKDF2_ITERATIONS),
      ).rejects.toThrow(/invalid.*tag|decrypt/iu);
    });

    it('throws on unlock when not locked', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize({
        type: 'srp',
        mnemonic: TEST_MNEMONIC,
      });

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).unlock(TEST_PASSWORD),
      ).rejects.toThrow('Keyring is not locked');
    });

    it('throws on signing while locked', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize(
        { type: 'srp', mnemonic: TEST_MNEMONIC },
        TEST_PASSWORD,
        TEST_SALT,
        TEST_PBKDF2_ITERATIONS,
      );

      // oxlint-disable-next-line typescript/no-explicit-any
      const restored = buildRootObject({}, undefined, baggage as any);

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (restored as any).signMessage('hello'),
      ).rejects.toThrow('Keyring is locked');

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (restored as any).signHash('0xabcd'),
      ).rejects.toThrow('Keyring is locked');

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (restored as any).deriveAccount(1),
      ).rejects.toThrow('Keyring is locked');
    });

    it('re-derives additional accounts after unlock', async () => {
      // Initialize and derive extra accounts
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).initialize(
        { type: 'srp', mnemonic: TEST_MNEMONIC },
        TEST_PASSWORD,
        TEST_SALT,
        TEST_PBKDF2_ITERATIONS,
      );
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).deriveAccount(1);
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).deriveAccount(2);
      // oxlint-disable-next-line typescript/no-explicit-any
      const accountsBefore = await (root as any).getAccounts();
      expect(accountsBefore).toHaveLength(3);

      // Resuscitate and unlock
      // oxlint-disable-next-line typescript/no-explicit-any
      const restored = buildRootObject({}, undefined, baggage as any);
      // oxlint-disable-next-line typescript/no-explicit-any
      await (restored as any).unlock(TEST_PASSWORD, TEST_PBKDF2_ITERATIONS);

      // oxlint-disable-next-line typescript/no-explicit-any
      const accountsAfter = await (restored as any).getAccounts();
      expect(accountsAfter).toStrictEqual(accountsBefore);
    });
  });
});
