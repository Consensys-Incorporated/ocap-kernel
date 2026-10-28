import { describe, it, expect, vi, beforeEach } from 'vitest';

import { httpGetJson, makeProvider } from './provider.ts';
import type { Provider } from './provider.ts';

const mockFetch = vi.fn();

/**
 * Create a mock fetch response.
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

describe('lib/provider', () => {
  let provider: Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = makeProvider(
      { chainId: 1, rpcUrl: 'https://rpc.example.com' },
      mockFetch,
    );
  });

  describe('makeProvider', () => {
    it('creates a provider for a known chain', () => {
      const knownProvider = makeProvider(
        {
          chainId: 1,
          rpcUrl: 'https://eth.example.com',
        },
        mockFetch,
      );
      expect(knownProvider).toBeDefined();
      expect(knownProvider.request).toBeDefined();
      expect(knownProvider.broadcastTransaction).toBeDefined();
      expect(knownProvider.getBalance).toBeDefined();
      expect(knownProvider.getChainId).toBeDefined();
      expect(knownProvider.getNonce).toBeDefined();
    });

    it('creates a provider for a custom chain', () => {
      const customProvider = makeProvider(
        {
          chainId: 99999,
          rpcUrl: 'https://custom-rpc.example.com',
          name: 'Custom Chain',
        },
        mockFetch,
      );
      expect(customProvider).toBeDefined();
    });
  });

  describe('request', () => {
    it('forwards JSON-RPC calls via fetch', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse('0x1'));

      const result = await provider.request('eth_chainId', []);
      expect(result).toBe('0x1');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://rpc.example.com',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
  });

  describe('broadcastTransaction', () => {
    it('sends a raw transaction', async () => {
      const txHash = '0xabc123';
      mockFetch.mockResolvedValue(mockRpcResponse(txHash));

      const result = await provider.broadcastTransaction('0xf86c...');
      expect(result).toBe(txHash);
    });
  });

  describe('getBalance', () => {
    it('returns the balance as a hex string', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse('0xde0b6b3a7640000'));

      const balance = await provider.getBalance(
        '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      );
      expect(balance).toBe('0xde0b6b3a7640000');
    });
  });

  describe('getChainId', () => {
    it('returns the chain ID', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse('0x1'));

      const chainId = await provider.getChainId();
      expect(chainId).toBe(1);
    });
  });

  describe('getNonce', () => {
    it('returns the transaction count', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse('0x2a'));

      const nonce = await provider.getNonce(
        '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      );
      expect(nonce).toBe(42);
    });
  });

  describe('httpGetJson', () => {
    it('gets the URL through the given fetch and parses the body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ a: 1 }),
      });

      expect(
        await httpGetJson('https://api.example.com/x', mockFetch),
      ).toStrictEqual({ a: 1 });
      expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/x');
    });

    it('rejects a non-retryable error status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(
        httpGetJson('https://api.example.com/x', mockFetch),
      ).rejects.toThrow('HTTP GET failed: 404 Not Found');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
