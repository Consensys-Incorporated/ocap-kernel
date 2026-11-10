import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

const importLoader = async () =>
  (await import('./oxfmt-config.ts')).loadOxfmtConfig;

describe('loadOxfmtConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(readFile).mockClear();
  });

  it('strips the keys that only matter to the CLI', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({
        $schema: './schema.json',
        printWidth: 80,
        singleQuote: true,
        ignorePatterns: ['dist/'],
        overrides: [],
        associations: {},
      }),
    );
    const loadOxfmtConfig = await importLoader();

    expect(await loadOxfmtConfig()).toStrictEqual({
      printWidth: 80,
      singleQuote: true,
    });
  });

  it('reads the root config file', async () => {
    const loadOxfmtConfig = await importLoader();

    expect(await loadOxfmtConfig()).toHaveProperty('singleQuote', true);
    expect(readFile).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]\.oxfmtrc\.json$/u),
      'utf8',
    );
  });

  it('reads the file once across calls', async () => {
    const loadOxfmtConfig = await importLoader();

    const [first, second] = await Promise.all([
      loadOxfmtConfig(),
      loadOxfmtConfig(),
    ]);

    expect(second).toBe(first);
    expect(await loadOxfmtConfig()).toBe(first);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed read', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('EACCES'));
    const loadOxfmtConfig = await importLoader();

    await expect(loadOxfmtConfig()).rejects.toThrow('EACCES');
    expect(await loadOxfmtConfig()).toHaveProperty('singleQuote', true);
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
