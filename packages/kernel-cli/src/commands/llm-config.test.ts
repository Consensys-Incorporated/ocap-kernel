import '@metamask/kernel-shims/endoify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import {
  LLM_CONFIG_FILENAME,
  makeLlmKernelService,
  readLlmConfig,
  resolveLlmApiKey,
} from './llm-config.ts';

describe('llm-config', () => {
  let ocapDir: string;

  beforeEach(async () => {
    ocapDir = await mkdtemp(join(tmpdir(), 'llm-config-test-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(ocapDir, { recursive: true, force: true });
  });

  /**
   * Write an `llm.json` into the test OCAP home.
   *
   * @param contents - The raw file contents.
   */
  async function writeConfig(contents: string): Promise<void> {
    await writeFile(join(ocapDir, LLM_CONFIG_FILENAME), contents);
  }

  describe('readLlmConfig', () => {
    it('returns undefined when no config file exists', async () => {
      expect(await readLlmConfig(ocapDir)).toBeUndefined();
    });

    it('returns the parsed config', async () => {
      await writeConfig(
        JSON.stringify({
          provider: 'open-v1',
          baseUrl: 'http://127.0.0.1:18789',
          apiKeyEnv: 'TEST_LLM_TOKEN',
        }),
      );
      expect(await readLlmConfig(ocapDir)).toStrictEqual({
        provider: 'open-v1',
        baseUrl: 'http://127.0.0.1:18789',
        apiKeyEnv: 'TEST_LLM_TOKEN',
      });
    });

    it('throws on invalid JSON', async () => {
      await writeConfig('{not json');
      await expect(readLlmConfig(ocapDir)).rejects.toThrow(/Invalid JSON/u);
    });

    it.each([
      [
        'an unknown provider',
        { provider: 'closed-v9', baseUrl: 'http://127.0.0.1:18789' },
      ],
      ['a missing baseUrl', { provider: 'open-v1' }],
      ['a baseUrl that is not a URL', { provider: 'open-v1', baseUrl: 'x' }],
      [
        'a baseUrl that is not http',
        { provider: 'open-v1', baseUrl: 'ftp://127.0.0.1' },
      ],
      [
        'both a key env var and a key file',
        {
          provider: 'open-v1',
          baseUrl: 'http://127.0.0.1:18789',
          apiKeyEnv: 'TEST_LLM_TOKEN',
          apiKeyFile: '/tmp/key',
        },
      ],
    ])('throws on %s', async (_case, config) => {
      await writeConfig(JSON.stringify(config));
      await expect(readLlmConfig(ocapDir)).rejects.toThrow(
        /Invalid LLM config/u,
      );
    });

    // The daemon logs these errors, so a key in the file must not reach them.
    it.each([
      [
        'an inline key',
        JSON.stringify({
          provider: 'open-v1',
          baseUrl: 'http://127.0.0.1:18789',
          apiKey: 'sk-secret-123',
        }),
      ],
      ['a file that is only a key', 'sk-secret-123'],
    ])('leaves the value out of the error for %s', async (_case, contents) => {
      await writeConfig(contents);
      const error = await readLlmConfig(ocapDir).catch((thrown) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain('sk-secret');
    });

    it.each([
      ['http://127.0.0.1:18789/', 'http://127.0.0.1:18789'],
      ['https://gateway.example/api//', 'https://gateway.example/api'],
    ])('drops the trailing slash from %s', async (baseUrl, expected) => {
      await writeConfig(JSON.stringify({ provider: 'open-v1', baseUrl }));
      expect(await readLlmConfig(ocapDir)).toStrictEqual({
        provider: 'open-v1',
        baseUrl: expected,
      });
    });
  });

  describe('resolveLlmApiKey', () => {
    it('reads the key from the named env var', async () => {
      vi.stubEnv('TEST_LLM_TOKEN', 'sekrit');
      expect(
        await resolveLlmApiKey({
          provider: 'open-v1',
          baseUrl: 'x',
          apiKeyEnv: 'TEST_LLM_TOKEN',
        }),
      ).toBe('sekrit');
    });

    it('throws when the named env var is unset', async () => {
      await expect(
        resolveLlmApiKey({
          provider: 'open-v1',
          baseUrl: 'x',
          apiKeyEnv: 'TEST_LLM_TOKEN_UNSET',
        }),
      ).rejects.toThrow(/unset or empty/u);
    });

    it('reads the key from the named file, trimmed', async () => {
      const keyPath = join(ocapDir, 'token.txt');
      await writeFile(keyPath, '  file-sekrit\n');
      expect(
        await resolveLlmApiKey({
          provider: 'open-v1',
          baseUrl: 'x',
          apiKeyFile: keyPath,
        }),
      ).toBe('file-sekrit');
    });

    it('throws when the named file is empty', async () => {
      const keyPath = join(ocapDir, 'token.txt');
      await writeFile(keyPath, '\n');
      await expect(
        resolveLlmApiKey({
          provider: 'open-v1',
          baseUrl: 'x',
          apiKeyFile: keyPath,
        }),
      ).rejects.toThrow(/is empty/u);
    });

    it('returns undefined when the config names no key source', async () => {
      expect(
        await resolveLlmApiKey({ provider: 'open-v1', baseUrl: 'x' }),
      ).toBeUndefined();
    });
  });

  describe('makeLlmKernelService', () => {
    it('builds a registrable languageModelService', async () => {
      vi.stubEnv('TEST_LLM_TOKEN', 'sekrit');
      const { name, service } = await makeLlmKernelService({
        provider: 'open-v1',
        baseUrl: 'http://127.0.0.1:18789',
        apiKeyEnv: 'TEST_LLM_TOKEN',
      });
      expect(name).toBe('languageModelService');
      expect(service).toHaveProperty('chat');
    });

    it('logs a failed chat with its cause before rethrowing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(
          new TypeError('fetch failed', {
            cause: new Error('connect ECONNREFUSED 127.0.0.1:18789'),
          }),
        ),
      );
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      const logger = { error: vi.fn() };
      const { service } = await makeLlmKernelService(
        { provider: 'open-v1', baseUrl: 'http://127.0.0.1:18789' },
        logger,
      );

      await expect(
        (service as { chat: (params: object) => Promise<unknown> }).chat({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toThrow('fetch failed');
      expect(logger.error).toHaveBeenCalledWith(
        'languageModelService chat failed',
        expect.stringContaining('connect ECONNREFUSED 127.0.0.1:18789'),
      );
    });
  });
});
