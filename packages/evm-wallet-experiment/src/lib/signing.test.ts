import { privateKeyToAccount } from 'viem/accounts';
import { describe, it, expect } from 'vitest';

import {
  signAuthorization,
  signHash,
  signTransaction,
  signMessage,
  signTypedData,
} from './signing.ts';

// Deterministic test key (DO NOT use in production)
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const makeTestAccount = () => privateKeyToAccount(TEST_PRIVATE_KEY);

describe('lib/signing', () => {
  describe('signTransaction', () => {
    it('signs an EIP-1559 transaction', async () => {
      const account = makeTestAccount();
      const signed = await signTransaction({
        account,
        tx: {
          from: account.address.toLowerCase() as `0x${string}`,
          to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
          value: '0xde0b6b3a7640000',
          chainId: 1,
          nonce: 0,
          maxFeePerGas: '0x3b9aca00',
          maxPriorityFeePerGas: '0x3b9aca00',
        },
      });

      expect(signed).toMatch(/^0x/u);
      expect(signed.length).toBeGreaterThan(2);
    });

    it('signs a legacy transaction', async () => {
      const account = makeTestAccount();
      const signed = await signTransaction({
        account,
        tx: {
          from: account.address.toLowerCase() as `0x${string}`,
          to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
          value: '0xde0b6b3a7640000',
          chainId: 1,
          nonce: 0,
          gasPrice: '0x3b9aca00',
        },
      });

      expect(signed).toMatch(/^0x/u);
    });

    it('signs an EIP-7702 transaction with authorizationList', async () => {
      const account = makeTestAccount();
      const auth = await signAuthorization({
        account,
        contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
        chainId: 11155111,
        nonce: 0,
      });

      const signed = await signTransaction({
        account,
        tx: {
          from: account.address.toLowerCase() as `0x${string}`,
          to: account.address.toLowerCase() as `0x${string}`,
          chainId: 11155111,
          nonce: 0,
          maxFeePerGas: '0x3b9aca00',
          maxPriorityFeePerGas: '0x3b9aca00',
          gasLimit: '0x19000',
          authorizationList: [auth],
        },
      });

      expect(signed).toMatch(/^0x/u);
      // EIP-7702 transactions start with 0x04 (type 4)
      expect(signed.startsWith('0x04')).toBe(true);
    });

    it('signs an EIP-7702 tx even without maxFeePerGas', async () => {
      const account = makeTestAccount();
      const auth = await signAuthorization({
        account,
        contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
        chainId: 11155111,
        nonce: 0,
      });

      const signed = await signTransaction({
        account,
        tx: {
          from: account.address.toLowerCase() as `0x${string}`,
          to: account.address.toLowerCase() as `0x${string}`,
          chainId: 11155111,
          nonce: 0,
          gasLimit: '0x19000',
          authorizationList: [auth],
        },
      });

      // Still type-4 even without maxFeePerGas
      expect(signed.startsWith('0x04')).toBe(true);
    });

    it('signs a transaction with data', async () => {
      const account = makeTestAccount();
      const signed = await signTransaction({
        account,
        tx: {
          from: account.address.toLowerCase() as `0x${string}`,
          to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
          data: '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001',
          chainId: 1,
          nonce: 0,
          maxFeePerGas: '0x3b9aca00',
          maxPriorityFeePerGas: '0x3b9aca00',
        },
      });

      expect(signed).toMatch(/^0x/u);
    });
  });

  describe('signHash', () => {
    it('signs a raw hash without EIP-191 prefix', async () => {
      const account = makeTestAccount();
      const hash =
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const signature = await signHash({
        account,
        hash: hash as `0x${string}`,
      });

      expect(signature).toMatch(/^0x/u);
      expect(signature).toHaveLength(132);
    });

    it('produces a different signature than signMessage for the same input', async () => {
      const account = makeTestAccount();
      const input =
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

      const hashSig = await signHash({
        account,
        hash: input as `0x${string}`,
      });
      const msgSig = await signMessage({
        account,
        message: input,
      });

      // signHash (raw ECDSA) and signMessage (EIP-191) must differ
      expect(hashSig).not.toBe(msgSig);
    });

    it('produces deterministic signatures', async () => {
      const account = makeTestAccount();
      const hash =
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

      const sig1 = await signHash({ account, hash: hash as `0x${string}` });
      const sig2 = await signHash({ account, hash: hash as `0x${string}` });

      expect(sig1).toBe(sig2);
    });
  });

  describe('signMessage', () => {
    it('signs a personal message', async () => {
      const account = makeTestAccount();
      const signature = await signMessage({
        account,
        message: 'Hello, world!',
      });

      expect(signature).toMatch(/^0x/u);
      // EIP-191 signatures are 65 bytes = 130 hex chars + 0x prefix
      expect(signature).toHaveLength(132);
    });

    it('produces deterministic signatures', async () => {
      const account = makeTestAccount();
      const sig1 = await signMessage({ account, message: 'test' });
      const sig2 = await signMessage({ account, message: 'test' });

      expect(sig1).toBe(sig2);
    });

    it('produces different signatures for different messages', async () => {
      const account = makeTestAccount();
      const sig1 = await signMessage({ account, message: 'hello' });
      const sig2 = await signMessage({ account, message: 'world' });

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('signAuthorization', () => {
    it('signs an EIP-7702 authorization', async () => {
      const account = makeTestAccount();
      const auth = await signAuthorization({
        account,
        contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
        chainId: 11155111,
        nonce: 0,
      });

      expect(auth.address).toBe('0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B');
      expect(auth.chainId).toBe(11155111);
      expect(auth.r).toBeDefined();
      expect(auth.s).toBeDefined();
    });

    it('produces deterministic authorizations', async () => {
      const account = makeTestAccount();
      const auth1 = await signAuthorization({
        account,
        contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
        chainId: 11155111,
        nonce: 0,
      });
      const auth2 = await signAuthorization({
        account,
        contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
        chainId: 11155111,
        nonce: 0,
      });

      expect(auth1.r).toBe(auth2.r);
      expect(auth1.s).toBe(auth2.s);
    });

    it('throws when the account cannot sign authorizations', async () => {
      const account = { ...makeTestAccount(), signAuthorization: undefined };
      await expect(
        signAuthorization({
          account,
          contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
          chainId: 11155111,
          nonce: 0,
        }),
      ).rejects.toThrow('Account cannot sign EIP-7702 authorizations');
    });
  });

  describe('signTypedData', () => {
    it('signs EIP-712 typed data', async () => {
      const account = makeTestAccount();
      const signature = await signTypedData({
        account,
        typedData: {
          domain: {
            name: 'Test',
            version: '1',
            chainId: 1,
            verifyingContract: '0xcccccccccccccccccccccccccccccccccccccccc',
          },
          types: {
            Person: [
              { name: 'name', type: 'string' },
              { name: 'wallet', type: 'address' },
            ],
          },
          primaryType: 'Person',
          message: {
            name: 'Alice',
            wallet: '0xcccccccccccccccccccccccccccccccccccccccc',
          },
        },
      });

      expect(signature).toMatch(/^0x/u);
      expect(signature).toHaveLength(132);
    });
  });
});
