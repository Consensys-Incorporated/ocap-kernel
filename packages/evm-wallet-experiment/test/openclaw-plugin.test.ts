import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { register } from '../openclaw-plugin/index.ts';
import type { OpenClawPluginApi } from '../openclaw-plugin/types.ts';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

type ToolDefinition = Parameters<OpenClawPluginApi['registerTool']>[0];

type MockReadable = EventEmitter & {
  setEncoding: (encoding: string) => void;
};

/**
 * Encode a value as the JSON output of `ocap daemon queueMessage`.
 *
 * The CLI auto-decodes CapData via prettifySmallcaps, so the output
 * is plain JSON (not CapData-wrapped).
 *
 * @param value - The decoded value the CLI would output.
 * @returns JSON string.
 */
function makeCliOutput(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Create a readable-like event emitter used by child process stdio.
 *
 * @returns The mock readable.
 */
function makeReadable(): MockReadable {
  const stream = new EventEmitter() as MockReadable;
  stream.setEncoding = () => undefined;
  return stream;
}

/**
 * Create a mocked child process for spawn().
 *
 * @param options - Mock output options.
 * @param options.stdout - Text written to stdout.
 * @param options.stderr - Text written to stderr.
 * @param options.code - Exit code emitted with `exit`.
 * @returns A child process mock.
 */
function makeSpawnResult(options: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): ReturnType<typeof spawn> {
  const child = new EventEmitter() as EventEmitter & {
    stdout: MockReadable;
    stderr: MockReadable;
    kill: (signal?: string) => boolean;
  };

  child.stdout = makeReadable();
  child.stderr = makeReadable();
  child.kill = () => true;
  vi.spyOn(child, 'kill').mockImplementation(() => true);

  queueMicrotask(() => {
    if (options.stdout) {
      child.stdout.emit('data', options.stdout);
    }
    if (options.stderr) {
      child.stderr.emit('data', options.stderr);
    }
    child.emit('exit', options.code ?? 0);
  });

  return child as unknown as ReturnType<typeof spawn>;
}

/**
 * Register the wallet plugin and return registered tools by name.
 *
 * @returns A map of tools.
 */
function setupPlugin(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const api: OpenClawPluginApi = {
    pluginConfig: {
      ocapCliPath: 'ocap',
      walletKref: 'ko4',
      timeoutMs: 5000,
    },
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
  };

  register(api);
  return tools;
}

describe('openclaw wallet plugin', () => {
  const mockSpawn = vi.mocked(spawn);
  const account = '0x1111111111111111111111111111111111111111';
  const recipient = '0x2222222222222222222222222222222222222222';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('registers the wallet_token_resolve tool', () => {
    const tools = setupPlugin();
    expect(tools.has('wallet_token_resolve')).toBe(true);
  });

  it('decodes CLI JSON response for wallet_balance', async () => {
    mockSpawn.mockImplementationOnce(() =>
      makeSpawnResult({ stdout: makeCliOutput('0xde0b6b3a7640000') }),
    );
    const tools = setupPlugin();
    const tool = tools.get('wallet_balance');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-1', { address: account });

    expect(result.content[0]?.text).toBe(
      `${account}: 1.000000 ETH (0xde0b6b3a7640000)`,
    );
  });

  it('strips internal fields from wallet_capabilities', async () => {
    const rawCapabilities = {
      hasLocalKeys: true,
      localAccounts: [account],
      delegationCount: 1,
      hasPeerWallet: true,
      hasExternalSigner: false,
      hasBundlerConfig: true,
      smartAccountAddress: account,
    };
    mockSpawn.mockImplementationOnce(() =>
      makeSpawnResult({ stdout: makeCliOutput(rawCapabilities) }),
    );

    const tools = setupPlugin();
    const tool = tools.get('wallet_capabilities');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-2', {});
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');

    expect(parsed).toStrictEqual({
      delegationCount: 1,
      hasPeerWallet: true,
      hasExternalSigner: false,
      hasBundlerConfig: true,
      smartAccountAddress: account,
    });
    expect(parsed).not.toHaveProperty('localAccounts');
    expect(parsed).not.toHaveProperty('hasLocalKeys');
  });

  it('infers from account before wallet_send', async () => {
    mockSpawn
      // 1. getAccounts
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput([account]) }),
      )
      // 2. sendTransaction
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput('0xtxhash') }),
      )
      // 3. getCapabilities (best-effort, for chain ID)
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ chainId: 11155111 }),
        }),
      )
      // 4. getTransactionReceipt (best-effort, resolve UserOp hash)
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({
            txHash: '0xrealtxhash',
            userOpHash: '0xtxhash',
            success: true,
          }),
        }),
      );

    const tools = setupPlugin();
    const tool = tools.get('wallet_send');
    expect(tool).toBeDefined();

    // Pass decimal ETH — plugin converts to hex wei
    const result = await tool!.execute('req-3', {
      to: recipient,
      value: '0.08',
    });

    expect(result.content[0]?.text).toContain('Transaction hash: 0xrealtxhash');
    expect(result.content[0]?.text).toContain(
      'https://sepolia.etherscan.io/tx/0xrealtxhash',
    );
    expect(result.content[0]?.text).toContain('UserOp hash: 0xtxhash');

    // New CLI format: ['daemon', 'queueMessage', kref, method, argsJson]
    const sendCallArgs = mockSpawn.mock.calls[1]?.[1] as string[];
    expect(sendCallArgs[1]).toBe('queueMessage');
    expect(sendCallArgs[2]).toBe('ko4');
    expect(sendCallArgs[3]).toBe('sendTransaction');
    const sendArgs = JSON.parse(sendCallArgs[4] ?? 'null') as unknown[];

    // 0.08 ETH = 80000000000000000 wei = 0x11c37937e080000
    expect(sendArgs).toStrictEqual([
      { from: account, to: recipient, value: '0x11c37937e080000' },
    ]);
  });

  it('returns error when wallet_send cannot infer a sender', async () => {
    mockSpawn.mockImplementationOnce(() =>
      makeSpawnResult({ stdout: makeCliOutput([]) }),
    );

    const tools = setupPlugin();
    const tool = tools.get('wallet_send');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-4', {
      to: recipient,
      value: '0x1',
    });

    expect(result.content[0]?.text).toBe(
      'Error: No wallet account available to use as sender.',
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed decimal ETH amounts before spawning', async () => {
    const tools = setupPlugin();
    const tool = tools.get('wallet_send');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-invalid-decimal', {
      to: recipient,
      value: '1.2.3',
    });

    expect(result.content[0]?.text).toContain('Error: Invalid value.');
    expect(result.content[0]?.text).toContain(
      'Amount must be a plain decimal string',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('surfaces prettified error from vat exception', async () => {
    // Simulate: getAccounts succeeds, sendTransaction returns a prettified error.
    // prettifySmallcaps converts #error CapData to strings like "[ErrorName: msg]".
    mockSpawn
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput([account]) }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput(
            '[Error: Bundler RPC error -32521: UserOperation reverted during simulation]',
          ),
        }),
      );

    const tools = setupPlugin();
    const tool = tools.get('wallet_send');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-err', {
      to: recipient,
      value: '0x1',
    });

    expect(result.content[0]?.text).toContain('Error:');
    expect(result.content[0]?.text).toContain(
      'Bundler RPC error -32521: UserOperation reverted during simulation',
    );
    // Should NOT call getTransactionReceipt/getCapabilities after an error
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('fetches ERC-20 token balance with formatting', async () => {
    const token = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    mockSpawn
      // 1. getAccounts (to resolve owner)
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput([account]) }),
      )
      // 2. getTokenBalance
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput('1000000') }),
      )
      // 3. getTokenMetadata
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
          }),
        }),
      );

    const tools = setupPlugin();
    const tool = tools.get('wallet_token_balance');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-tok-1', { token });
    expect(result.content[0]?.text).toBe(`${account}: 1 USDC (raw: 1000000)`);
  });

  it('sends ERC-20 tokens via wallet_token_send', async () => {
    const token = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    mockSpawn
      // 1. getTokenMetadata (for decimals)
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
          }),
        }),
      )
      // 2. sendErc20Transfer
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput('0xtokentxhash') }),
      )
      // 3. getCapabilities (best-effort)
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ chainId: 11155111 }),
        }),
      )
      // 4. getTransactionReceipt (best-effort)
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ txHash: '0xrealtokentx', success: true }),
        }),
      );

    const tools = setupPlugin();
    const tool = tools.get('wallet_token_send');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-tok-2', {
      token,
      to: recipient,
      amount: '100.5',
    });

    expect(result.content[0]?.text).toContain('Sent 100.5 USDC');
    expect(result.content[0]?.text).toContain(
      'Transaction hash: 0xrealtokentx',
    );
    expect(result.content[0]?.text).toContain(
      'https://sepolia.etherscan.io/tx/0xrealtokentx',
    );

    // Verify the sendErc20Transfer daemon call
    // New CLI format: ['daemon', 'queueMessage', kref, method, argsJson]
    const sendCallArgs = mockSpawn.mock.calls[1]?.[1] as string[];
    expect(sendCallArgs[3]).toBe('sendErc20Transfer');
  });

  it('waits for a delayed UserOp receipt before showing tx hash', async () => {
    mockSpawn
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput([account]) }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput('0xuserophash') }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ chainId: 11155111 }),
        }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput(null) }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({
            success: true,
            receipt: { transactionHash: '0xresolvedtx' },
          }),
        }),
      );

    const tools = setupPlugin();
    const tool = tools.get('wallet_send');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-userop-resolved', {
      to: recipient,
      value: '0.08',
    });

    expect(result.content[0]?.text).toContain('Transaction hash: 0xresolvedtx');
    expect(result.content[0]?.text).toContain('UserOp hash: 0xuserophash');
    expect(result.content[0]?.text).toContain(
      'https://sepolia.etherscan.io/tx/0xresolvedtx',
    );
  });

  it('reports pending UserOp without tx explorer URL', async () => {
    mockSpawn
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput([account]) }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput('0xpendinguserop') }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ chainId: 11155111 }),
        }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput(null) }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({ stderr: 'timed out', code: 1 }),
      );

    const tools = setupPlugin();
    const tool = tools.get('wallet_send');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-userop-pending', {
      to: recipient,
      value: '0.08',
    });

    expect(result.content[0]?.text).toContain('UserOp hash: 0xpendinguserop');
    expect(result.content[0]?.text).toContain(
      'Waiting for on-chain transaction hash.',
    );
    expect(result.content[0]?.text).not.toContain('Transaction hash:');
    expect(result.content[0]?.text).not.toContain('/tx/');
  });

  it('rejects token amounts with too many decimals', async () => {
    const token = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    mockSpawn.mockImplementationOnce(() =>
      makeSpawnResult({
        stdout: makeCliOutput({
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        }),
      }),
    );

    const tools = setupPlugin();
    const tool = tools.get('wallet_token_send');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-token-precision', {
      token,
      to: recipient,
      amount: '1.1234567',
    });

    expect(result.content[0]?.text).toContain('Error: Token send failed:');
    expect(result.content[0]?.text).toContain(
      'Amount has too many decimal places',
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('returns token metadata via wallet_token_info', async () => {
    const token = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    mockSpawn.mockImplementationOnce(() =>
      makeSpawnResult({
        stdout: makeCliOutput({
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        }),
      }),
    );

    const tools = setupPlugin();
    const tool = tools.get('wallet_token_info');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-tok-3', { token });
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed).toStrictEqual({
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
    });
  });

  it('resolves token symbol via MetaMask Token API for wallet_token_balance', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockSpawn
      // 1. getCapabilities (for chain ID during token resolution)
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ chainId: 1 }),
        }),
      )
      // 2. getAccounts (to resolve owner)
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput([account]) }),
      )
      // 3. getTokenBalance
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput('1000000') }),
      )
      // 4. getTokenMetadata
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
          }),
        }),
      );

    // MetaMask Token API search response (single request)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            assetId:
              'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            name: 'USDC',
            symbol: 'USDC',
            decimals: 6,
          },
        ],
      }),
    });

    const tools = setupPlugin();
    const tool = tools.get('wallet_token_balance');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-resolve-1', { token: 'USDC' });

    expect(result.content[0]?.text).toContain('USDC');
    expect(result.content[0]?.text).toContain('raw: 1000000');
    // Verify the resolved address was used for daemon calls
    // New CLI format: ['daemon', 'queueMessage', kref, method, argsJson]
    const balanceCallArgs = mockSpawn.mock.calls[2]?.[1] as string[];
    const balanceArgs = JSON.parse(balanceCallArgs[4] ?? 'null') as unknown[];
    expect((balanceArgs[0] as Record<string, unknown>).token).toBe(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    );
    // Single fetch call (MetaMask API returns everything in one request)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns error when token symbol has no matches', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    // getCapabilities for chain ID
    mockSpawn.mockImplementationOnce(() =>
      makeSpawnResult({
        stdout: makeCliOutput({ chainId: 11155111 }),
      }),
    );

    // MetaMask Token API returns empty results for testnet
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const tools = setupPlugin();
    const tool = tools.get('wallet_token_balance');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-resolve-2', { token: 'USDC' });

    expect(result.content[0]?.text).toContain('Error:');
    expect(result.content[0]?.text).toContain('No token found');
    expect(result.content[0]?.text).toContain('contract address directly');
  });

  it('rejects ambiguous exact symbol matches', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockSpawn.mockImplementationOnce(() =>
      makeSpawnResult({
        stdout: makeCliOutput({ chainId: 1 }),
      }),
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            assetId:
              'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
          },
          {
            assetId:
              'eip155:1/erc20:0x1111111111111111111111111111111111111111',
            name: 'Bridged USD Coin',
            symbol: 'USDC',
            decimals: 6,
          },
        ],
      }),
    });

    const tools = setupPlugin();
    const tool = tools.get('wallet_token_balance');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-ambiguous-exact', {
      token: 'USDC',
    });

    expect(result.content[0]?.text).toContain('Error:');
    expect(result.content[0]?.text).toContain('Multiple tokens match "USDC"');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('rejects ambiguous fuzzy token matches', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockSpawn.mockImplementationOnce(() =>
      makeSpawnResult({
        stdout: makeCliOutput({ chainId: 1 }),
      }),
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            assetId:
              'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
          },
          {
            assetId:
              'eip155:1/erc20:0x2222222222222222222222222222222222222222',
            name: 'First Digital USD',
            symbol: 'FDUSD',
            decimals: 18,
          },
        ],
      }),
    });

    const tools = setupPlugin();
    const tool = tools.get('wallet_token_balance');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-ambiguous-fuzzy', { token: 'USD' });

    expect(result.content[0]?.text).toContain('Error:');
    expect(result.content[0]?.text).toContain('Multiple tokens match "USD"');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not spawn process for invalid wallet_send params', async () => {
    const tools = setupPlugin();
    const tool = tools.get('wallet_send');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-5', {
      to: 'not-an-address',
      value: '1',
    });

    expect(result.content[0]?.text).toBe(
      'Error: Invalid recipient address. Must be 0x followed by 40 hex characters.',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('registers wallet_swap_quote and wallet_swap tools', () => {
    const tools = setupPlugin();
    expect(tools.has('wallet_swap_quote')).toBe(true);
    expect(tools.has('wallet_swap')).toBe(true);
  });

  it('rejects invalid slippage for wallet_swap_quote', async () => {
    const tools = setupPlugin();
    const tool = tools.get('wallet_swap_quote');
    expect(tool).toBeDefined();

    const result = await tool!.execute('req-swap-1', {
      srcToken: 'ETH',
      destToken: 'USDC',
      amount: '1.0',
      slippage: '60',
    } as Record<string, string>);

    expect(result.content[0]?.text).toContain('Error:');
    expect(result.content[0]?.text).toContain('Slippage');
  });

  it('formats wallet_swap_quote output', async () => {
    const destToken = '0xdac17f958d2ee523a2206206994597c13d831ec7';
    const quote = {
      trade: {
        to: '0x3333333333333333333333333333333333333333',
        from: '0xwallet',
        data: '0x',
        value: '0x0',
        gas: '0x30000',
      },
      approvalNeeded: null,
      sourceAmount: '1000000000000000000',
      destinationAmount: '2000000000',
      aggregator: 'testAgg',
      fee: 0,
      gasEstimate: '200000',
      priceSlippage: 0.5,
      quoteRefreshSeconds: 30,
    };

    // Call 1: getCapabilities (for chainId)
    // Call 2: getTokenMetadata for destToken (address passed directly, no symbol resolution)
    // Call 3: getSwapQuote
    mockSpawn
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ chainId: 1 }),
        }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({
            name: 'Tether',
            symbol: 'USDT',
            decimals: 6,
          }),
        }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput(quote) }),
      );

    const tools = setupPlugin();
    const tool = tools.get('wallet_swap_quote');

    const result = await tool!.execute('req-swap-2', {
      srcToken: 'ETH',
      destToken,
      amount: '1.0',
    } as Record<string, string>);

    expect(result.content[0]?.text).toContain('Swap 1.0 ETH');
    expect(result.content[0]?.text).toContain('2000');
    expect(result.content[0]?.text).toContain('USDT');
    expect(result.content[0]?.text).toContain('testAgg');
  });

  it('executes wallet_swap and formats result', async () => {
    const destToken = '0xdac17f958d2ee523a2206206994597c13d831ec7';
    const swapResult = {
      swapTxHash:
        '0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1',
      sourceAmount: '1000000000000000000',
      destinationAmount: '2000000000',
      aggregator: 'testAgg',
    };

    // Call 1: getCapabilities (for chainId in resolveSwapToken)
    // Call 2: getTokenMetadata for destToken (resolveSwapToken)
    // Call 3: swapTokens
    // Call 4: getCapabilities (for resolveTransactionResult)
    // Call 5: getTransactionReceipt
    mockSpawn
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ chainId: 1 }),
        }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ decimals: 6, symbol: 'USDT' }),
        }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({ stdout: makeCliOutput(swapResult) }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({ chainId: 1 }),
        }),
      )
      .mockImplementationOnce(() =>
        makeSpawnResult({
          stdout: makeCliOutput({
            txHash:
              '0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1',
          }),
        }),
      );

    const tools = setupPlugin();
    const tool = tools.get('wallet_swap');

    const result = await tool!.execute('req-swap-3', {
      srcToken: 'ETH',
      destToken,
      amount: '1.0',
    } as Record<string, string>);

    expect(result.content[0]?.text).toContain('Swapped 1.0 ETH for USDT');
    expect(result.content[0]?.text).toContain('testAgg');
  });
});
