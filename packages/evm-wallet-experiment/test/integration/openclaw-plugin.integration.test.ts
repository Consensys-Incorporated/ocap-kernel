import { array, assert, object, string } from '@metamask/superstruct';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { register } from '../../openclaw-plugin/index.ts';
import type { OpenClawPluginApi } from '../../openclaw-plugin/types.ts';
import { makeWalletClusterConfig } from '../../src/cluster-config.ts';

const CapDataStruct = object({ body: string(), slots: array(string()) });

type ToolDefinition = Parameters<OpenClawPluginApi['registerTool']>[0];

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '../../../..');
const ocapCliEntrypoint = resolve(repoRoot, 'node_modules/.bin/ocap');
const bundleBaseUrl = new URL('../../src/vats', import.meta.url).toString();
let ocapCliPath: string;
let ocapEnv: NodeJS.ProcessEnv;

/**
 * Execute the ocap CLI and return raw output.
 *
 * @param args - CLI arguments after `ocap`.
 * @param timeoutMs - Timeout in milliseconds.
 * @returns Stdout and stderr text.
 */
async function runOcap(
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(ocapCliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ocapEnv,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } finally {
        rejectPromise(new Error(`ocap command timed out: ${args.join(' ')}`));
      }
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(
          new Error(
            `ocap exited with code ${String(code)}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

/**
 * Execute the ocap CLI and parse JSON stdout.
 *
 * @param args - CLI arguments after `ocap`.
 * @param timeoutMs - Timeout in milliseconds.
 * @returns Parsed JSON output.
 */
async function runOcapJson(
  args: string[],
  timeoutMs = 30_000,
): Promise<unknown> {
  const { stdout } = await runOcap(args, timeoutMs);
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(
      `Failed to parse ocap JSON output: ${String(error)}\n${stdout.trim()}`,
    );
  }
}

/**
 * Decode Endo CapData JSON into plain JSON-compatible values.
 *
 * @param capData - Result from queueMessage RPC.
 * @returns Decoded value.
 */
function decodeCapData(capData: unknown): unknown {
  assert(capData, CapDataStruct);
  if (!capData.body.startsWith('#')) {
    throw new Error('Invalid CapData body');
  }
  return JSON.parse(capData.body.slice(1));
}

/**
 * Call wallet coordinator method via daemon queueMessage.
 *
 * @param rootKref - Wallet coordinator reference.
 * @param method - Wallet method name.
 * @param args - Method arguments.
 * @returns Decoded method result.
 */
async function callVat(
  rootKref: string,
  method: string,
  args: unknown[] = [],
): Promise<unknown> {
  // `daemon exec` outputs the unwrapped result (not the JSON-RPC envelope).
  // For queueMessage, the result is CapData.
  const result = await runOcapJson([
    'daemon',
    'exec',
    'queueMessage',
    JSON.stringify([rootKref, method, args]),
  ]);
  return decodeCapData(result);
}

const cliAvailable = await access(ocapCliEntrypoint)
  .then(() => true)
  .catch(() => false);

describe
  .skipIf(!cliAvailable)
  .sequential('OpenClaw wallet plugin daemon integration', () => {
    let tempHome: string;
    let rootKref: string;
    let rpcServer: ReturnType<typeof createServer>;
    let rpcUrl: string;
    let observedRawTx: string | undefined;
    let tools: Map<string, ToolDefinition>;

    beforeAll(async () => {
      tempHome = await mkdtemp(`${tmpdir()}/ocap-plugin-integration-`);
      ocapEnv = { HOME: tempHome };
      ocapCliPath = resolve(tempHome, 'ocap-cli-wrapper.sh');
      await writeFile(
        ocapCliPath,
        `#!/bin/bash
HOME="${tempHome}"
export HOME
exec "${process.execPath}" "${ocapCliEntrypoint}" "$@"
`,
        'utf8',
      );
      await chmod(ocapCliPath, 0o755);

      rpcServer = createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const parsed = JSON.parse(body) as {
            id: number;
            method: string;
            params?: unknown[];
          };
          let result: unknown;
          if (parsed.method === 'eth_getBalance') {
            result = '0x2a';
          } else if (parsed.method === 'eth_sendRawTransaction') {
            const [rawTx] = (parsed.params ?? []) as [string];
            observedRawTx = rawTx;
            result = `0x${'ab'.repeat(32)}`;
          } else if (parsed.method === 'eth_getBlockByNumber') {
            result = {
              baseFeePerGas: '0x3b9aca00',
              number: '0x1',
              hash: `0x${'00'.repeat(32)}`,
              timestamp: '0x60000000',
              gasLimit: '0x1c9c380',
              gasUsed: '0x0',
            };
          } else if (parsed.method === 'eth_estimateGas') {
            result = '0x5208';
          } else if (parsed.method === 'eth_getTransactionCount') {
            result = '0x0';
          } else if (parsed.method === 'eth_chainId') {
            result = '0x7a69';
          } else if (parsed.method === 'eth_maxPriorityFeePerGas') {
            result = '0x3b9aca00';
          } else {
            result = null;
          }
          const response = {
            jsonrpc: '2.0',
            id: parsed.id,
            result,
          };
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(response));
        });
      });

      await new Promise<void>((resolvePromise) => {
        rpcServer.listen(0, '127.0.0.1', () => resolvePromise());
      });
      const address = rpcServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to start test RPC server');
      }
      rpcUrl = `http://127.0.0.1:${String(address.port)}`;
      const allowedRpcHost = new URL(rpcUrl).hostname;

      await runOcap(['daemon', 'start']);
      const launchResponse = (await runOcapJson([
        'daemon',
        'exec',
        'launchSubcluster',
        JSON.stringify({
          config: makeWalletClusterConfig({
            bundleBaseUrl,
            allowedHosts: [allowedRpcHost],
          }),
        }),
      ])) as { rootKref?: string };
      if (!launchResponse.rootKref) {
        throw new Error('launchSubcluster did not return rootKref');
      }
      rootKref = launchResponse.rootKref;

      await callVat(rootKref, 'initializeKeyring', [{ type: 'throwaway' }]);
      await callVat(rootKref, 'configureProvider', [
        { chainId: 31337, rpcUrl },
      ]);

      tools = new Map<string, ToolDefinition>();
      register({
        pluginConfig: {
          ocapCliPath,
          walletKref: rootKref,
          timeoutMs: 30_000,
        },
        registerTool: (tool: ToolDefinition) => {
          tools.set(tool.name, tool);
        },
      });
    }, 60_000);

    afterAll(async () => {
      try {
        await runOcap(['daemon', 'stop']);
      } catch {
        // Ignore daemon stop failures during cleanup.
      }
      await new Promise<void>((resolvePromise) => {
        rpcServer.close(() => resolvePromise());
      });
      await rm(tempHome, { recursive: true, force: true });
    });

    it('decodes CapData response for wallet_accounts', async () => {
      const tool = tools.get('wallet_accounts');
      expect(tool).toBeDefined();
      const result = await tool!.execute('req-accounts', {});
      const accounts = JSON.parse(result.content[0]?.text ?? '[]') as string[];
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0]).toMatch(/^0x[\da-f]{40}$/iu);
    });

    it('returns decoded balance from wallet_balance', async () => {
      const accountsResult = await callVat(rootKref, 'getAccounts');
      const [address] = accountsResult as string[];
      const tool = tools.get('wallet_balance');
      expect(tool).toBeDefined();

      const result = await tool!.execute('req-balance', { address });

      expect(result.content[0]?.text).toContain('0x2a');
    });

    it('infers from and sends signed tx via wallet_send', async () => {
      const tool = tools.get('wallet_send');
      expect(tool).toBeDefined();

      const result = await tool!.execute('req-send', {
        to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        value: '0x1',
      });

      const text = result.content[0]?.text ?? '';
      expect(text).not.toContain('Error');
      expect(text).toMatch(/0x[\da-f]{64}/iu);
      expect(observedRawTx).toMatch(/^0x[\da-f]+$/iu);
      expect(observedRawTx?.length).toBeGreaterThan(10);
    });
  });
