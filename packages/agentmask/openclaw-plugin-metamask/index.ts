/**
 * OpenClaw MetaMask plugin: registers tools that let an LLM agent request
 * and use capabilities from a MetaMask capability vendor via the OCAP daemon.
 *
 * The vendor's public facet is accessed by redeeming an OCAP URL. The agent
 * can then request capabilities (e.g., PersonalMessageSigner) and call
 * methods on them (e.g., getAccounts, signMessage).
 *
 * Config (optional, in openclaw plugin settings or env vars):
 *   ocapCliPath   - Absolute path to the `ocap` CLI (auto-detected from monorepo)
 *   ocapUrl       - OCAP URL for the vendor public facet
 *   timeoutMs     - Daemon call timeout in ms (default: 60000)
 *   resetState    - Clear plugin state on register (default: false)
 */
import {
  boolean,
  exactOptional,
  number,
  object,
  string,
  validate,
} from '@metamask/superstruct';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDaemonCaller } from './daemon.ts';
import { createState } from './state.ts';
import { registerCallCapabilityTool } from './tools/call-capability.ts';
import { registerListCapabilitiesTool } from './tools/list-capabilities.ts';
import { registerObtainVendorTool } from './tools/obtain-vendor.ts';
import { registerRequestCapabilityTool } from './tools/request-capability.ts';
import type {
  OpenClawPluginApi,
  PluginConfigSchema,
  PluginEntry,
} from './types.ts';

const pluginDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = resolvePath(pluginDir, '../../kernel-cli/dist/app.js');
const DEFAULT_TIMEOUT_MS = 60_000;

const PluginConfigStruct = object({
  ocapCliPath: exactOptional(string()),
  ocapUrl: exactOptional(string()),
  timeoutMs: exactOptional(number()),
  resetState: exactOptional(boolean()),
});

const configSchema: PluginConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    const [error, validated] = validate(value, PluginConfigStruct);
    if (error) {
      return {
        success: false,
        error: {
          issues: error.failures().map((failure) => ({
            path: failure.path,
            message: failure.message,
          })),
        },
      };
    }
    return { success: true, data: validated };
  },
  jsonSchema: {
    type: 'object',
    properties: {
      ocapCliPath: {
        type: 'string',
        description:
          'Absolute path to the ocap CLI entry point (.js file or binary).',
      },
      ocapUrl: {
        type: 'string',
        description: 'OCAP URL for the vendor public facet.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout for daemon calls in ms (default: 60000).',
      },
      resetState: {
        type: 'boolean',
        description: 'Clear plugin state on each register() call.',
      },
    },
    additionalProperties: false,
  },
};

/**
 * Resolve a config value from plugin config and env var, with env taking precedence.
 *
 * @param options - Resolution options.
 * @param options.pluginValue - Value from plugin config.
 * @param options.envVar - Environment variable name.
 * @param options.parse - Optional parser for the env var string.
 * @returns The resolved value, or undefined.
 */
function resolveConfig<T>(options: {
  pluginValue: unknown;
  envVar: string;
  parse?: (value: string) => T;
}): T | undefined {
  // oxlint-disable-next-line node/no-process-env
  const envValue = process.env[options.envVar];
  if (envValue !== undefined && envValue !== '') {
    return options.parse ? options.parse(envValue) : (envValue as T);
  }
  return options.pluginValue as T | undefined;
}

/**
 * Register all MetaMask tools with the OpenClaw plugin API.
 *
 * @param api - The OpenClaw plugin API.
 */
function register(api: OpenClawPluginApi): void {
  const { pluginConfig } = api;

  const cliPath =
    (
      resolveConfig<string>({
        pluginValue: pluginConfig?.ocapCliPath,
        envVar: 'OCAP_CLI_PATH',
      }) ?? ''
    ).trim() || DEFAULT_CLI;

  const ocapUrl = (
    resolveConfig<string>({
      pluginValue: pluginConfig?.ocapUrl,
      envVar: 'OCAP_URL',
    }) ?? ''
  ).trim();

  const timeoutMs =
    resolveConfig<number>({
      pluginValue: pluginConfig?.timeoutMs,
      envVar: 'OCAP_TIMEOUT_MS',
      parse: Number,
    }) ?? DEFAULT_TIMEOUT_MS;

  const resetState =
    resolveConfig<boolean>({
      pluginValue: pluginConfig?.resetState,
      envVar: 'OCAP_RESET_STATE',
      parse: (value) => value.toLowerCase() === 'true',
    }) ?? false;

  const state = createState(ocapUrl);

  // resetState is implicit since state always starts fresh, but if explicitly
  // enabled it also logs for visibility.
  if (resetState) {
    // oxlint-disable-next-line no-console
    console.info('[metamask plugin] State reset enabled — starting clean.');
  }

  const daemon = makeDaemonCaller({ cliPath, timeoutMs });

  registerObtainVendorTool({ api, daemon, state });
  registerRequestCapabilityTool({ api, daemon, state });
  registerCallCapabilityTool({ api, daemon, state });
  registerListCapabilitiesTool({ api, state });
}

const entry: PluginEntry = {
  id: 'metamask',
  name: 'MetaMask (OCAP)',
  description:
    'Request and use wallet capabilities from a MetaMask capability vendor ' +
    'via the OCAP kernel daemon. Supports requesting capabilities, calling ' +
    'methods on them, and listing obtained capabilities.',
  configSchema,
  register,
};

export default entry;
