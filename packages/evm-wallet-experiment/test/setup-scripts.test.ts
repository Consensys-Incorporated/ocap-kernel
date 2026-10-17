import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { makeWalletClusterConfig } from '../src/cluster-config.ts';

const HOME_SCRIPT = fileURLToPath(
  new URL('../scripts/setup-home.sh', import.meta.url),
);
const AWAY_SCRIPT = fileURLToPath(
  new URL('../scripts/setup-away.sh', import.meta.url),
);

/**
 * Extract the set of vat keys (and the bundle filename each uses) from the
 * embedded Node config blob inside a setup shell script. The scripts build
 * their cluster config via `CONFIG=$(node -e "...")`; the regex matches the
 * `<key>: { bundleSpec: bd + '/<bundle>.bundle'` pattern inside that blob.
 *
 * @param scriptText - The raw contents of a setup shell script.
 * @returns A mapping from vat key to bundle filename.
 */
function extractVatBundles(scriptText: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern =
    /([a-zA-Z][a-zA-Z0-9]*): \{\s*bundleSpec: bd \+ '\/([a-zA-Z-]+\.bundle)'/gu;
  for (const match of scriptText.matchAll(pattern)) {
    const [, vatKey, bundleName] = match;
    if (vatKey && bundleName) {
      result[vatKey] = bundleName;
    }
  }
  return result;
}

/**
 * Expected vat-key-to-bundle mapping for a given role, derived from the
 * canonical `makeWalletClusterConfig` so the scripts cannot drift silently.
 *
 * @param role - The subcluster role.
 * @returns A mapping from vat key to bundle filename.
 */
function canonicalVatBundles(role: 'home' | 'away'): Record<string, string> {
  const config = makeWalletClusterConfig({
    bundleBaseUrl: 'file:///stub',
    role,
  });
  const result: Record<string, string> = {};
  for (const [vatKey, vatConfig] of Object.entries(config.vats)) {
    const spec = (vatConfig as { bundleSpec: string }).bundleSpec;
    const bundleName = spec.split('/').pop();
    if (bundleName) {
      result[vatKey] = bundleName;
    }
  }
  return result;
}

describe('setup scripts match canonical cluster config', () => {
  it.each([
    { role: 'home' as const, scriptPath: HOME_SCRIPT },
    { role: 'away' as const, scriptPath: AWAY_SCRIPT },
  ])(
    '$role script wires the same vat keys and bundles as makeWalletClusterConfig',
    async ({ role, scriptPath }) => {
      const scriptText = await readFile(scriptPath, 'utf-8');
      expect(extractVatBundles(scriptText)).toStrictEqual(
        canonicalVatBundles(role),
      );
    },
  );

  it('neither script references the pre-rename delegation-vat bundle', async () => {
    for (const scriptPath of [HOME_SCRIPT, AWAY_SCRIPT]) {
      const scriptText = await readFile(scriptPath, 'utf-8');
      expect(scriptText).not.toContain('delegation-vat.bundle');
      expect(scriptText).not.toMatch(/delegation: \{/u);
    }
  });

  it.each([
    { vat: 'keyring', scriptPath: HOME_SCRIPT, role: 'home' },
    { vat: 'keyring', scriptPath: AWAY_SCRIPT, role: 'away' },
    { vat: 'delegator', scriptPath: HOME_SCRIPT, role: 'home' },
  ])(
    "$role script endows 'crypto' on the $vat vat",
    async ({ vat, scriptPath }) => {
      const scriptText = await readFile(scriptPath, 'utf-8');
      const block = new RegExp(`${vat}: \\{[\\s\\S]*?\\}`, 'u').exec(
        scriptText,
      );
      expect(block).not.toBeNull();
      expect(block![0]).toContain("'crypto'");
    },
  );

  it("away script does not endow 'crypto' on the redeemer vat", async () => {
    const scriptText = await readFile(AWAY_SCRIPT, 'utf-8');
    const redeemerBlock = /redeemer: \{[\s\S]*?\}/u.exec(scriptText);
    expect(redeemerBlock).not.toBeNull();
    expect(redeemerBlock![0]).not.toContain("'crypto'");
  });

  it.each([
    { role: 'home', scriptPath: HOME_SCRIPT },
    { role: 'away', scriptPath: AWAY_SCRIPT },
  ])('$role script grants the provider vat http', async ({ scriptPath }) => {
    const scriptText = await readFile(scriptPath, 'utf-8');
    const providerBlock = /provider: \{[\s\S]*?^\s{8}\},/mu.exec(scriptText);
    expect(providerBlock).not.toBeNull();
    expect(providerBlock![0]).toContain(
      "globals: ['URL', 'Request', 'Headers', 'Response']",
    );
    expect(providerBlock![0]).toContain('platformConfig: { http: { hosts } }');
  });
});
