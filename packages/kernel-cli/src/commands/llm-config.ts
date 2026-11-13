import {
  makeKernelLanguageModelService,
  makeOpenV1NodejsService,
} from '@metamask/kernel-language-model-service';
import type { KernelLanguageModelServiceOptions } from '@metamask/kernel-language-model-service';
import { stringify } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import type { Infer } from '@metamask/superstruct';
import {
  exactOptional,
  literal,
  object,
  string,
  validate,
} from '@metamask/superstruct';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Filename of the daemon's language model configuration, resolved
 * relative to the OCAP home directory.
 */
export const LLM_CONFIG_FILENAME = 'llm.json';

/**
 * Daemon language model configuration, read from `llm.json` in the OCAP
 * home directory. When present, the daemon registers a
 * `languageModelService` kernel service backed by the configured
 * provider, which subclusters can request by listing the service name
 * in their cluster config.
 *
 * The API key is deliberately indirected through an environment
 * variable or file so the token itself never lives in the config.
 */
export const LlmConfigStruct = object({
  /** The provider protocol. Only Open /v1-compatible endpoints for now. */
  provider: literal('open-v1'),
  /**
   * Base URL of the API (e.g. an openclaw gateway or api.openai.com), http or
   * https. A trailing slash is dropped.
   */
  baseUrl: string(),
  /** Name of an environment variable holding the API key. */
  apiKeyEnv: exactOptional(string()),
  /** Path of a file whose (trimmed) contents are the API key. Not with `apiKeyEnv`. */
  apiKeyFile: exactOptional(string()),
});

export type LlmConfig = Infer<typeof LlmConfigStruct>;

/**
 * Read and validate the LLM config from the OCAP home directory.
 *
 * A missing file means "no language model service" and returns
 * `undefined`; a present-but-invalid file throws so that a config typo
 * disables the daemon loudly rather than the service silently.
 *
 * @param ocapDir - The OCAP home directory.
 * @returns The validated config, or `undefined` if no config file exists.
 */
export async function readLlmConfig(
  ocapDir: string,
): Promise<LlmConfig | undefined> {
  const configPath = join(ocapDir, LLM_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  // The daemon logs these errors, so none of them repeats a value from the
  // file: the parser's and superstruct's own messages quote what they reject,
  // which may be an API key.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${configPath}`);
  }
  const invalid = (problem: string): Error =>
    new Error(`Invalid LLM config in ${configPath}: ${problem}`);
  const [error, config] = validate(parsed, LlmConfigStruct);
  if (error) {
    throw invalid(
      error
        .failures()
        .map(
          ({ path, type }) =>
            `${path.join('.') || '(root)'} ${type === 'never' ? 'is not allowed' : `must be ${type}`}`,
        )
        .join('; '),
    );
  }
  if (config.apiKeyEnv !== undefined && config.apiKeyFile !== undefined) {
    throw invalid('name only one of apiKeyEnv and apiKeyFile');
  }
  let protocol: string | undefined;
  try {
    ({ protocol } = new URL(config.baseUrl));
  } catch {
    // Not a URL; refused below.
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw invalid('baseUrl must be an http or https URL');
  }
  // The provider appends `/v1/...`, so a trailing slash would double it.
  return { ...config, baseUrl: config.baseUrl.replace(/\/+$/u, '') };
}

/**
 * Resolve the API key designated by the config, if any.
 *
 * @param config - The LLM config.
 * @returns The API key, or `undefined` when the config names none (for
 * gateways that don't require auth).
 * @throws If the config names an env var or file that is missing or empty.
 */
export async function resolveLlmApiKey(
  config: LlmConfig,
): Promise<string | undefined> {
  if (config.apiKeyEnv !== undefined) {
    const value = process.env[config.apiKeyEnv];
    if (!value) {
      throw new Error(
        `LLM config names env var "${config.apiKeyEnv}", but it is unset or empty`,
      );
    }
    return value;
  }
  if (config.apiKeyFile !== undefined) {
    const value = (await readFile(config.apiKeyFile, 'utf-8')).trim();
    if (!value) {
      throw new Error(`LLM config key file "${config.apiKeyFile}" is empty`);
    }
    return value;
  }
  return undefined;
}

/**
 * Build the `languageModelService` kernel service object for the
 * configured provider.
 *
 * @param config - The LLM config.
 * @param logger - Where failed calls are logged.
 * @returns A `{ name, service }` pair for
 * `kernel.registerKernelServiceObject(name, service)`.
 */
export async function makeLlmKernelService(
  config: LlmConfig,
  logger?: Pick<Logger, 'error'>,
): Promise<{ name: string; service: object }> {
  const apiKey = await resolveLlmApiKey(config);
  const { chat } = makeOpenV1NodejsService({
    endowments: { fetch: globalThis.fetch.bind(globalThis) },
    baseUrl: config.baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
  });
  // The calling vat sees only the top-level message, e.g. "fetch failed";
  // the cause that says why stays here.
  const loggedChat: KernelLanguageModelServiceOptions['chat'] = async (
    params,
  ) => {
    try {
      return await chat(params);
    } catch (error) {
      logger?.error('languageModelService chat failed', stringify(error, 0));
      throw error;
    }
  };
  return makeKernelLanguageModelService({ chat: loggedChat });
}
