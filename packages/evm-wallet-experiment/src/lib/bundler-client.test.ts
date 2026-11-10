import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeBundlerClient } from './bundler-client.ts';
import type { Hex } from '../types.ts';

const mockFetch = vi.fn();

/**
 * Create a mock fetch response for bundler RPC.
 *
 * @param result - The JSON-RPC result to return.
 * @returns A mock Response-like object.
 */
function mockRpcResponse(result: unknown): {
  ok: boolean;
  json: () => Promise<{ jsonrpc: string; id: number; result: unknown }>;
} {
  return {
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  };
}

describe('lib/bundler-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('makeBundlerClient', () => {
    it('creates a client', () => {
      const client = makeBundlerClient(
        {
          bundlerUrl: 'https://bundler.example.com',
          chainId: 1,
        },
        mockFetch,
      );

      expect(client).toBeDefined();
      expect(client.sendUserOperation).toBeDefined();
      expect(client.estimateUserOperationGas).toBeDefined();
      expect(client.getUserOperationReceipt).toBeDefined();
      expect(client.waitForUserOperationReceipt).toBeDefined();
    });
  });

  describe('sendUserOperation', () => {
    it('sends a user operation via RPC', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse('0xuserophash'));

      const client = makeBundlerClient(
        {
          bundlerUrl: 'https://bundler.example.com',
          chainId: 1,
        },
        mockFetch,
      );

      const result = await client.sendUserOperation({
        userOp: {} as never,
        entryPointAddress: '0x0000000071727de22e5e9d8baf0edac6f37da032' as Hex,
      });

      expect(result).toBe('0xuserophash');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://bundler.example.com',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('estimateUserOperationGas', () => {
    it('returns gas estimates as bigints', async () => {
      mockFetch.mockResolvedValue(
        mockRpcResponse({
          callGasLimit: '0x50000',
          verificationGasLimit: '0x60000',
          preVerificationGas: '0x10000',
        }),
      );

      const client = makeBundlerClient(
        {
          bundlerUrl: 'https://bundler.example.com',
          chainId: 1,
        },
        mockFetch,
      );

      const estimate = await client.estimateUserOperationGas({
        userOp: {} as never,
        entryPointAddress: '0x0000000071727de22e5e9d8baf0edac6f37da032' as Hex,
      });

      expect(estimate.callGasLimit).toBe(0x50000n);
      expect(estimate.verificationGasLimit).toBe(0x60000n);
      expect(estimate.preVerificationGas).toBe(0x10000n);
    });
  });

  describe('getUserOperationReceipt', () => {
    it('returns receipt when found', async () => {
      const receipt = {
        success: true,
        receipt: { transactionHash: '0xabc' },
      };
      mockFetch.mockResolvedValue(mockRpcResponse(receipt));

      const client = makeBundlerClient(
        {
          bundlerUrl: 'https://bundler.example.com',
          chainId: 1,
        },
        mockFetch,
      );

      const result = await client.getUserOperationReceipt('0xdeadbeef' as Hex);
      expect(result).toStrictEqual(receipt);
    });

    it('returns null when receipt is not found', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse(null));

      const client = makeBundlerClient(
        {
          bundlerUrl: 'https://bundler.example.com',
          chainId: 1,
        },
        mockFetch,
      );

      const result = await client.getUserOperationReceipt('0xdeadbeef' as Hex);
      expect(result).toBeNull();
    });
  });

  describe('waitForUserOperationReceipt', () => {
    it('returns receipt when found immediately', async () => {
      const receipt = { success: true };
      mockFetch.mockResolvedValue(mockRpcResponse(receipt));

      const client = makeBundlerClient(
        {
          bundlerUrl: 'https://bundler.example.com',
          chainId: 1,
        },
        mockFetch,
      );

      const result = await client.waitForUserOperationReceipt({
        hash: '0xdeadbeef' as Hex,
      });
      expect(result).toStrictEqual(receipt);
    });

    it('polls and returns receipt after retries', async () => {
      const receipt = { success: true };
      mockFetch
        .mockResolvedValueOnce(mockRpcResponse(null))
        .mockResolvedValueOnce(mockRpcResponse(receipt));

      const client = makeBundlerClient(
        {
          bundlerUrl: 'https://bundler.example.com',
          chainId: 1,
        },
        mockFetch,
      );

      const result = await client.waitForUserOperationReceipt({
        hash: '0xdeadbeef' as Hex,
        pollingInterval: 1,
        timeout: 5000,
      });

      expect(result).toStrictEqual(receipt);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on timeout', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse(null));

      const client = makeBundlerClient(
        {
          bundlerUrl: 'https://bundler.example.com',
          chainId: 1,
        },
        mockFetch,
      );

      await expect(
        client.waitForUserOperationReceipt({
          hash: '0xdeadbeef' as Hex,
          pollingInterval: 1,
          timeout: 10,
        }),
      ).rejects.toThrow('not included after 10ms');
    });
  });
});
