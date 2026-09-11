import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { kunser } from '@metamask/ocap-kernel';
import type { Kernel, KRef, VatConfig } from '@metamask/ocap-kernel';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getBundleSpec, makeKernel, makeTestLogger } from './utils.ts';

/**
 * Every case here is marked `it.fails`, which inverts the verdict: the case is
 * green while it fails and turns red once it passes. It ratchets work that lands
 * across several pull requests, and the comment on each case names the one that
 * removes its marker.
 *
 * A green `.fails` proves nothing. It passes if the case fails for any reason at
 * all — a typo, an unrelated throw, a vat that never launched — so what it buys
 * is a forcing function and visible progress, not coverage. Each assertion gets
 * its real scrutiny in the pull request that unmarks it.
 */

const V1_ROOT: KRef = 'ko4';

/**
 * Launch the narrowing vat, doing every step here so that a rejected config
 * fails inside the calling case rather than in a hook, which would error the
 * whole file and defeat the ratchet.
 *
 * @param platformConfig - Platform capabilities to grant the vat, if any.
 * @returns The running kernel.
 */
const launchNarrowingVat = async (
  platformConfig?: Record<string, unknown>,
): Promise<Kernel> => {
  const { logger } = makeTestLogger();
  const database = await makeSQLKernelDatabase({});
  const kernel = await makeKernel(database, true, logger);
  const vat: VatConfig = {
    bundleSpec: getBundleSpec('narrowed-fs-vat'),
    parameters: {},
  };
  if (platformConfig) {
    // The fs cases configure `fs` in shapes `PlatformConfig` does not describe
    // yet. The cast is what keeps this file typechecking while they are pending,
    // since `it.fails` cannot absorb a `tsc` failure.
    vat.platformConfig = platformConfig as NonNullable<
      VatConfig['platformConfig']
    >;
  }
  await kernel.launchSubcluster({ bootstrap: 'main', vats: { main: vat } });
  await waitUntilQuiescent();
  return kernel;
};

/**
 * Invoke one of the vat's probes.
 *
 * @param kernel - The kernel to send through.
 * @param method - The probe to invoke.
 * @param args - The probe's arguments.
 * @returns `ok:<result>` or `rejected:<message>`, per the vat.
 */
const probe = async (
  kernel: Kernel,
  method: string,
  args: unknown[],
): Promise<unknown> => kunser(await kernel.queueMessage(V1_ROOT, method, args));

/**
 * Create a readable file two directories deep, so that a narrowing of the
 * directory holding it is strictly narrower than the configured root.
 *
 * @returns Absolute segment arrays for the tree, and the file's byte length.
 */
const makeTempTree = async (): Promise<{
  dir: string;
  root: string[];
  inner: string[];
  file: string[];
  sibling: string[];
  size: number;
}> => {
  const contents = 'narrowed-fs\n';
  const dir = await mkdtemp(join(tmpdir(), 'narrowing-'));
  await mkdir(join(dir, 'inner'));
  await writeFile(join(dir, 'inner', 'hello.txt'), contents);
  await writeFile(join(dir, 'sibling.txt'), contents);
  const root = dir.split(sep).filter(Boolean);
  return {
    dir,
    root,
    inner: [...root, 'inner'],
    file: [...root, 'inner', 'hello.txt'],
    sibling: [...root, 'sibling.txt'],
    size: contents.length,
  };
};

describe('narrowing', () => {
  it('narrows a vat-local exo', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeNarrowed', ['read', ['srv', 'data', 'x']]),
    ).toBe('ok:read:srv/data/x');
  });

  it('rejects a call outside the narrowing', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeNarrowed', ['read', ['etc', 'passwd']]),
    ).toMatch(/^rejected:.*\bread\b/u);
  });

  it('drops methods absent from the delta', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeNarrowed', ['stat', ['srv', 'data', 'x']]),
    ).toMatch(/^rejected:.*\bstat\b/u);
  });

  it('joins two narrowings of a common base', async () => {
    const kernel = await launchNarrowingVat();
    expect(await probe(kernel, 'probeJoined', [['srv', 'logs', 'y']])).toBe(
      'ok:read:srv/logs/y',
    );
  });

  // Unmarks at PR-8, which synthesizes a guard for a `makeDefaultExo` base.
  it.fails('narrows a default-guarded exo', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeDefaultGuarded', [['srv', 'data', 'x']]),
    ).toBe('ok:loose:srv/data/x');
  });

  // Unmarks at PR-9c. The config here is in today's shape, so the vat launches
  // and the case fails on `fs` having no `readFile` method; 9c changes both the
  // capability and this config.
  it.fails('receives fs as an exo', async () => {
    const { dir, file, size } = await makeTempTree();
    const kernel = await launchNarrowingVat({
      fs: { rootDir: dir, promises: { readFile: true } },
    });
    expect(await probe(kernel, 'probeFs', [file])).toBe(`ok:${size}`);
  });

  // Unmarks at PR-10.
  it.fails('scopes fs by config', async () => {
    const { root, file, size } = await makeTempTree();
    const kernel = await launchNarrowingVat({
      fs: { root, methods: ['readFile'] },
    });
    expect(await probe(kernel, 'probeFs', [file])).toBe(`ok:${size}`);
    expect(await probe(kernel, 'probeFs', [['etc', 'passwd']])).toMatch(
      /^rejected:/u,
    );
  });

  // Unmarks at PR-10.
  it.fails('narrows the config-scoped fs further', async () => {
    const { root, inner, file, sibling, size } = await makeTempTree();
    const kernel = await launchNarrowingVat({
      fs: { root, methods: ['readFile'] },
    });
    expect(await probe(kernel, 'probeFsNarrowed', [inner, file])).toBe(
      `ok:${size}`,
    );
    expect(await probe(kernel, 'probeFsNarrowed', [inner, sibling])).toMatch(
      /^rejected:/u,
    );
  });
});
