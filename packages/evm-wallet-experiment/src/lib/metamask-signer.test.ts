import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  makeProviderSigner,
  connectMetaMaskSigner,
} from './metamask-signer.ts';
import type { EthereumProvider } from './metamask-signer.ts';
import type { Address, Hex } from '../types.ts';

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockGetProvider = vi.fn();
const mockTerminate = vi.fn().mockResolvedValue(undefined);

vi.mock('@metamask/sdk', () => {
  return {
    MetaMaskSDK: class {
      connect = mockConnect;

      getProvider = mockGetProvider;

      terminate = mockTerminate;
    },
  };
});

const ALICE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ALICE_LOWER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address;

const makeTestProvider = (): EthereumProvider & {
  request: Mock<EthereumProvider['request']>;
} => ({
  request: vi.fn<EthereumProvider['request']>(),
});

describe('lib/metamask-signer', () => {
  describe('makeProviderSigner', () => {
    describe('getAccounts', () => {
      it('requests accounts and lowercases them', async () => {
        const provider = makeTestProvider();
        provider.request.mockResolvedValueOnce([ALICE]);

        const signer = makeProviderSigner(provider);
        const accounts = await signer.getAccounts();

        expect(accounts).toStrictEqual([ALICE_LOWER]);
        expect(provider.request).toHaveBeenCalledWith({
          method: 'eth_requestAccounts',
        });
      });

      it('caches accounts after first request', async () => {
        const provider = makeTestProvider();
        provider.request.mockResolvedValueOnce([ALICE]);

        const signer = makeProviderSigner(provider);

        const first = await signer.getAccounts();
        const second = await signer.getAccounts();

        expect(first).toBe(second);
        expect(provider.request).toHaveBeenCalledTimes(1);
      });
    });

    describe('signTypedData', () => {
      it('calls eth_signTypedData_v4 with EIP712Domain in types', async () => {
        const provider = makeTestProvider();
        const expectedSig = '0xdeadbeef' as Hex;
        provider.request.mockResolvedValueOnce(expectedSig);

        const signer = makeProviderSigner(provider);
        const typedData = {
          domain: { name: 'Test' },
          types: { Test: [{ name: 'value', type: 'uint256' }] },
          primaryType: 'Test',
          message: { value: '1' },
        };

        const signature = await signer.signTypedData(typedData, ALICE_LOWER);

        expect(signature).toBe(expectedSig);
        const callArgs = provider.request.mock.calls[0]?.[0] as unknown as {
          params: [string, string];
        };
        const sentJson = JSON.parse(callArgs.params[1]);
        // EIP712Domain should be injected with domain fields
        expect(sentJson.types.EIP712Domain).toStrictEqual([
          { name: 'name', type: 'string' },
        ]);
        expect(sentJson.types.Test).toStrictEqual(typedData.types.Test);
      });

      it('converts BigInt values to hex strings', async () => {
        const provider = makeTestProvider();
        const expectedSig = '0xdeadbeef' as Hex;
        provider.request.mockResolvedValueOnce(expectedSig);

        const signer = makeProviderSigner(provider);
        const salt = BigInt('0xff'.padEnd(66, 'ff'));
        const typedData = {
          domain: { name: 'Test', chainId: 11155111 },
          types: { Test: [{ name: 'salt', type: 'uint256' }] },
          primaryType: 'Test',
          message: { salt },
        };

        await signer.signTypedData(typedData, ALICE_LOWER);

        expect(provider.request).toHaveBeenCalledWith({
          method: 'eth_signTypedData_v4',
          params: [
            ALICE_LOWER,
            expect.stringContaining(`"salt":"0x${salt.toString(16)}"`),
          ],
        });
      });
    });

    describe('signMessage', () => {
      it('calls personal_sign', async () => {
        const provider = makeTestProvider();
        const expectedSig = '0xdeadbeef' as Hex;
        provider.request.mockResolvedValueOnce(expectedSig);

        const signer = makeProviderSigner(provider);
        const signature = await signer.signMessage('hello', ALICE_LOWER);

        expect(signature).toBe(expectedSig);
        expect(provider.request).toHaveBeenCalledWith({
          method: 'personal_sign',
          params: ['hello', ALICE_LOWER],
        });
      });
    });

    describe('signTransaction', () => {
      it('calls eth_signTransaction', async () => {
        const provider = makeTestProvider();
        const expectedSig = '0xdeadbeef' as Hex;
        provider.request.mockResolvedValueOnce(expectedSig);

        const signer = makeProviderSigner(provider);
        const tx = {
          from: ALICE_LOWER,
          to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address,
        };

        const signature = await signer.signTransaction(tx);

        expect(signature).toBe(expectedSig);
        expect(provider.request).toHaveBeenCalledWith({
          method: 'eth_signTransaction',
          params: [tx],
        });
      });
    });

    describe('disconnect', () => {
      it('clears cached accounts', async () => {
        const provider = makeTestProvider();
        provider.request.mockResolvedValue([ALICE]);

        const signer = makeProviderSigner(provider);

        await signer.getAccounts();
        signer.disconnect();

        // After disconnect, should re-request accounts
        await signer.getAccounts();
        expect(provider.request).toHaveBeenCalledTimes(2);
      });

      it('calls the disconnect callback', () => {
        const provider = makeTestProvider();
        const disconnectFn = vi.fn();

        const signer = makeProviderSigner(provider, {
          disconnect: disconnectFn,
        });

        signer.disconnect();

        expect(disconnectFn).toHaveBeenCalledTimes(1);
      });
    });

    describe('provider', () => {
      it('exposes the underlying provider', () => {
        const provider = makeTestProvider();
        const signer = makeProviderSigner(provider);

        expect(signer.provider).toBe(provider);
      });
    });
  });

  describe('connectMetaMaskSigner', () => {
    it('connects to MetaMask SDK and returns a signer', async () => {
      const mockProvider = {
        request: vi.fn().mockResolvedValue([ALICE]),
      };
      mockGetProvider.mockReturnValue(mockProvider);

      const signer = await connectMetaMaskSigner({
        dappMetadata: { name: 'Test App', url: 'https://test.app' },
      });

      expect(mockConnect).toHaveBeenCalled();
      expect(mockGetProvider).toHaveBeenCalled();

      const accounts = await signer.getAccounts();
      expect(accounts).toStrictEqual([ALICE_LOWER]);
    });

    it('calls sdk.terminate on disconnect', async () => {
      const mockProvider = {
        request: vi.fn().mockResolvedValue([ALICE]),
      };
      mockGetProvider.mockReturnValue(mockProvider);

      const signer = await connectMetaMaskSigner();
      signer.disconnect();

      expect(mockTerminate).toHaveBeenCalled();
    });

    it('throws when provider is not found', async () => {
      mockGetProvider.mockReturnValue(null);

      await expect(connectMetaMaskSigner()).rejects.toThrow(
        'MetaMask SDK provider not found',
      );
    });
  });
});
