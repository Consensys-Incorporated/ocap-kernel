/* oxlint-disable node/no-sync, node/no-process-env */
/**
 * Configure OpenClaw for the away node container.
 *
 * Writes the complete openclaw.json, auth profiles, and workspace
 * directories in a single pass — no `openclaw` CLI calls needed.
 * This replaces the fragile sequence of `openclaw onboard` +
 * `openclaw config set` calls that broke on every OpenClaw release.
 *
 * Expects Docker Compose **models** + Docker Model Runner to inject:
 *   LLM_URL   — OpenAI-compatible API base (normalized to end with `/v1` below)
 *   LLM_MODEL — Model id for requests
 *
 * @see https://docs.docker.com/ai/compose/models-and-compose/
 *
 * Usage:
 *   node /app/packages/evm-wallet-experiment/docker/setup-openclaw.mjs
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { dockerConfig } from './docker-e2e-stack-constants.mjs';

const home = process.env.HOME || '/run/ocap/away';
const ocDir = resolve(home, '.openclaw');

const llmUrlRaw = process.env.LLM_URL;
const llmModel = process.env.LLM_MODEL;

if (!llmUrlRaw || !llmModel) {
  throw new Error(
    'openclaw-setup: LLM_URL and LLM_MODEL must be set. ' +
      'Use `docker-compose.yml` top-level `models:` + Docker Model Runner (Compose v2.38+).',
  );
}

/**
 * OpenClaw `openai-completions` expects a base URL whose paths resolve under `/v1/...`.
 *
 * @param {string} url - Injected model runner URL (may omit `/v1`).
 * @returns {string} Normalized base URL ending with `/v1` (no trailing slash after v1).
 */
function openAiCompletionsBaseUrl(url) {
  const trimmed = url.replace(/\/+$/u, '');
  if (trimmed.endsWith('/v1')) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

const llmBaseUrl = openAiCompletionsBaseUrl(llmUrlRaw);
/** DMR serves an OpenAI-shaped API alongside Ollama compatibility. */
const llmApiType = 'openai-completions';
const providerId = 'llm';
const pluginPath = dockerConfig.openclawPluginPathContainer;

// -- Directories (what `openclaw onboard` scaffolds) --
const dirs = [
  resolve(ocDir, 'workspace'),
  resolve(ocDir, 'agents/main/agent'),
  resolve(ocDir, 'agents/main/sessions'),
  resolve(ocDir, 'canvas'),
  resolve(ocDir, 'cron'),
  resolve(ocDir, 'extensions'),
];
for (const dir of dirs) {
  mkdirSync(dir, { recursive: true });
}

// -- Generate a gateway auth token --
const gatewayToken = randomBytes(24).toString('hex');

// -- Write openclaw.json (complete config, no patching) --
const config = {
  meta: {
    lastTouchedVersion: 'docker-setup',
    lastTouchedAt: new Date().toISOString(),
  },
  models: {
    mode: 'merge',
    providers: {
      [providerId]: {
        baseUrl: llmBaseUrl,
        api: llmApiType,
        models: [
          {
            id: llmModel,
            name: llmModel,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: `${providerId}/${llmModel}` },
      workspace: resolve(ocDir, 'workspace'),
      compaction: { mode: 'safeguard' },
    },
  },
  // Match non-Docker setup (`setup-away.sh` / setup guide): allow all tools from the wallet plugin.
  tools: {
    allow: ['wallet'],
  },
  commands: {
    native: 'auto',
    nativeSkills: 'auto',
    restart: true,
    ownerDisplay: 'raw',
  },
  session: { dmScope: 'per-channel-peer' },
  gateway: {
    port: 18789,
    mode: 'local',
    bind: 'loopback',
    auth: { mode: 'token', token: gatewayToken },
    tailscale: { mode: 'off', resetOnExit: false },
  },
  skills: { install: { nodeManager: 'npm' } },
  plugins: {
    allow: ['wallet'],
    load: { paths: [pluginPath] },
    entries: { wallet: { enabled: true } },
  },
};

const cfgPath = resolve(ocDir, 'openclaw.json');
writeFileSync(cfgPath, JSON.stringify(config, null, 2));
console.log(
  `[openclaw-setup] config written: ${providerId}/${llmModel} (api: ${llmApiType}, base: ${llmBaseUrl})`,
);

// -- Write auth profiles for the provider --
const authDir = resolve(ocDir, 'agents/main/agent');
const profiles = {
  version: 1,
  profiles: {
    [providerId]: {
      type: 'api_key',
      key: 'dummy',
      provider: providerId,
    },
  },
};
writeFileSync(
  resolve(authDir, 'auth-profiles.json'),
  JSON.stringify(profiles, null, 2),
);
console.log(`[openclaw-setup] auth profile written for: ${providerId}`);

// -- Verify plugin exists --
const pluginEntry = resolve(pluginPath, 'index.ts');
if (!existsSync(pluginEntry)) {
  console.error(
    `[openclaw-setup] WARN: plugin not found at ${pluginEntry} — wallet tools will not load`,
  );
}

console.log('[openclaw-setup] done');
