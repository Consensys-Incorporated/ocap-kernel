import { describe, it, expect, beforeEach, vi } from 'vitest';

import { buildRootObject } from './provider-vat.ts';
import { makeMockBaggage } from '../../test/helpers.ts';
import { ENTRY_POINT_V07 } from '../lib/userop.ts';
import type { Address, Hex, UserOperation } from '../types.ts';

const mockProvider = {
  request: vi.fn(),
  broadcastTransaction: vi.fn(),
  getBalance: vi.fn(),
  getChainId: vi.fn(),
  getNonce: vi.fn(),
};

const mockHttpGetJson = vi.fn();

vi.mock('../lib/provider.ts', () => ({
  makeProvider: vi.fn(() => mockProvider),
  httpGetJson: (...args: unknown[]) => mockHttpGetJson(...args),
}));

const mockBundlerClient = {
  sendUserOperation: vi.fn(),
  estimateUserOperationGas: vi.fn(),
  sponsorUserOperation: vi.fn(),
  getUserOperationReceipt: vi.fn(),
  waitForUserOperationReceipt: vi.fn(),
};

vi.mock('../lib/bundler-client.ts', () => ({
  makeBundlerClient: vi.fn(() => mockBundlerClient),
}));

describe('provider-vat', () => {
  let baggage: ReturnType<typeof makeMockBaggage>;
  let root: ReturnType<typeof buildRootObject>;

  beforeEach(() => {
    vi.clearAllMocks();
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

  describe('configure', () => {
    it('configures the provider with chain config', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      expect(baggage.has('chainConfig')).toBe(true);
    });
  });

  describe('configureBundler', () => {
    it('stores bundler config in baggage', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configureBundler({
        bundlerUrl: 'https://bundler.example.com',
        chainId: 1,
      });

      expect(baggage.has('bundlerConfig')).toBe(true);
    });
  });

  describe('request', () => {
    it('throws when provider is not configured', async () => {
      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).request('eth_chainId'),
      ).rejects.toThrow('Provider not configured');
    });

    it('forwards JSON-RPC calls after configuration', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      mockProvider.request.mockResolvedValue('0x1');
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (root as any).request('eth_chainId');
      expect(result).toBe('0x1');
    });
  });

  describe('broadcastTransaction', () => {
    it('sends a raw transaction', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      const txHash = '0xabc123' as Hex;
      mockProvider.broadcastTransaction.mockResolvedValue(txHash);

      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (root as any).broadcastTransaction('0xf86c...');
      expect(result).toBe(txHash);
    });
  });

  describe('getBalance', () => {
    it('returns balance', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      mockProvider.getBalance.mockResolvedValue('0xde0b6b3a7640000');
      const balance = await (
        root as { getBalance: (a: Address) => Promise<string> }
      ).getBalance('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
      expect(balance).toBe('0xde0b6b3a7640000');
    });
  });

  describe('getChainId', () => {
    it('returns chain ID', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      mockProvider.getChainId.mockResolvedValue(1);
      // oxlint-disable-next-line typescript/no-explicit-any
      const chainId = await (root as any).getChainId();
      expect(chainId).toBe(1);
    });
  });

  describe('getNonce', () => {
    it('returns nonce', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      mockProvider.getNonce.mockResolvedValue(42);
      // oxlint-disable-next-line typescript/no-explicit-any
      const nonce = await (root as any).getNonce(
        '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      );
      expect(nonce).toBe(42);
    });
  });

  describe('submitUserOp', () => {
    const mockUserOp: UserOperation = {
      sender: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address,
      nonce: '0x0' as Hex,
      callData: '0xdeadbeef' as Hex,
      callGasLimit: '0x50000' as Hex,
      verificationGasLimit: '0x60000' as Hex,
      preVerificationGas: '0x10000' as Hex,
      maxFeePerGas: '0x3b9aca00' as Hex,
      maxPriorityFeePerGas: '0x3b9aca00' as Hex,
      signature: '0xsig' as Hex,
    };

    it('submits a UserOp via bundler client', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configureBundler({
        bundlerUrl: 'https://bundler.example.com',
        chainId: 1,
      });
      mockBundlerClient.sendUserOperation.mockResolvedValue('0xuserophash');

      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (root as any).submitUserOp({
        bundlerUrl: 'https://bundler.example.com',
        entryPoint: ENTRY_POINT_V07,
        userOp: mockUserOp,
      });

      expect(result).toBe('0xuserophash');
      expect(mockBundlerClient.sendUserOperation).toHaveBeenCalledWith({
        userOp: mockUserOp,
        entryPointAddress: ENTRY_POINT_V07,
      });
    });

    it('propagates bundler client errors', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configureBundler({
        bundlerUrl: 'https://bundler.example.com',
        chainId: 1,
      });
      mockBundlerClient.sendUserOperation.mockRejectedValue(
        new Error('bundler error'),
      );

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).submitUserOp({
          bundlerUrl: 'https://bundler.example.com',
          entryPoint: ENTRY_POINT_V07,
          userOp: mockUserOp,
        }),
      ).rejects.toThrow('bundler error');
    });
  });

  describe('getEntryPointNonce', () => {
    it('throws when provider is not configured', async () => {
      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).getEntryPointNonce({
          entryPoint: ENTRY_POINT_V07,
          sender: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address,
        }),
      ).rejects.toThrow('Provider not configured');
    });

    it('calls eth_call with encoded getNonce calldata', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      mockProvider.request.mockResolvedValue(
        '0x0000000000000000000000000000000000000000000000000000000000000005',
      );
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (root as any).getEntryPointNonce({
        entryPoint: ENTRY_POINT_V07,
        sender: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address,
      });

      expect(result).toBe(
        '0x0000000000000000000000000000000000000000000000000000000000000005',
      );
      expect(mockProvider.request).toHaveBeenCalledWith('eth_call', [
        {
          to: ENTRY_POINT_V07,
          data: expect.stringMatching(/^0x35567e1a/u),
        },
        'latest',
      ]);
    });

    it('encodes custom key parameter', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      mockProvider.request.mockResolvedValue('0x0' as Hex);
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).getEntryPointNonce({
        entryPoint: ENTRY_POINT_V07,
        sender: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address,
        key: '0x1' as Hex,
      });

      expect(mockProvider.request).toHaveBeenCalledWith('eth_call', [
        expect.objectContaining({
          to: ENTRY_POINT_V07,
        }),
        'latest',
      ]);
    });
  });

  describe('getUserOpReceipt', () => {
    it('queries bundler client for UserOp receipt', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configureBundler({
        bundlerUrl: 'https://bundler.example.com',
        chainId: 1,
      });
      const receipt = { success: true, receipt: { transactionHash: '0xabc' } };
      mockBundlerClient.getUserOperationReceipt.mockResolvedValue(receipt);

      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (root as any).getUserOpReceipt({
        bundlerUrl: 'https://bundler.example.com',
        userOpHash: '0xdeadbeef' as Hex,
      });

      expect(result).toStrictEqual(receipt);
      expect(mockBundlerClient.getUserOperationReceipt).toHaveBeenCalledWith(
        '0xdeadbeef',
      );
    });

    it('returns null when receipt is not found', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configureBundler({
        bundlerUrl: 'https://bundler.example.com',
        chainId: 1,
      });
      mockBundlerClient.getUserOperationReceipt.mockResolvedValue(null);

      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (root as any).getUserOpReceipt({
        bundlerUrl: 'https://bundler.example.com',
        userOpHash: '0xdeadbeef' as Hex,
      });

      expect(result).toBeNull();
    });
  });

  describe('estimateUserOpGas', () => {
    const mockUserOp: UserOperation = {
      sender: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address,
      nonce: '0x0' as Hex,
      callData: '0xdeadbeef' as Hex,
      callGasLimit: '0x50000' as Hex,
      verificationGasLimit: '0x60000' as Hex,
      preVerificationGas: '0x10000' as Hex,
      maxFeePerGas: '0x3b9aca00' as Hex,
      maxPriorityFeePerGas: '0x3b9aca00' as Hex,
      signature: '0x' as Hex,
    };

    it('estimates gas via bundler client', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configureBundler({
        bundlerUrl: 'https://bundler.example.com',
        chainId: 1,
      });
      mockBundlerClient.estimateUserOperationGas.mockResolvedValue({
        callGasLimit: 0x50000n,
        verificationGasLimit: 0x60000n,
        preVerificationGas: 0x10000n,
      });

      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (root as any).estimateUserOpGas({
        bundlerUrl: 'https://bundler.example.com',
        entryPoint: ENTRY_POINT_V07,
        userOp: mockUserOp,
      });

      expect(result).toStrictEqual({
        callGasLimit: '0x50000',
        verificationGasLimit: '0x60000',
        preVerificationGas: '0x10000',
      });
      expect(mockBundlerClient.estimateUserOperationGas).toHaveBeenCalledWith({
        userOp: mockUserOp,
        entryPointAddress: ENTRY_POINT_V07,
      });
    });

    it('propagates bundler client errors', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configureBundler({
        bundlerUrl: 'https://bundler.example.com',
        chainId: 1,
      });
      mockBundlerClient.estimateUserOperationGas.mockRejectedValue(
        new Error('estimation failed'),
      );

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).estimateUserOpGas({
          bundlerUrl: 'https://bundler.example.com',
          entryPoint: ENTRY_POINT_V07,
          userOp: mockUserOp,
        }),
      ).rejects.toThrow('estimation failed');
    });
  });

  describe('sponsorUserOp', () => {
    const mockUserOp: UserOperation = {
      sender: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address,
      nonce: '0x0' as Hex,
      callData: '0xdeadbeef' as Hex,
      callGasLimit: '0x50000' as Hex,
      verificationGasLimit: '0x60000' as Hex,
      preVerificationGas: '0x10000' as Hex,
      maxFeePerGas: '0x3b9aca00' as Hex,
      maxPriorityFeePerGas: '0x3b9aca00' as Hex,
      signature: '0x' as Hex,
    };

    it('sponsors a UserOp via bundler client', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configureBundler({
        bundlerUrl: 'https://bundler.example.com',
        chainId: 1,
      });
      const sponsorResult = {
        paymaster: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address,
        paymasterData: '0xdeadbeef' as Hex,
        paymasterVerificationGasLimit: '0x60000' as Hex,
        paymasterPostOpGasLimit: '0x10000' as Hex,
        callGasLimit: '0x50000' as Hex,
        verificationGasLimit: '0x60000' as Hex,
        preVerificationGas: '0x10000' as Hex,
      };
      mockBundlerClient.sponsorUserOperation.mockResolvedValue(sponsorResult);

      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (root as any).sponsorUserOp({
        bundlerUrl: 'https://bundler.example.com',
        entryPoint: ENTRY_POINT_V07,
        userOp: mockUserOp,
      });

      expect(result).toStrictEqual(sponsorResult);
      expect(mockBundlerClient.sponsorUserOperation).toHaveBeenCalledWith({
        userOp: mockUserOp,
        entryPointAddress: ENTRY_POINT_V07,
        context: undefined,
      });
    });
  });

  describe('getGasFees', () => {
    it('throws when provider is not configured', async () => {
      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).getGasFees(),
      ).rejects.toThrow('Provider not configured');
    });

    it('returns computed gas fees from block and priority fee', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      // baseFeePerGas = 0x3b9aca00 (1 gwei), priorityFee = 0x3b9aca00 (1 gwei)
      mockProvider.request
        .mockResolvedValueOnce({ baseFeePerGas: '0x3b9aca00' }) // eth_getBlockByNumber
        .mockResolvedValueOnce('0x3b9aca00'); // eth_maxPriorityFeePerGas

      // oxlint-disable-next-line typescript/no-explicit-any
      const fees = await (root as any).getGasFees();

      // maxFeePerGas = 2 * 1gwei + 1gwei = 3gwei = 0xb2d05e00
      expect(fees).toStrictEqual({
        maxFeePerGas: '0xb2d05e00',
        maxPriorityFeePerGas: '0x3b9aca00',
      });
    });

    it('falls back to 1 gwei priority fee when eth_maxPriorityFeePerGas fails', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      mockProvider.request
        .mockResolvedValueOnce({ baseFeePerGas: '0x3b9aca00' }) // eth_getBlockByNumber
        .mockRejectedValueOnce(new Error('Method not found (-32601)')); // eth_maxPriorityFeePerGas

      // oxlint-disable-next-line typescript/no-explicit-any
      const fees = await (root as any).getGasFees();

      // Should fall back to 1 gwei for priority fee
      expect(fees.maxPriorityFeePerGas).toBe('0x3b9aca00');
    });

    it('throws when block response is missing baseFeePerGas', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      mockProvider.request
        .mockResolvedValueOnce({ number: '0x1' }) // no baseFeePerGas
        .mockResolvedValueOnce('0x3b9aca00');

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).getGasFees(),
      ).rejects.toThrow(
        'Invalid block response: missing or malformed baseFeePerGas',
      );
    });

    it('throws when block response is null', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      await (root as any).configure({
        chainId: 1,
        rpcUrl: 'https://eth.example.com',
      });

      mockProvider.request
        .mockResolvedValueOnce(null) // null block
        .mockResolvedValueOnce('0x3b9aca00');

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).getGasFees(),
      ).rejects.toThrow(
        'Invalid block response: missing or malformed baseFeePerGas',
      );
    });
  });

  describe('httpGetJson', () => {
    it('delegates to the httpGetJson lib function', async () => {
      const mockResponse = { foo: 'bar' };
      mockHttpGetJson.mockResolvedValueOnce(mockResponse);

      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (root as any).httpGetJson(
        'https://api.example.com/data',
      );

      expect(result).toStrictEqual(mockResponse);
      expect(mockHttpGetJson).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.any(Function),
      );
    });

    it('propagates errors from the lib function', async () => {
      mockHttpGetJson.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        // oxlint-disable-next-line typescript/no-explicit-any
        (root as any).httpGetJson('https://api.example.com/data'),
      ).rejects.toThrow('Network error');
    });

    it('passes a fetch that rejects when the vat has no http', async () => {
      mockHttpGetJson.mockResolvedValueOnce({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (root as any).httpGetJson('https://api.example.com/data');
      const vatFetch = mockHttpGetJson.mock
        .lastCall?.[1] as () => Promise<unknown>;

      await expect(vatFetch()).rejects.toThrow(
        'The provider vat was granted no http capability',
      );
    });
  });
});
