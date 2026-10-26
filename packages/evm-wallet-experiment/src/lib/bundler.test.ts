import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  submitUserOp,
  estimateUserOpGas,
  getUserOpReceipt,
  waitForUserOp,
} from './bundler.ts';
import type { BundlerConfig, UserOpReceipt } from './bundler.ts';
import type { Hex, UserOperation } from '../types.ts';

const makeTestConfig = (): BundlerConfig => ({
  url: 'https://bundler.example.com/rpc',
  entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032' as Hex,
});

const makeTestUserOp = (): UserOperation => ({
  sender: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Hex,
  nonce: '0x0' as Hex,
  callData: '0xdeadbeef' as Hex,
  callGasLimit: '0x50000' as Hex,
  verificationGasLimit: '0x60000' as Hex,
  preVerificationGas: '0x10000' as Hex,
  maxFeePerGas: '0x3b9aca00' as Hex,
  maxPriorityFeePerGas: '0x3b9aca00' as Hex,
  signature: '0xab' as Hex,
});

const makeTestReceipt = (): UserOpReceipt => ({
  userOpHash: '0xabc123' as Hex,
  sender: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Hex,
  nonce: '0x0' as Hex,
  success: true,
  actualGasCost: '0x1234' as Hex,
  actualGasUsed: '0x5678' as Hex,
  receipt: {
    transactionHash: '0xdef456' as Hex,
    blockNumber: '0x1' as Hex,
  },
});

describe('lib/bundler', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    // The mocks resolve to partial `Response`s that carry only what the code reads.
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy as typeof fetch);
  });

  const mockFetchResponse = (result: unknown) => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
    });
  };

  const mockFetchError = (message: string) => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        Promise.resolve({
          jsonrpc: '2.0',
          id: 1,
          error: { message, code: -32000 },
        }),
    });
  };

  describe('submitUserOp', () => {
    it('sends eth_sendUserOperation and returns hash', async () => {
      const config = makeTestConfig();
      const userOp = makeTestUserOp();
      const expectedHash = '0xabc123' as Hex;

      mockFetchResponse(expectedHash);

      const result = await submitUserOp(config, userOp);

      expect(result).toBe(expectedHash);
      expect(fetchSpy).toHaveBeenCalledWith(
        config.url,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('eth_sendUserOperation'),
        }),
      );
    });

    it('throws on bundler error', async () => {
      const config = makeTestConfig();
      const userOp = makeTestUserOp();

      mockFetchError('invalid userop');

      await expect(submitUserOp(config, userOp)).rejects.toThrow(
        'Bundler RPC error: invalid userop',
      );
    });
  });

  describe('estimateUserOpGas', () => {
    it('sends eth_estimateUserOperationGas and returns estimates', async () => {
      const config = makeTestConfig();
      const userOp = makeTestUserOp();
      const estimates = {
        callGasLimit: '0x50000' as Hex,
        verificationGasLimit: '0x60000' as Hex,
        preVerificationGas: '0x10000' as Hex,
      };

      mockFetchResponse(estimates);

      const result = await estimateUserOpGas(config, userOp);

      expect(result).toStrictEqual(estimates);
    });
  });

  describe('getUserOpReceipt', () => {
    it('returns receipt when available', async () => {
      const config = makeTestConfig();
      const receipt = makeTestReceipt();

      mockFetchResponse(receipt);

      const result = await getUserOpReceipt(config, '0xabc123' as Hex);

      expect(result).toStrictEqual(receipt);
    });

    it('returns null when not yet included', async () => {
      const config = makeTestConfig();

      mockFetchResponse(null);

      const result = await getUserOpReceipt(config, '0xabc123' as Hex);

      expect(result).toBeNull();
    });
  });

  describe('waitForUserOp', () => {
    it('returns receipt on first poll', async () => {
      const config = makeTestConfig();
      const receipt = makeTestReceipt();

      mockFetchResponse(receipt);

      const result = await waitForUserOp(config, '0xabc123' as Hex, {
        pollIntervalMs: 10,
        timeoutMs: 100,
      });

      expect(result).toStrictEqual(receipt);
    });

    it('polls until receipt is available', async () => {
      const config = makeTestConfig();
      const receipt = makeTestReceipt();

      // First two polls return null, third returns receipt
      mockFetchResponse(null);
      mockFetchResponse(null);
      mockFetchResponse(receipt);

      const result = await waitForUserOp(config, '0xabc123' as Hex, {
        pollIntervalMs: 10,
        timeoutMs: 500,
      });

      expect(result).toStrictEqual(receipt);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('throws after timeout', async () => {
      const config = makeTestConfig();

      // Always return null
      fetchSpy.mockImplementation(() => ({
        ok: true,
        json: () => ({ jsonrpc: '2.0', id: 1, result: null }),
      }));

      await expect(
        waitForUserOp(config, '0xabc123' as Hex, {
          pollIntervalMs: 10,
          timeoutMs: 50,
        }),
      ).rejects.toThrow('not included after 50ms');
    });
  });
});
