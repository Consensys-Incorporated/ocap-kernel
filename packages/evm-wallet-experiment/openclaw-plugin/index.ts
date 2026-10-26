/**
 * OpenClaw wallet plugin: registers tools that forward to the OCAP daemon.
 *
 * The OCAP daemon runs the evm-wallet subcluster. This plugin sends JSON-RPC
 * messages to the daemon over its Unix socket, routing wallet operations
 * through the kernel's capability system. The AI agent never touches keys.
 *
 * Enable tools via tools.allow: ["wallet_balance", "wallet_send"]
 * or allow all with ["wallet"].
 *
 * Config (optional, in openclaw plugin settings):
 *   ocapCliPath  - Absolute path to the `ocap` CLI (auto-detected from monorepo)
 *   walletKref   - The kernel reference for the wallet coordinator (default: "ko4")
 */
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeWalletCaller } from './daemon.ts';
import { registerEthTools } from './tools/eth.ts';
import { registerMiscTools } from './tools/misc.ts';
import { registerSwapTools } from './tools/swap.ts';
import { registerTokenTools } from './tools/token.ts';
import type {
  OpenClawPluginApi,
  PluginConfigSchema,
  PluginEntry,
} from './types.ts';

const pluginDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = resolvePath(pluginDir, '../../kernel-cli/dist/app.js');
const DEFAULT_TIMEOUT_MS = 60_000;

const KNOWN_KEYS = new Set(['ocapCliPath', 'walletKref', 'timeoutMs']);

const configSchema: PluginConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        success: false,
        error: { issues: [{ path: [], message: 'expected config object' }] },
      };
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!KNOWN_KEYS.has(key)) {
        return {
          success: false,
          error: {
            issues: [{ path: [key], message: `unknown config key "${key}"` }],
          },
        };
      }
    }
    if ('ocapCliPath' in obj && typeof obj.ocapCliPath !== 'string') {
      return {
        success: false,
        error: {
          issues: [{ path: ['ocapCliPath'], message: 'must be a string' }],
        },
      };
    }
    if ('walletKref' in obj && typeof obj.walletKref !== 'string') {
      return {
        success: false,
        error: {
          issues: [{ path: ['walletKref'], message: 'must be a string' }],
        },
      };
    }
    if ('timeoutMs' in obj && typeof obj.timeoutMs !== 'number') {
      return {
        success: false,
        error: {
          issues: [{ path: ['timeoutMs'], message: 'must be a number' }],
        },
      };
    }
    return { success: true, data: value };
  },
  jsonSchema: {
    type: 'object',
    properties: {
      ocapCliPath: {
        type: 'string',
        description:
          'Absolute path to the ocap CLI entry point (.js file or binary).',
      },
      walletKref: {
        type: 'string',
        description: "Kernel reference of the wallet coordinator (e.g. 'ko4').",
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout for daemon calls in ms (default: 60000)',
      },
    },
    additionalProperties: false,
  },
};

/**
 * Register all wallet tools with the OpenClaw plugin API.
 *
 * @param api - The OpenClaw plugin API.
 */
function register(api: OpenClawPluginApi): void {
  const { pluginConfig } = api;
  const cliPath =
    typeof pluginConfig?.ocapCliPath === 'string'
      ? pluginConfig.ocapCliPath.trim()
      : DEFAULT_CLI;
  const walletKref =
    typeof pluginConfig?.walletKref === 'string'
      ? pluginConfig.walletKref.trim()
      : 'ko4';
  const timeoutMs =
    typeof pluginConfig?.timeoutMs === 'number'
      ? pluginConfig.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const wallet = makeWalletCaller({ cliPath, walletKref, timeoutMs });

  registerEthTools(api, wallet);
  registerTokenTools(api, wallet);
  registerSwapTools(api, wallet);
  registerMiscTools(api, wallet);
}

const entry: PluginEntry = {
  id: 'wallet',
  name: 'Wallet (OCAP)',
  description:
    'Ethereum wallet tools backed by the OCAP kernel daemon. ' +
    'Check balances, send transactions, resolve tokens, and sign messages ' +
    'without accessing private keys.',
  configSchema,
  register,
};

export { register };
export default entry;
