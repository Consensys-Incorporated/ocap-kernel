import { access } from 'node:fs/promises';
import type { OxlintConfig } from 'oxlint';
import { describe, expect, it } from 'vitest';

import * as indexModule from './index.ts';
import plugin from './plugins/ocap-plugin.ts';

const layers: Record<string, OxlintConfig> = {
  base: indexModule.base,
  nodejs: indexModule.nodejs,
  typescript: indexModule.typescript,
  vitest: indexModule.vitest,
};

/**
 * @param layer - A config layer.
 * @returns The names of the rules the layer and its overrides configure.
 */
const getRuleNames = (layer: OxlintConfig): string[] => [
  ...Object.keys(layer.rules ?? {}),
  ...(layer.overrides ?? []).flatMap((override) =>
    Object.keys(override.rules ?? {}),
  ),
];

describe('index', () => {
  it('has the expected exports', () => {
    expect(Object.keys(indexModule).sort()).toStrictEqual([
      'base',
      'baseEnv',
      'nodejs',
      'nodejsEnv',
      'ocapPlugin',
      'typescript',
      'typescriptFiles',
      'vitest',
      'vitestFiles',
    ]);
  });

  it('references JS plugin paths that exist', async () => {
    const jsPlugins = Object.values(layers).flatMap((layer) =>
      (layer.jsPlugins ?? []).map((entry) =>
        typeof entry === 'string' ? entry : entry.specifier,
      ),
    );

    expect(jsPlugins).toContain(indexModule.ocapPlugin);
    for (const jsPlugin of jsPlugins) {
      expect(await access(jsPlugin)).toBeUndefined();
    }
  });

  it.each(Object.entries(layers))(
    'configures only existing ocap rules in the %s layer',
    (_name, layer) => {
      const ocapRules = getRuleNames(layer)
        .filter((name) => name.startsWith('ocap/'))
        .map((name) => name.slice('ocap/'.length));

      expect(Object.keys(plugin.rules)).toStrictEqual(
        expect.arrayContaining(ocapRules),
      );
    },
  );
});
