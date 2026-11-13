import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FormatConfig, Oxfmtrc } from 'oxfmt';

const OXFMT_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.oxfmtrc.json',
);

let oxfmtConfigPromise: Promise<FormatConfig> | undefined;

/**
 * Read the repo's root `.oxfmtrc.json` as options for oxfmt's `format()`. The
 * read is cached once it succeeds; a failed read is retried on the next call.
 *
 * @returns The format options.
 */
export async function loadOxfmtConfig(): Promise<FormatConfig> {
  oxfmtConfigPromise ??= readFile(OXFMT_CONFIG_PATH, 'utf8')
    .then((text) => {
      // Drop the keys that only matter to the CLI, which resolves the schema
      // and discovers files; `format()` receives a single file.
      const {
        $schema: _schema,
        ignorePatterns: _ignorePatterns,
        overrides: _overrides,
        associations: _associations,
        ...config
      } = JSON.parse(text) as Oxfmtrc & { $schema?: string };
      return config as FormatConfig;
    })
    .catch((error: unknown) => {
      oxfmtConfigPromise = undefined;
      throw error;
    });
  return oxfmtConfigPromise;
}
