/**
 * Test constants for E2E tests
 */
export const DEFAULT_MODEL = 'llama3.1:latest';
export const TEST_MODELS = ['llama3.1:latest', 'gpt-oss:20b'];

/**
 * Ollama API endpoints
 */
export const OLLAMA_API_BASE = 'http://localhost:11434';
export const OLLAMA_TAGS_ENDPOINT = `${OLLAMA_API_BASE}/api/tags`;

/**
 * Supported LMS providers for E2E tests.
 * Select with: LMS_PROVIDER=llama-cpp yarn test:e2e:local
 */
const LMS_PROVIDERS = {
  ollama: { baseUrl: OLLAMA_API_BASE, model: DEFAULT_MODEL },
  'llama-cpp': { baseUrl: 'http://localhost:8080', model: 'glm-4.7-flash' },
} as const;

export type LmsProvider = keyof typeof LMS_PROVIDERS;

// oxlint-disable-next-line node/no-process-env
const rawProvider = process?.env?.LMS_PROVIDER ?? 'ollama';
export const LMS_PROVIDER: LmsProvider =
  rawProvider in LMS_PROVIDERS ? (rawProvider as LmsProvider) : 'ollama';

export const LMS_BASE_URL = LMS_PROVIDERS[LMS_PROVIDER].baseUrl;
export const LMS_CHAT_MODEL = LMS_PROVIDERS[LMS_PROVIDER].model;

/**
 * Logger tags to ignore, parsed from the LOGGER_IGNORE environment variable.
 */
export const IGNORE_TAGS =
  // oxlint-disable-next-line node/no-process-env
  process?.env?.LOGGER_IGNORE?.split(',')?.map((tag) => tag.trim()) ?? [];
