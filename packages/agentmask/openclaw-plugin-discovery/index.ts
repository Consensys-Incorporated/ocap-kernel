/**
 * OpenClaw discovery plugin: lets an LLM agent find services via a
 * service matcher and consume them through the contact protocol.
 *
 * Config (optional, in openclaw plugin settings or env vars):
 *   ocapCliPath   - Absolute path to the `ocap` CLI (auto-detected from monorepo)
 *   matcherUrl    - OCAP URL for the service matcher
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
import { registerCallServiceTool } from './tools/call-service.ts';
import { registerFindServicesTool } from './tools/find-services.ts';
import { registerGetDescriptionTool } from './tools/get-description.ts';
import { registerInitiateContactTool } from './tools/initiate-contact.ts';
import { registerListTrackedTool } from './tools/list-tracked.ts';
import { registerRedeemMatcherTool } from './tools/redeem-matcher.ts';
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
  ocapHome: exactOptional(string()),
  matcherUrl: exactOptional(string()),
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
      ocapHome: {
        type: 'string',
        description:
          'OCAP home directory for the daemon this plugin should target. ' +
          'Passed as `--home` on every spawned `ocap` invocation. Default: ~/.ocap.',
      },
      matcherUrl: {
        type: 'string',
        description: 'OCAP URL for the service matcher.',
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
function resolveConfig<Type>(options: {
  pluginValue: unknown;
  envVar: string;
  parse?: (value: string) => Type;
}): Type | undefined {
  // oxlint-disable-next-line node/no-process-env
  const envValue = process.env[options.envVar];
  if (envValue !== undefined && envValue !== '') {
    return options.parse ? options.parse(envValue) : (envValue as Type);
  }
  return options.pluginValue as Type | undefined;
}

/**
 * Register all discovery tools with the OpenClaw plugin API.
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

  const ocapHome = (
    resolveConfig<string>({
      pluginValue: pluginConfig?.ocapHome,
      envVar: 'OCAP_HOME',
    }) ?? ''
  ).trim();

  const preconfiguredMatcherUrl = (
    resolveConfig<string>({
      pluginValue: pluginConfig?.matcherUrl,
      envVar: 'MATCHER_OCAP_URL',
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

  const state = createState();
  if (resetState) {
    // oxlint-disable-next-line no-console
    console.info('[discovery plugin] State reset enabled — starting clean.');
  }

  const daemon = makeDaemonCaller({
    cliPath,
    ocapHome: ocapHome || undefined,
    timeoutMs,
  });

  registerRedeemMatcherTool({ api, daemon, state });
  registerFindServicesTool({ api, daemon, state });
  registerGetDescriptionTool({ api, daemon, state });
  registerInitiateContactTool({ api, daemon, state });
  registerCallServiceTool({ api, daemon, state });
  registerListTrackedTool({ api, state });

  // If a matcher URL was supplied via config or env, eagerly redeem it
  // so the agent can start calling findServices without an extra step.
  // The pending promise is parked in `state.matcher` (as the `pending`
  // arm) so `requireMatcher` can await it if a tool call lands during
  // the window between `register()` returning and the redemption
  // settling.
  if (preconfiguredMatcherUrl) {
    const pending = daemon.redeemUrl(preconfiguredMatcherUrl).then((kref) => {
      const entry = { url: preconfiguredMatcherUrl, kref };
      state.matcher = { status: 'resolved', entry };
      // oxlint-disable-next-line no-console
      console.info(`[discovery plugin] Pre-redeemed matcher URL; kref=${kref}`);
      return entry;
    });
    state.matcher = { status: 'pending', promise: pending };
    // Attach a side-effect handler so a failure that nobody awaits does
    // not surface as an unhandled rejection. Do this on a chained
    // promise rather than on `pending` itself so `pending` stays
    // rejectable for any `requireMatcher` call that does await it.
    pending.catch((error: unknown) => {
      // Only revert to 'absent' if the slot is still 'pending' on this
      // promise — a subsequent manual redeem may have already moved it
      // forward.
      if (
        state.matcher.status === 'pending' &&
        state.matcher.promise === pending
      ) {
        state.matcher = { status: 'absent' };
      }
      // oxlint-disable-next-line no-console
      console.warn(
        '[discovery plugin] Failed to pre-redeem matcher URL:',
        error,
      );
    });
  }
}

const entry: PluginEntry = {
  id: 'discovery',
  name: 'Service Discovery',
  description:
    'Find and consume services via a service matcher plus the contact ' +
    'protocol defined in @metamask/service-discovery-types.',
  configSchema,
  register,
};

export default entry;
